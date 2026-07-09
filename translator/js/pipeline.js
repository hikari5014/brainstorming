// Pipeline：所有模式共用的一顆引擎。
// 音訊來源（麥克風/分頁/影片元素）→ VAD 閘門 → 半雙工閘門 → 1..2 條 Live session → 事件流
//
// 半雙工閘門（gateDuringPlayback）：口譯語音播放期間暫停送音並緩衝（最多 GATE_BUFFER_MAX
// 個 chunks），播畢立刻補送。用來防止伺服器把我們播的口譯聲當成「有人插話」而
// 中斷生成（對話模式語音講到一半被砍掉的主因）。
//
// 自動壓低音量（ducking）：口譯播放時把來源的 duckGain 降到 DUCK_LEVEL（影片模式、
// 會議模式代播都適用），播畢平滑恢復。
//
// 對外事件：
//   'status'        {state, tag}
//   'transcription' {tag, kind, text, languageCode}
//   'level'         {rms, voiced}
//   'standby'       {on}
//   'fatal'         {reason}

import { AudioCapture } from './audio/capture.js';
import { AudioPlayback } from './audio/playback.js';
import { VadGate } from './audio/vad.js';
import { LiveSession } from './live/client.js';
import { MockSession } from './live/mock.js';
import { ENGINES } from './settings.js';

const GATE_BUFFER_MAX = 45; // ~4.5 秒
const DUCK_LEVEL = 0.12;

export class Pipeline extends EventTarget {
  constructor({ settings, usage }) {
    super();
    this.settings = settings;
    this.usage = usage;
    this.capture = null;
    this.playback = new AudioPlayback();
    this.playback.onSeconds = (sec) => this.usage?.addRecv(sec);
    this.sessions = [];
    this.vad = null;
    this.running = false;
    this.standby = false;
    this.lastVoiceAt = Date.now();
    this.idleTimer = null;
    this.ticker = null;
    this.sourceType = 'mic';
    this.targets = [];
    this.voiceOn = true;
    this.gateDuringPlayback = false;
    this.duckEnabled = true;
    this.gateBuffer = [];
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setVoiceOutput(on) {
    this.voiceOn = on;
    this.playback.setMuted(!on);
  }

  get gating() {
    return this.gateDuringPlayback && this.voiceOn && this.playback.isSpeaking;
  }

  makeSession({ code, echo, tag }) {
    const s = this.settings;
    const useMock = s.demoMode || !s.apiKey?.trim();
    const engineDef = ENGINES[s.engine] || ENGINES.translate;
    const session = useMock
      ? new MockSession({ target: code, tag })
      : new LiveSession({
          apiKey: s.apiKey.trim(),
          engine: engineDef.id,
          model: engineDef.model,
          target: code,
          echoTargetLanguage: echo,
          tag,
        });

    session.addEventListener('status', (e) => this.emit('status', e.detail));
    session.addEventListener('input-transcription', (e) =>
      this.emit('transcription', { ...e.detail, kind: 'input' })
    );
    session.addEventListener('output-transcription', (e) =>
      this.emit('transcription', { ...e.detail, kind: 'output' })
    );
    session.addEventListener('turn-complete', (e) => this.emit('turn-complete', e.detail));
    session.addEventListener('audio', (e) => this.playback.enqueueBase64(e.detail.base64));
    session.addEventListener('interrupted', () => {
      // 半雙工閘門開啟時理論上不會發生；發生時仍照 barge-in 語意清空佇列
      if (!this.gateDuringPlayback) this.playback.flush();
    });
    session.addEventListener('fatal', (e) => {
      this.emit('fatal', e.detail);
      this.stop();
    });
    return session;
  }

  // options: {sourceType, targets, voiceOutput, audioProcessing, gateDuringPlayback, duckEnabled, externalSource}
  async start(options) {
    if (this.running) await this.stop();
    const {
      sourceType, targets, voiceOutput,
      audioProcessing = 'voice',
      gateDuringPlayback = false,
      duckEnabled = true,
      externalSource = null,
    } = options;
    this.sourceType = sourceType;
    this.targets = targets;
    this.running = true;
    this.standby = false;
    this.gateDuringPlayback = gateDuringPlayback;
    this.duckEnabled = duckEnabled;
    this.gateBuffer = [];
    this.setVoiceOutput(voiceOutput);

    const s = this.settings;
    this.vad = new VadGate({
      threshold: s.vadThreshold,
      hangoverMs: s.vadHangoverMs,
      enabled: s.vadEnabled,
    });
    this.vad.onVoiceStart = () => this.onVoiceStart();

    this.sessions = targets.map((t) => this.makeSession(t));
    for (const sess of this.sessions) sess.connect();

    this.capture = new AudioCapture({
      source: externalSource || sourceType,
      processing: audioProcessing,
      onChunk: (chunk) => this.onChunk(chunk),
      onEnded: () => {
        this.emit('fatal', { reason: 'SOURCE_ENDED' });
        this.stop();
      },
    });
    try {
      await this.capture.start();
    } catch (err) {
      this.running = false;
      await this.teardown();
      throw err;
    }
    this.armIdleTimer();
    this.startTicker();
  }

  onChunk(chunk) {
    if (!this.running) return;
    this.emit('level', { rms: chunk.rms, voiced: this.vad?.voiced ?? true });
    if (this.standby) {
      this.vad.feed(chunk);
      return;
    }
    if (this.gating) {
      this.gateBuffer.push(chunk);
      if (this.gateBuffer.length > GATE_BUFFER_MAX) this.gateBuffer.shift();
      return;
    }
    this.forward(chunk);
  }

  forward(chunk) {
    const outs = this.vad.feed(chunk);
    if (outs.length === 0) {
      this.usage?.addSaved((chunk.int16.length / 16000) * this.sessions.length);
      return;
    }
    this.lastVoiceAt = Date.now();
    for (const int16 of outs) {
      for (const sess of this.sessions) {
        if (sess.sendAudio(int16)) this.usage?.addSent(int16.length / 16000);
      }
    }
  }

  // 每 150ms：處理 ducking 恢復/壓低 + 閘門解除時補送緩衝
  startTicker() {
    clearInterval(this.ticker);
    this.ticker = setInterval(() => {
      if (!this.running) return;
      const speaking = this.voiceOn && this.playback.isSpeaking;

      const duckGain = this.capture?.duckGain;
      if (duckGain) {
        const target = speaking && this.duckEnabled ? DUCK_LEVEL : 1;
        const ctx = this.capture.ctx;
        if (ctx) duckGain.gain.setTargetAtTime(target, ctx.currentTime, 0.1);
      }

      if (!this.gating && this.gateBuffer.length > 0) {
        const buffered = this.gateBuffer;
        this.gateBuffer = [];
        for (const chunk of buffered) this.forward(chunk);
      }
    }, 150);
  }

  onVoiceStart() {
    this.lastVoiceAt = Date.now();
    if (this.standby) this.wake();
  }

  armIdleTimer() {
    clearInterval(this.idleTimer);
    const min = this.settings.idleDisconnectMin;
    if (!min || min <= 0) return;
    this.idleTimer = setInterval(() => {
      if (!this.running || this.standby) return;
      if (Date.now() - this.lastVoiceAt > min * 60_000 && !this.playback.isSpeaking) {
        this.enterStandby();
      }
    }, 5000);
  }

  enterStandby() {
    this.standby = true;
    for (const sess of this.sessions) sess.close();
    this.sessions = [];
    this.emit('standby', { on: true });
  }

  wake() {
    if (!this.standby) return;
    this.standby = false;
    this.sessions = this.targets.map((t) => this.makeSession(t));
    for (const sess of this.sessions) sess.connect();
    this.emit('standby', { on: false });
  }

  async teardown() {
    clearInterval(this.idleTimer);
    clearInterval(this.ticker);
    // 停止前把 duckGain 恢復原音量
    const duckGain = this.capture?.duckGain;
    const ctx = this.capture?.ctx;
    if (duckGain && ctx) duckGain.gain.setTargetAtTime(1, ctx.currentTime, 0.05);
    for (const sess of this.sessions) sess.close();
    this.sessions = [];
    if (this.capture) {
      await this.capture.stop();
      this.capture = null;
    }
    this.playback.flush();
    this.gateBuffer = [];
  }

  async stop() {
    if (!this.running && this.sessions.length === 0 && !this.capture) return;
    this.running = false;
    this.standby = false;
    await this.teardown();
    this.emit('status', { state: 'closed', tag: '*' });
  }
}

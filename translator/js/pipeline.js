// Pipeline：四種模式共用的一顆引擎。
// 音訊來源（麥克風/分頁）→ VAD 閘門 → 1..2 條 Live session → 事件流
// 對外事件：
//   'status'        {state, tag}          連線狀態
//   'transcription' {tag, kind, text, languageCode}   kind: 'input' | 'output'
//   'level'         {rms, voiced}
//   'standby'       {on}                  靜音自動斷線省額度
//   'fatal'         {reason}

import { AudioCapture } from './audio/capture.js';
import { AudioPlayback } from './audio/playback.js';
import { VadGate } from './audio/vad.js';
import { LiveSession } from './live/client.js';
import { MockSession } from './live/mock.js';
import { ENGINES } from './settings.js';

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
    this.sourceType = 'mic';
    this.targets = [];
    this.voiceOn = true;
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setVoiceOutput(on) {
    this.voiceOn = on;
    this.playback.setMuted(!on);
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
    session.addEventListener('interrupted', () => this.playback.flush());
    session.addEventListener('fatal', (e) => {
      this.emit('fatal', e.detail);
      this.stop();
    });
    return session;
  }

  // targets: [{code, echo, tag}]；sourceType: 'mic' | 'display'
  async start({ sourceType, targets, voiceOutput }) {
    if (this.running) await this.stop();
    this.sourceType = sourceType;
    this.targets = targets;
    this.running = true;
    this.standby = false;
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
      source: sourceType,
      onChunk: (chunk) => this.onChunk(chunk),
      onEnded: () => {
        // 使用者停止分享分頁 → 結束
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
  }

  onChunk(chunk) {
    if (!this.running) return;
    this.emit('level', { rms: chunk.rms, voiced: this.vad?.voiced ?? true });
    if (this.standby) {
      // 待機中：只跑 VAD，偵測到人聲時 onVoiceStart 會喚醒
      this.vad.feed(chunk);
      return;
    }
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
    for (const sess of this.sessions) sess.close();
    this.sessions = [];
    if (this.capture) {
      await this.capture.stop();
      this.capture = null;
    }
    this.playback.flush();
  }

  async stop() {
    if (!this.running && this.sessions.length === 0 && !this.capture) return;
    this.running = false;
    this.standby = false;
    await this.teardown();
    this.emit('status', { state: 'closed', tag: '*' });
  }
}

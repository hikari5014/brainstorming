// Pipeline：所有模式共用的一顆引擎。
// 音訊來源（麥克風/分頁/影片元素）→ VAD 閘門 → 半雙工閘門 → 1..2 條 Live session → 事件流
//
// 半雙工閘門：口譯語音播放期間（含尾端 SPEAK_TAIL_MS）把麥克風輸入「直接丟棄」。
// 丟棄而非緩衝——手機喇叭播的口譯聲會被麥克風收回去，補送等於把自己的翻譯
// 再餵回引擎，造成翻譯迴圈；也防止伺服器把口譯聲當「插話」而中斷生成。
// 只在來源是麥克風時啟用（影片/會議模式的來源不是麥克風，不會迴授）。
//
// 交替口譯（holdVoice）：口譯語音先暫存，VAD 偵測到說話者停頓（holdReleaseMs 可調）
// 才開始播。播的時候對方已不在說話 → 不搶話、迴授機率更低。
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

const SPEAK_TAIL_MS = 400; // 播畢後再丟棄這麼久的輸入（喇叭殘響/迴音尾巴）
const HOLD_MAX_SEC = 45; // 交替口譯暫存上限，超過強制開播
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
    this.speakTailUntil = 0;
    this.holdVoice = false;
    this.holdReleaseMs = 1000;
    this.releaseTimer = null;
    this.audioCtx = null; // 收音 + 口譯播放共用（iOS 穩定性）
    this.ownsAudioCtx = false;
    this._onVisibility = () => {
      if (this.running && this.audioCtx?.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }
    };
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setVoiceOutput(on) {
    this.voiceOn = on;
    this.playback.setMuted(!on);
    this.playback.holdMode = this.holdVoice && on;
  }

  get gating() {
    if (!this.gateDuringPlayback || !this.voiceOn) return false;
    if (this.playback.isSpeaking) {
      this.speakTailUntil = Date.now() + SPEAK_TAIL_MS;
      return true;
    }
    return Date.now() < this.speakTailUntil;
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
    session.addEventListener('turn-complete', (e) => {
      this.emit('turn-complete', e.detail);
      // VAD 關閉時退而求其次：用伺服器的回合結束訊號觸發交替口譯開播
      if (!this.settings.vadEnabled) this.scheduleRelease();
    });
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
    const s = this.settings;
    this.sourceType = sourceType;
    this.targets = targets;
    this.running = true;
    this.standby = false;
    // 只有麥克風來源需要防迴授閘門（影片/會議來源與喇叭無迴路）
    this.gateDuringPlayback = gateDuringPlayback && sourceType === 'mic';
    this.duckEnabled = duckEnabled;
    this.speakTailUntil = 0;
    this.holdVoice = Boolean(s.holdVoice);
    this.holdReleaseMs = Math.round((s.holdReleaseSec ?? 1) * 1000);
    this.setVoiceOutput(voiceOutput);

    this.vad = new VadGate({
      threshold: s.vadThreshold,
      hangoverMs: s.vadHangoverMs,
      enabled: s.vadEnabled,
    });
    this.vad.onVoiceStart = () => this.onVoiceStart();
    this.vad.onVoiceEnd = () => this.scheduleRelease();

    // 收音與口譯播放共用同一個 AudioContext（iOS 兩個 context 會互相暫停）。
    // 影片模式沿用 videoSource 的 context，其餘模式自建一個（由 start 的使用者手勢啟用）。
    if (externalSource?.context) {
      this.audioCtx = externalSource.context;
      this.ownsAudioCtx = false;
    } else {
      this.audioCtx = new AudioContext();
      this.ownsAudioCtx = true;
    }
    await this.audioCtx.resume().catch(() => {});
    this.playback.attach(this.audioCtx);
    document.addEventListener('visibilitychange', this._onVisibility);

    this.sessions = targets.map((t) => this.makeSession(t));
    for (const sess of this.sessions) sess.connect();

    this.capture = new AudioCapture({
      source: externalSource || sourceType,
      processing: audioProcessing,
      context: this.audioCtx,
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
      // 播放口譯期間的麥克風輸入＝喇叭迴授，直接丟棄（計入省下的量）
      this.usage?.addSaved((chunk.int16.length / 16000) * this.sessions.length);
      return;
    }
    this.forward(chunk);
  }

  onVoiceStart() {
    this.lastVoiceAt = Date.now();
    // 對方又開口了 → 取消預定的交替口譯開播，繼續暫存
    clearTimeout(this.releaseTimer);
    if (this.standby) this.wake();
  }

  scheduleRelease() {
    if (!this.holdVoice) return;
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      if (this.running) this.playback.release();
    }, this.holdReleaseMs);
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

      // iOS 保活看門狗：context 一被系統暫停就立刻喚醒，
      // 否則口譯語音會播到一半凍結、且防迴授閘門會卡死。
      if (this.audioCtx && this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      const speaking = this.voiceOn && this.playback.isSpeaking;

      const duckGain = this.capture?.duckGain;
      if (duckGain && this.audioCtx) {
        const target = speaking && this.duckEnabled ? DUCK_LEVEL : 1;
        duckGain.gain.setTargetAtTime(target, this.audioCtx.currentTime, 0.1);
      }

      // 交替口譯保險絲：暫存太長就強制開播，避免無限累積
      if (this.holdVoice && this.playback.pendingSeconds > HOLD_MAX_SEC) {
        this.playback.release();
      }
    }, 150);
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
    clearTimeout(this.releaseTimer);
    document.removeEventListener('visibilitychange', this._onVisibility);
    // 停止前把 duckGain 恢復原音量
    const duckGain = this.capture?.duckGain;
    if (duckGain && this.audioCtx) duckGain.gain.setTargetAtTime(1, this.audioCtx.currentTime, 0.05);
    for (const sess of this.sessions) sess.close();
    this.sessions = [];
    if (this.capture) {
      await this.capture.stop();
      this.capture = null;
    }
    this.playback.detach();
    // 自建的 context 才關閉；影片模式的 context 屬於 videoSource
    if (this.ownsAudioCtx && this.audioCtx) {
      await this.audioCtx.close().catch(() => {});
    }
    this.audioCtx = null;
    this.ownsAudioCtx = false;
  }

  async stop() {
    if (!this.running && this.sessions.length === 0 && !this.capture) return;
    this.running = false;
    this.standby = false;
    await this.teardown();
    this.emit('status', { state: 'closed', tag: '*' });
  }
}

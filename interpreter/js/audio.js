// 音訊引擎 —— 上一代 app 在 iOS 上翻車的完整教訓都封裝在這裡：
//
// 1. 【單一 AudioContext】收音與播放共用同一個 context。iOS 對「兩個 context
//    同時做麥克風＋播放」會暫停其中一個，造成語音凍結。這裡從第一天就只有一個。
// 2. 【使用者手勢建立 + 保活看門狗】context 在第一次按鈕手勢中建立；
//    每 200ms 與 visibilitychange 檢查，一被系統 suspend 就立刻 resume。
// 3. 【真實時鐘判斷播放中】isSpeaking 用 performance.now，音訊時鐘被凍結
//    也不會誤判，狀態機永遠不卡死。
// 4. 【麥克風全程開啟】iOS 在「錄音+播放」音訊類別下不受靜音鍵影響，
//    且免去反覆要權限；要不要把聲音送出去由狀態機決定，不開關 mic。

const OUTPUT_RATE = 24000;
const LEAD = 0.06;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.workletNode = null;
    this.onChunk = null; // ({int16, rms})
    this.onMicLost = null;
    this.cursor = 0;
    this.speakUntil = 0; // performance.now ms
    this.sources = new Set();
    this.watchdog = null;
    this._onVisibility = () => this.kick();
  }

  get ready() {
    return Boolean(this.ctx && this.workletNode);
  }

  // 必須在使用者手勢中第一次呼叫（iOS 才允許啟動音訊）
  async start() {
    if (this.ready) { this.kick(); return; }
    this.ctx = new AudioContext();
    await this.ctx.resume().catch(() => {});

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    for (const t of this.stream.getAudioTracks()) {
      t.addEventListener('ended', () => this.onMicLost?.());
    }

    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    this.workletNode = new AudioWorkletNode(this.ctx, 'capture-processor', {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    this.workletNode.port.onmessage = (e) => {
      this.onChunk?.({ int16: new Int16Array(e.data.pcm), rms: e.data.rms });
    };
    this.ctx.createMediaStreamSource(this.stream).connect(this.workletNode);

    document.addEventListener('visibilitychange', this._onVisibility);
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.kick(), 200);
  }

  kick() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  // 沒按住時把 mic track 靜音（第二道防線：就算 UI 狀態出錯也錄不到東西）
  setMicEnabled(on) {
    if (!this.stream) return;
    for (const t of this.stream.getAudioTracks()) t.enabled = on;
  }

  // base64 24kHz PCM16 → 排入播放佇列，回傳這段音訊秒數
  playBase64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    if (int16.length === 0 || !this.ctx) return 0;

    const buf = this.ctx.createBuffer(1, int16.length, OUTPUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 0x8000;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime + LEAD, this.cursor);
    src.start(startAt);
    this.cursor = startAt + buf.duration;
    this.speakUntil = performance.now() + Math.max(0, this.cursor - this.ctx.currentTime) * 1000;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    return buf.duration;
  }

  // 對方按下按鈕搶話 → 立刻停掉還沒播完的譯文
  stopPlayback() {
    for (const src of this.sources) {
      try { src.stop(); } catch { /* stopped */ }
    }
    this.sources.clear();
    this.cursor = 0;
    this.speakUntil = 0;
  }

  get isSpeaking() {
    return performance.now() < this.speakUntil - 20;
  }

  async close() {
    clearInterval(this.watchdog);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.stopPlayback();
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

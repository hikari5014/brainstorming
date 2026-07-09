// 譯文語音播放：24kHz PCM16 chunks 排進時間軸連續播放。
//
// 共用 context：播放用的 AudioContext 由 pipeline 傳入（attach），與麥克風收音共用
// 同一個 context —— iOS 上「同時開麥克風 + 另一個 context 播放」會導致系統暫停其中
// 一個，造成口譯語音播到一半凍結。共用一個 context 可避免這個衝突。
//
// isSpeaking 用「真實時鐘」（performance.now）而非音訊時鐘判斷：context 一旦被 iOS
// 暫停，音訊時鐘會凍結，若用音訊時鐘判斷會永遠卡在「還在播」而讓防迴授閘門永久
// 丟棄麥克風輸入（症狀：最後完全不收聲音）。真實時鐘永遠前進，閘門不會卡死。
//
// holdMode（交替口譯）：收到的語音先進 pending 佇列，等 release() 才開始播。

const OUTPUT_RATE = 24000;
const LEAD = 0.06;

export class AudioPlayback {
  constructor() {
    this.ctx = null;
    this.owns = false;
    this.cursor = 0; // 下一個 chunk 的排程時間（context 時鐘）
    this.speakUntil = 0; // 播放結束的真實時鐘時間（performance.now ms）
    this.sources = new Set();
    this.muted = false;
    this.holdMode = false;
    this.pending = []; // Int16Array[]
    this.onSeconds = null; // 用量統計 callback
  }

  // pipeline 傳入共用 context
  attach(ctx) {
    this.ctx = ctx;
    this.owns = false;
    this.cursor = 0;
    this.speakUntil = 0;
  }

  detach() {
    this.flush();
    this.ctx = null;
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.owns = true;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // base64 PCM16 → 播放或暫存
  async enqueueBase64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const int16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    if (int16.length === 0) return;
    this.onSeconds?.(int16.length / OUTPUT_RATE);

    if (this.holdMode) {
      this.pending.push(int16);
      return;
    }
    await this.scheduleInt16(int16);
  }

  async scheduleInt16(int16) {
    const ctx = await this.ensureContext();
    // 24kHz buffer 在硬體取樣率的 context 中播放，由瀏覽器自動重取樣
    const buf = ctx.createBuffer(1, int16.length, OUTPUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 0x8000;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = this.muted ? 0 : 1;
    src.connect(gain).connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime + LEAD, this.cursor);
    src.start(startAt);
    this.cursor = startAt + buf.duration;
    // 真實時鐘結束時間 = 現在 + 佇列剩餘的 context 秒數
    const remainingMs = Math.max(0, this.cursor - ctx.currentTime) * 1000;
    this.speakUntil = performance.now() + remainingMs;

    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  // 交替口譯：把暫存的語音一次排進播放佇列
  async release() {
    const held = this.pending;
    this.pending = [];
    for (const int16 of held) await this.scheduleInt16(int16);
  }

  get pendingSeconds() {
    return this.pending.reduce((s, a) => s + a.length, 0) / OUTPUT_RATE;
  }

  setMuted(muted) {
    this.muted = muted;
    if (muted) this.flush();
  }

  // barge-in / 模式切換：立刻停掉還沒播完的音與暫存
  flush() {
    for (const src of this.sources) {
      try { src.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.pending = [];
    this.cursor = 0;
    this.speakUntil = 0;
  }

  // 真實時鐘判斷；暫存中（尚未開播）不算 speaking
  get isSpeaking() {
    if (this.pending.length) return false;
    return performance.now() < this.speakUntil - 20;
  }

  async close() {
    this.flush();
    if (this.ctx && this.owns) {
      await this.ctx.close().catch(() => {});
    }
    this.ctx = null;
  }
}

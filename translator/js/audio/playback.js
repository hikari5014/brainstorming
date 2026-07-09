// 譯文語音播放：24kHz PCM16 chunks 排進時間軸連續播放。
// holdMode（交替口譯）：收到的語音先進 pending 佇列，等 release()（對方說完停頓後）
// 才開始播，避免同步口譯搶話與手機喇叭→麥克風的迴授迴圈。

const OUTPUT_RATE = 24000;

export class AudioPlayback {
  constructor() {
    this.ctx = null;
    this.cursor = 0; // 下一個 chunk 的排程時間
    this.sources = new Set();
    this.muted = false;
    this.holdMode = false;
    this.pending = []; // Int16Array[]
    this.onSeconds = null; // 用量統計 callback（實際收到的音訊秒數，靜音/暫存也計）
  }

  async ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: OUTPUT_RATE });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
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
    await this.ensureContext();
    const buf = this.ctx.createBuffer(1, int16.length, OUTPUT_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 0x8000;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = this.muted ? 0 : 1;
    src.connect(gain).connect(this.ctx.destination);

    const startAt = Math.max(this.ctx.currentTime + 0.04, this.cursor);
    src.start(startAt);
    this.cursor = startAt + buf.duration;
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
  }

  get isSpeaking() {
    return this.ctx ? this.cursor > this.ctx.currentTime + 0.05 : false;
  }

  async close() {
    this.flush();
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}

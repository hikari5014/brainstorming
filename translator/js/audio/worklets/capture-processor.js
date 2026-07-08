// 在音訊執行緒把麥克風/分頁音訊重取樣成 16kHz PCM16，
// 每 100ms（1600 samples）連同 RMS 一起丟回主執行緒。

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms @ 16kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.readPos = 0; // 相對於 tail 的小數讀取位置
    this.tail = new Float32Array(0); // 上一個 render quantum 的殘餘樣本
    this.out = new Int16Array(CHUNK_SAMPLES);
    this.outLen = 0;
    this.sumSquares = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    // 多聲道混單聲道由前級 ChannelMerger 處理；這裡只拿第一聲道
    const merged = new Float32Array(this.tail.length + channel.length);
    merged.set(this.tail, 0);
    merged.set(channel, this.tail.length);

    let pos = this.readPos;
    while (pos + 1 < merged.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const sample = merged[i] * (1 - frac) + merged[i + 1] * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this.out[this.outLen++] = (clamped * 0x7fff) | 0;
      this.sumSquares += clamped * clamped;
      if (this.outLen === CHUNK_SAMPLES) this.flush();
      pos += this.ratio;
    }

    // 留下未消化的尾巴，維持重取樣連續性
    const keepFrom = Math.floor(pos);
    this.tail = merged.slice(keepFrom);
    this.readPos = pos - keepFrom;
    return true;
  }

  flush() {
    const rms = Math.sqrt(this.sumSquares / this.outLen);
    const pcm = this.out.slice(0, this.outLen);
    this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
    this.outLen = 0;
    this.sumSquares = 0;
  }
}

registerProcessor('capture-processor', CaptureProcessor);

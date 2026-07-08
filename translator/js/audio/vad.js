// 本地 VAD 靜音閘門 —— 省額度核心。
// 免費/付費額度都是按「送出去的音訊」計算，沒人說話就不該送。
// 帶 pre-roll 環形緩衝：偵測到人聲時先補送前 ~400ms，避免句首被切掉。

const CHUNK_MS = 100;
const PRE_ROLL_CHUNKS = 4; // 400ms

export class VadGate {
  constructor({ threshold = 0.012, hangoverMs = 900, enabled = true } = {}) {
    this.threshold = threshold;
    this.hangoverMs = hangoverMs;
    this.enabled = enabled;
    this.voiced = false;
    this.silentMs = 0;
    this.preRoll = [];
    this.onVoiceStart = null;
    this.onVoiceEnd = null;
    this.suppressedMs = 0; // 統計省下的音訊毫秒數
  }

  // 回傳這次應該送出的 chunks 陣列（可能為空、可能含 pre-roll）
  feed({ int16, rms }) {
    if (!this.enabled) return [int16];

    const isVoice = rms >= this.threshold;
    if (isVoice) {
      this.silentMs = 0;
      if (!this.voiced) {
        this.voiced = true;
        const flush = [...this.preRoll, int16];
        this.preRoll = [];
        this.onVoiceStart?.();
        return flush;
      }
      return [int16];
    }

    if (this.voiced) {
      this.silentMs += CHUNK_MS;
      if (this.silentMs >= this.hangoverMs) {
        this.voiced = false;
        this.onVoiceEnd?.();
        // 這個 chunk 進 pre-roll 而不送出
        this.pushPreRoll(int16);
        return [];
      }
      return [int16]; // hangover 期間持續送，讓伺服器端 VAD 判斷句尾
    }

    this.pushPreRoll(int16);
    this.suppressedMs += CHUNK_MS;
    return [];
  }

  pushPreRoll(int16) {
    this.preRoll.push(int16);
    if (this.preRoll.length > PRE_ROLL_CHUNKS) this.preRoll.shift();
  }

  reset() {
    this.voiced = false;
    this.silentMs = 0;
    this.preRoll = [];
  }
}

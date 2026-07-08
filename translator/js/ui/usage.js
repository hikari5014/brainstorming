// 用量儀表：按日累計送出/接收/省下的音訊秒數，估算付費層費用。
// 計費依官方定價：音訊 25 tokens/秒；translate 引擎輸入 $0.0053/分、輸出 $0.0315/分。

const STORAGE_KEY = 'liveTranslator.usage.v1';

const RATE_IN_PER_MIN = 0.0053;
const RATE_OUT_PER_MIN = 0.0315;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class UsageMeter extends EventTarget {
  constructor() {
    super();
    try {
      this.data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      this.data = {};
    }
    if (!this.data.byDay) this.data = { byDay: {} };
    this.dirty = false;
    this.warnedToday = false;
    setInterval(() => this.persist(), 3000);
  }

  day(key = todayKey()) {
    if (!this.data.byDay[key]) this.data.byDay[key] = { sentSec: 0, recvSec: 0, savedSec: 0 };
    return this.data.byDay[key];
  }

  add(field, sec) {
    if (!sec || sec <= 0) return;
    this.day()[field] += sec;
    this.dirty = true;
    this.dispatchEvent(new CustomEvent('change'));
  }

  addSent(sec) { this.add('sentSec', sec); }
  addRecv(sec) { this.add('recvSec', sec); }
  addSaved(sec) { this.add('savedSec', sec); }

  persist() {
    if (!this.dirty) return;
    this.dirty = false;
    // 只留最近 60 天
    const keys = Object.keys(this.data.byDay).sort();
    while (keys.length > 60) delete this.data.byDay[keys.shift()];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
  }

  today() {
    return this.day();
  }

  todaySummary() {
    const t = this.today();
    const totalMin = (t.sentSec + t.recvSec) / 60;
    const cost = (t.sentSec / 60) * RATE_IN_PER_MIN + (t.recvSec / 60) * RATE_OUT_PER_MIN;
    return {
      sentMin: t.sentSec / 60,
      recvMin: t.recvSec / 60,
      savedMin: t.savedSec / 60,
      totalMin,
      costUsd: cost,
    };
  }

  // 超過每日警示門檻時回傳 true（每天只警告一次）
  shouldWarn(dailyBudgetMin) {
    if (!dailyBudgetMin || dailyBudgetMin <= 0 || this.warnedToday) return false;
    if (this.todaySummary().totalMin >= dailyBudgetMin) {
      this.warnedToday = true;
      return true;
    }
    return false;
  }
}

export function formatMin(min) {
  if (min < 1) return `${Math.round(min * 60)} 秒`;
  return `${min.toFixed(1)} 分`;
}

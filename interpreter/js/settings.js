// 設定：全部存 localStorage，BYOK —— API key 只留在這台裝置。

const KEY = 'kouyiji.settings.v1';

export const MODEL = 'gemini-3.5-live-translate-preview';

const DEFAULTS = {
  apiKey: '',
  apiKeyThem: '', // 選填：對方→中文 方向專用的第二把 key（額度加倍、互不搶限額）
  foreignLang: 'en',
  demoMode: false,
  fontScale: 1,
  idleDisconnectMin: 5, // 幾分鐘沒對話就斷線省額度（按鈕按下自動重連）
  talkMode: 'hold', // 'hold' 按住說話 | 'toggle' 點一下開始、再點一下結束（全手動，無自動判斷）
  themTextOnly: true, // 對方→中文只出字幕不播中文語音（讀字幕比聽語音快、免語音下載等待、省一半額度）
  refineListen: true, // 聆聽字幕 AI 潤飾：每句完成後依上下文改寫成通順中文，原地替換（✨）
  autoDisconnect: true, // 每輪結束確實斷線省額度，下次按住自動重連（開頭有緩衝不漏字）
  voiceAfterRelease: true, // 放開錄音鈕後，等翻譯完整才播語音（字幕仍即時）
  manualPlay: false, // 手動開播：放開後不自動判斷，由使用者按「▶ 播放」觸發
  voiceIndicator: true, // 對話畫面即時顯示語音接收狀況（幾條/幾秒、仍在下載或已靜止）
  voiceIdleSec: 1.4, // 翻譯文字停止增長幾秒 → 判定「翻譯完整」開播
  voiceMaxWaitSec: 15, // 放開後最長等待秒數（保險絲，超過必定開播）
  silenceTailSec: 1.5, // 放開後補送幾秒靜音，讓伺服器把句子收尾（修翻譯半截）
  theme: 'dark', // 'dark' | 'light'
};

let cached = null;

export function loadSettings() {
  if (cached) return cached;
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* fresh */ }
  cached = { ...DEFAULTS, ...stored };
  return cached;
}

export function saveSettings(patch) {
  cached = { ...loadSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(cached));
  return cached;
}

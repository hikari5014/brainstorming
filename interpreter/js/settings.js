// 設定：全部存 localStorage，BYOK —— API key 只留在這台裝置。

const KEY = 'kouyiji.settings.v1';

export const MODEL = 'gemini-3.5-live-translate-preview';

const DEFAULTS = {
  apiKey: '',
  foreignLang: 'en',
  demoMode: false,
  fontScale: 1,
  idleDisconnectMin: 5, // 幾分鐘沒對話就斷線省額度（按鈕按下自動重連）
  voiceAfterRelease: true, // 放開錄音鈕後，等翻譯完整才播語音（字幕仍即時）
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

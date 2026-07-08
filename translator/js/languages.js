// gemini-3.5-live-translate-preview 支援的目標語言（BCP-47）
// 來源：https://ai.google.dev/gemini-api/docs/live-api/live-translate
// 來源語言由模型自動偵測，不需設定。

export const POPULAR = ['zh-Hant', 'zh-Hans', 'en', 'ja', 'ko', 'es', 'fr', 'de', 'vi', 'th', 'id'];

export const LANGUAGES = [
  { code: 'zh-Hant', name: '中文（繁體）' },
  { code: 'zh-Hans', name: '中文（簡體）' },
  { code: 'en', name: '英語' },
  { code: 'ja', name: '日語' },
  { code: 'ko', name: '韓語' },
  { code: 'es', name: '西班牙語' },
  { code: 'fr', name: '法語' },
  { code: 'de', name: '德語' },
  { code: 'vi', name: '越南語' },
  { code: 'th', name: '泰語' },
  { code: 'id', name: '印尼語' },
  { code: 'af', name: '南非語' },
  { code: 'ak', name: '阿坎語' },
  { code: 'sq', name: '阿爾巴尼亞語' },
  { code: 'am', name: '阿姆哈拉語' },
  { code: 'ar', name: '阿拉伯語' },
  { code: 'hy', name: '亞美尼亞語' },
  { code: 'az', name: '亞塞拜然語' },
  { code: 'eu', name: '巴斯克語' },
  { code: 'be', name: '白俄羅斯語' },
  { code: 'bn', name: '孟加拉語' },
  { code: 'bg', name: '保加利亞語' },
  { code: 'my', name: '緬甸語' },
  { code: 'ca', name: '加泰隆尼亞語' },
  { code: 'hr', name: '克羅埃西亞語' },
  { code: 'cs', name: '捷克語' },
  { code: 'da', name: '丹麥語' },
  { code: 'nl', name: '荷蘭語' },
  { code: 'et', name: '愛沙尼亞語' },
  { code: 'fil', name: '菲律賓語' },
  { code: 'fi', name: '芬蘭語' },
  { code: 'gl', name: '加利西亞語' },
  { code: 'ka', name: '喬治亞語' },
  { code: 'el', name: '希臘語' },
  { code: 'gu', name: '古吉拉特語' },
  { code: 'ha', name: '豪薩語' },
  { code: 'he', name: '希伯來語' },
  { code: 'hi', name: '印地語' },
  { code: 'hu', name: '匈牙利語' },
  { code: 'is', name: '冰島語' },
  { code: 'it', name: '義大利語' },
  { code: 'jv', name: '爪哇語' },
  { code: 'kn', name: '康納達語' },
  { code: 'kk', name: '哈薩克語' },
  { code: 'km', name: '高棉語' },
  { code: 'rw', name: '盧安達語' },
  { code: 'lo', name: '寮語' },
  { code: 'lv', name: '拉脫維亞語' },
  { code: 'lt', name: '立陶宛語' },
  { code: 'mk', name: '馬其頓語' },
  { code: 'ms', name: '馬來語' },
  { code: 'ml', name: '馬拉雅拉姆語' },
  { code: 'mr', name: '馬拉提語' },
  { code: 'mn', name: '蒙古語' },
  { code: 'ne', name: '尼泊爾語' },
  { code: 'no', name: '挪威語' },
  { code: 'fa', name: '波斯語' },
  { code: 'pl', name: '波蘭語' },
  { code: 'pt-BR', name: '葡萄牙語（巴西）' },
  { code: 'pt-PT', name: '葡萄牙語（葡萄牙）' },
  { code: 'pa', name: '旁遮普語' },
  { code: 'ro', name: '羅馬尼亞語' },
  { code: 'ru', name: '俄語' },
  { code: 'sr', name: '塞爾維亞語' },
  { code: 'sd', name: '信德語' },
  { code: 'si', name: '僧伽羅語' },
  { code: 'sk', name: '斯洛伐克語' },
  { code: 'sl', name: '斯洛維尼亞語' },
  { code: 'su', name: '巽他語' },
  { code: 'sw', name: '斯瓦希里語' },
  { code: 'sv', name: '瑞典語' },
  { code: 'ta', name: '坦米爾語' },
  { code: 'te', name: '泰盧固語' },
  { code: 'tr', name: '土耳其語' },
  { code: 'uk', name: '烏克蘭語' },
  { code: 'ur', name: '烏爾都語' },
  { code: 'uz', name: '烏茲別克語' },
  { code: 'zu', name: '祖魯語' },
];

const byCode = new Map(LANGUAGES.map((l) => [l.code, l.name]));

export function langName(code) {
  if (!code) return '';
  if (byCode.has(code)) return byCode.get(code);
  // 模型偵測到的來源語言可能帶地區（如 en-US、cmn-Hant-TW），退回主標籤比對
  const base = code.split('-')[0];
  for (const l of LANGUAGES) {
    if (l.code.split('-')[0] === base) return l.name;
  }
  return code;
}

export function fillLanguageSelect(selectEl, selected) {
  selectEl.innerHTML = '';
  const popularGroup = document.createElement('optgroup');
  popularGroup.label = '常用';
  const restGroup = document.createElement('optgroup');
  restGroup.label = '全部（A–Z）';
  const popularSet = new Set(POPULAR);
  for (const l of LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = `${l.name} (${l.code})`;
    if (popularSet.has(l.code)) popularGroup.appendChild(opt);
    else restGroup.appendChild(opt);
  }
  selectEl.appendChild(popularGroup);
  selectEl.appendChild(restGroup);
  if (selected) selectEl.value = selected;
}

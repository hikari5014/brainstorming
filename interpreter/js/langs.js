// 台灣人最常用的 10 種外語（BCP-47，皆為 gemini-3.5-live-translate 支援的目標語言）
// 使用者端固定為中文（繁體）zh-Hant。

export const MY_LANG = 'zh-Hant';

export const FOREIGN_LANGS = [
  { code: 'en',  name: '英語',    native: 'English',    flag: '🇺🇸' },
  { code: 'ja',  name: '日語',    native: '日本語',      flag: '🇯🇵' },
  { code: 'ko',  name: '韓語',    native: '한국어',      flag: '🇰🇷' },
  { code: 'vi',  name: '越南語',  native: 'Tiếng Việt', flag: '🇻🇳' },
  { code: 'th',  name: '泰語',    native: 'ไทย',        flag: '🇹🇭' },
  { code: 'id',  name: '印尼語',  native: 'Indonesia',  flag: '🇮🇩' },
  { code: 'fil', name: '菲律賓語', native: 'Filipino',   flag: '🇵🇭' },
  { code: 'ms',  name: '馬來語',  native: 'Melayu',     flag: '🇲🇾' },
  { code: 'es',  name: '西班牙語', native: 'Español',    flag: '🇪🇸' },
  { code: 'fr',  name: '法語',    native: 'Français',   flag: '🇫🇷' },
];

const byCode = new Map(FOREIGN_LANGS.map((l) => [l.code, l]));

export function langOf(code) {
  return byCode.get(code) || FOREIGN_LANGS[0];
}

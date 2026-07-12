// 台灣人最常用的 10 種外語（BCP-47，皆為 gemini-3.5-live-translate 支援的目標語言）
// 使用者端固定為中文（繁體）zh-Hant。

export const MY_LANG = 'zh-Hant';

// ui.*：顯示給「該語言讀者」看的介面文字（規格：標籤語言對應讀者的語言）
export const FOREIGN_LANGS = [
  { code: 'en',  name: '英語',    native: 'English',    flag: '🇺🇸',
    ui: { hold: 'Hold to speak', original: 'Original', live: 'Interpreting', tap: 'Tap to speak', stop: 'Tap to stop' } },
  { code: 'ja',  name: '日語',    native: '日本語',      flag: '🇯🇵',
    ui: { hold: '押しながら話す', original: '原文', live: '通訳中', tap: 'タップで話す', stop: 'タップで終了' } },
  { code: 'ko',  name: '韓語',    native: '한국어',      flag: '🇰🇷',
    ui: { hold: '누른 채 말하기', original: '원문', live: '통역 중', tap: '탭하여 말하기', stop: '탭하여 종료' } },
  { code: 'vi',  name: '越南語',  native: 'Tiếng Việt', flag: '🇻🇳',
    ui: { hold: 'Giữ để nói', original: 'Bản gốc', live: 'Đang phiên dịch', tap: 'Chạm để nói', stop: 'Chạm để dừng' } },
  { code: 'th',  name: '泰語',    native: 'ไทย',        flag: '🇹🇭',
    ui: { hold: 'กดค้างเพื่อพูด', original: 'ต้นฉบับ', live: 'กำลังแปล', tap: 'แตะเพื่อพูด', stop: 'แตะเพื่อหยุด' } },
  { code: 'id',  name: '印尼語',  native: 'Indonesia',  flag: '🇮🇩',
    ui: { hold: 'Tahan untuk bicara', original: 'Asli', live: 'Menerjemahkan', tap: 'Ketuk untuk bicara', stop: 'Ketuk untuk berhenti' } },
  { code: 'fil', name: '菲律賓語', native: 'Filipino',   flag: '🇵🇭',
    ui: { hold: 'Pindutin para magsalita', original: 'Orihinal', live: 'Nagsasalin', tap: 'I-tap para magsalita', stop: 'I-tap para huminto' } },
  { code: 'ms',  name: '馬來語',  native: 'Melayu',     flag: '🇲🇾',
    ui: { hold: 'Tahan untuk bercakap', original: 'Asal', live: 'Mentafsir', tap: 'Ketik untuk bercakap', stop: 'Ketik untuk berhenti' } },
  { code: 'es',  name: '西班牙語', native: 'Español',    flag: '🇪🇸',
    ui: { hold: 'Mantén para hablar', original: 'Original', live: 'Interpretando', tap: 'Toca para hablar', stop: 'Toca para detener' } },
  { code: 'fr',  name: '法語',    native: 'Français',   flag: '🇫🇷',
    ui: { hold: 'Maintenir pour parler', original: 'Original', live: 'Interprétation', tap: 'Appuyer pour parler', stop: 'Appuyer pour arrêter' } },
];

const byCode = new Map(FOREIGN_LANGS.map((l) => [l.code, l]));

export function langOf(code) {
  return byCode.get(code) || FOREIGN_LANGS[0];
}

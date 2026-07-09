// 五種模式的宣告式設定 + 字幕路由。
// 每個模式回傳 pipeline 的啟動參數；字幕依 (mode, tag, kind, lang) 決定進哪個面板。
//
//   audio:  'voice' = 開回音消除（人講話用）
//           'raw'   = 全關（聽裝置/環境播放的聲音用；AEC 會把同裝置播放的聲音消掉）
//   gate:   半雙工閘門 —— 口譯播放期間暫停送音，防止伺服器把口譯聲當插話而中斷語音

function baseLang(code) {
  return (code || '').split('-')[0].toLowerCase();
}

function isMyLang(langCode, myLang) {
  if (!langCode) return false;
  const base = baseLang(langCode);
  const myBase = baseLang(myLang);
  if (base === myBase) return true;
  // 模型偵測中文可能回 cmn / zh 系代碼
  const zhSet = new Set(['zh', 'cmn', 'yue']);
  return zhSet.has(base) && zhSet.has(myBase);
}

export const MODES = {
  conversation: {
    label: '對話',
    view: 'conversation',
    source: 'mic',
    audio: 'voice',
    gate: true,
    voiceDefault: true,
    hint: '面對面雙向對話：你們各說各的語言，字幕與語音即時互譯。',
    targets(s, { direction }) {
      if (s.conversationMode === 'auto') {
        return [
          { code: s.theirLang, echo: false, tag: 'toTheirs' },
          { code: s.myLang, echo: false, tag: 'toMine' },
        ];
      }
      return direction === 'in'
        ? [{ code: s.myLang, echo: false, tag: 'main' }]
        : [{ code: s.theirLang, echo: false, tag: 'main' }];
    },
  },
  listen: {
    label: '聆聽',
    view: 'stream',
    source: 'mic',
    audio: 'raw',
    gate: false,
    voiceDefault: false,
    hint: '聆聽字幕：聽演講、周遭對話或另一台裝置的影片，即時顯示你的語言字幕。（要翻「這台裝置播放的影片」請改用影片模式，收音更乾淨）',
    targets(s) {
      return [{ code: s.myLang, echo: false, tag: 'main' }];
    },
  },
  speak: {
    label: '我說',
    view: 'stream',
    source: 'mic',
    audio: 'voice',
    gate: true,
    voiceDefault: true,
    flippable: true,
    hint: '我說→翻給對方：對著手機說母語，翻譯用大字幕與語音呈現給對方。',
    targets(s) {
      return [{ code: s.theirLang, echo: false, tag: 'main' }];
    },
  },
  video: {
    label: '影片',
    view: 'video',
    source: 'element',
    audio: 'raw',
    gate: false,
    voiceDefault: true,
    hint: '影片翻譯：在 app 內播放影片檔或直連網址，口譯時自動壓低影片音量（手機、電腦都支援）。',
    targets(s) {
      return [{ code: s.myLang, echo: false, tag: 'main' }];
    },
  },
  meeting: {
    label: '會議',
    view: 'stream',
    source: 'display',
    audio: 'raw',
    gate: false,
    voiceDefault: false,
    desktopOnly: true,
    hint: '會議模式：擷取分頁/視窗的聲音（選「分頁」並勾「同時分享分頁音訊」）。開啟口譯語音時會自動壓低會議音量。',
    targets(s) {
      return [{ code: s.myLang, echo: false, tag: 'main' }];
    },
  },
};

// 回傳 'mine' | 'theirs' | 'stream' | 'video' | null（null = 丟棄，避免重複顯示）
export function routeSegment(modeId, settings, direction, seg) {
  const view = MODES[modeId].view;
  if (view === 'video') return 'video';
  if (view === 'stream') return 'stream';

  if (settings.conversationMode === 'auto') {
    if (seg.kind === 'input') {
      // 兩條 session 都會轉錄輸入，只採用 toTheirs 那條避免重複
      if (seg.tag !== 'toTheirs') return null;
      return isMyLang(seg.lang, settings.myLang) ? 'mine' : 'theirs';
    }
    // 譯文：target=對方語言 → 顯示在對方面板
    return seg.tag === 'toTheirs' ? 'theirs' : 'mine';
  }

  // 手動單向：out = 我說→對方（原文在我這、譯文在對方那）
  if (direction === 'out') return seg.kind === 'input' ? 'mine' : 'theirs';
  return seg.kind === 'input' ? 'theirs' : 'mine';
}

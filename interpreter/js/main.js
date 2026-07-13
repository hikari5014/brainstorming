// 口譯機 v4 —— 面對面雙向對話（上下分區）＋單向聆聽。
//
// 不變的架構原則（歷代教訓）：
//   - 通話隱喻：按「開始」才開麥克風＋建線；結束通話即全部關閉
//   - 對話模式聲音只在「按住」時送出；聆聽模式為連續送出的單連線
//   - 單一 AudioContext（audio.js）、實體按壓與非同步啟動解耦、window 級 catch-all

import { MY_LANG, langOf, FOREIGN_LANGS } from './langs.js';
import { loadSettings, saveSettings } from './settings.js';
import { LiveSession, MockSession } from './live.js';
import { AudioEngine } from './audio.js';
import { runDiagnostics, formatDiagnostics } from './diag.js';
import { TranscriptStore, formatTxt, downloadTxt } from './transcript.js';
import { vlog, vlogBegin, vlogMark, vlogAudio, renderVoiceLog } from './voicelog.js';

const $ = (s) => document.querySelector(s);

let settings = loadSettings();
const audio = new AudioEngine();
const store = new TranscriptStore();

const state = {
  phase: 'home', // 'home' | 'call' | 'listen'
  mode: 'call', // 首頁選擇的模式
  holding: null, // null | 'me' | 'them'
  pressed: { me: false, them: false },
  awaitVoice: null, // {tag, releasedAt, lastTextAt, lastAudioAt, poll} 等翻譯完整才播語音
  manualWait: null, // 手動開播模式：放開後等使用者按「▶ 播放」的 tag
  replay: { chunks: [], secs: 0 }, // 上一句外語翻譯語音的本機留存（對方沒聽清楚可重播）
  lastAudioAt: { toForeign: 0, toMine: 0 }, // 各連線最後收到語音資料的時刻（回收連線的安全鎖）
  sessionSeq: 0, // 連線建立次數（測試/除錯用）
  listening: false,
  sessions: { toForeign: null, toMine: null },
  pending: { toForeign: [], toMine: [] }, // 連線完成前的音訊暫存
  turns: { toForeign: null, toMine: null }, // 進行中的回合（逐字稿用）
  callHadTurns: false,
  lastActivity: Date.now(),
  wakeLock: null,
  pendingTimer: null,
};

/* ---------- 小工具 ---------- */
let toastTimer = null;
function toast(msg, ms = 4000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

const useMock = () => settings.demoMode || !settings.apiKey?.trim();
const foreign = () => langOf(settings.foreignLang);

function track(kind, sec) {
  const day = new Date().toISOString().slice(0, 10);
  let u;
  try { u = JSON.parse(localStorage.getItem('kouyiji.usage') || '{}'); } catch { u = {}; }
  if (u.day !== day) u = { day, sent: 0, recv: 0 };
  u[kind] += sec;
  localStorage.setItem('kouyiji.usage', JSON.stringify(u));
}

/* ---------- 回合（逐字稿）---------- */
function beginTurn(tag) {
  finalizeTurn(tag); // 前一輪若還沒收尾先存
  state.turns[tag] = {
    ts: Date.now(),
    mode: state.phase,
    side: tag === 'toForeign' ? 'me' : 'them',
    srcLang: tag === 'toForeign' ? '中文' : foreign().name,
    dstLang: tag === 'toForeign' ? foreign().name : '中文',
    src: '', dst: '', saved: false,
  };
}

function finalizeTurn(tag) {
  const t = state.turns[tag];
  if (!t || t.saved) return;
  if (t.src.trim() || t.dst.trim()) {
    t.saved = true;
    state.callHadTurns = true;
    store.add({ ts: t.ts, mode: t.mode, side: t.side, srcLang: t.srcLang, dstLang: t.dstLang, src: t.src.trim(), dst: t.dst.trim() });
  }
  state.turns[tag] = null;
}

function finalizeAllTurns() {
  finalizeTurn('toForeign');
  finalizeTurn('toMine');
}

/* ---------- 顯示路由 ---------- */
// toForeign（我說）→ 上半（對方讀）；toMine（對方說/聆聽）→ 下半或聆聽 feed
function routeText(tag, kind, text) {
  state.lastActivity = Date.now();
  const t = state.turns[tag] || (beginTurn(tag), state.turns[tag]);
  t[kind === 'input' ? 'src' : 'dst'] += text;

  // 文字還在增長 → 翻譯尚未完整，語音繼續等
  if (state.awaitVoice?.tag === tag) state.awaitVoice.lastTextAt = Date.now();
  if (kind === 'output' && !settings.voiceAfterRelease) hidePendingDots();

  if (state.phase === 'listen') {
    renderListenTurn(t);
    return;
  }
  const side = tag === 'toForeign' ? 'theirs' : 'mine';
  $(`#${side}-src`).textContent = t.src;
  $(`#${side}-dst`).textContent = t.dst;
  $(`#${side}-src-row`).classList.toggle('show', Boolean(t.src));
}

/* ---------- 連線 ---------- */
function themTextOnly() {
  return settings.themTextOnly; // 對方→中文純文字（toMine 方向不使用語音）
}

function makeSession(tag) {
  state.sessionSeq += 1;
  const target = tag === 'toForeign' ? settings.foreignLang : MY_LANG;
  // 雙 key：對方→中文 方向可用專用 key（額度加倍、互不搶限額），留空共用主 key
  const key = (tag === 'toMine' && settings.apiKeyThem?.trim()) ? settings.apiKeyThem.trim() : settings.apiKey.trim();
  const textOnly = tag === 'toMine' && themTextOnly();
  const session = useMock() ? new MockSession({ tag }) : new LiveSession({ apiKey: key, target, tag, textOnly });

  session.addEventListener('status', (e) => {
    renderLive();
    if (e.detail.state === 'open') flushPending(tag);
  });
  session.addEventListener('input-text', (e) => routeText(tag, 'input', e.detail.text));
  session.addEventListener('output-text', (e) => routeText(tag, 'output', e.detail.text));
  session.addEventListener('audio', (e) => {
    // 純文字模式的保險：就算伺服器仍送語音（TEXT 被降級），也直接捨棄不播
    if (tag === 'toMine' && themTextOnly()) return;
    const sec = audio.playBase64(e.detail.base64);
    if (sec) track('recv', sec);
    if (sec && tag === 'toForeign') rememberReplay(e.detail.base64, sec); // 留存供重播

    state.lastActivity = Date.now();
    state.lastAudioAt[tag] = Date.now();
    // 語音資料還在進來 → 就算文字已停，翻譯也還沒完整，繼續等
    if (state.awaitVoice?.tag === tag) state.awaitVoice.lastAudioAt = Date.now();
  });
  session.addEventListener('turn-complete', () => {
    finalizeTurn(tag);
    vlogMark('turn-complete');
    // 伺服器明確表示這輪生成完畢 → 語音可以開播了
    if (state.awaitVoice?.tag === tag) releaseVoiceNow('turn-complete');
    else if (tag === 'toMine' && themTextOnly() && state.phase === 'call' && !state.holding) {
      // 對方方向純文字：字幕跑完即結束；預設立刻斷線省額度（下次按住自動重連）
      hidePendingDots();
      if (settings.autoDisconnect && state.sessions[tag] === session) {
        session.close();
        state.sessions[tag] = null;
        renderLive();
      }
    }
  });
  session.addEventListener('fatal', (e) => {
    const reason = e.detail.reason || '';
    if (/quota|exceeded|429/i.test(reason)) toast('額度已用盡（免費層每日限額）。', 8000);
    else if (/api key|401|403|PERMISSION/i.test(reason)) toast('API key 無效或無權限：設定 → 連線診斷。', 8000);
    else toast(`連線失敗：${reason}（設定 → 連線診斷）`, 8000);
    endSession(true);
  });
  return session;
}

function ensureSessions(tags) {
  for (const tag of tags) {
    const s = state.sessions[tag];
    if (!s || s.state === 'closed' || s.state === 'error') {
      state.sessions[tag] = makeSession(tag);
      state.sessions[tag].connect();
    }
  }
}

function closeSessions() {
  for (const tag of ['toForeign', 'toMine']) {
    state.sessions[tag]?.close();
    state.sessions[tag] = null;
    state.pending[tag] = [];
  }
}

function flushPending(tag) {
  const s = state.sessions[tag];
  if (!s || s.state !== 'open') return;
  const buf = state.pending[tag];
  state.pending[tag] = [];
  for (const int16 of buf) {
    if (s.sendAudio(int16)) track('sent', int16.length / 16000);
  }
}

function sendChunk(tag, int16) {
  const s = state.sessions[tag];
  if (s && s.state === 'open') {
    flushPending(tag);
    if (s.sendAudio(int16)) track('sent', int16.length / 16000);
  } else {
    state.pending[tag].push(int16);
    if (state.pending[tag].length > 50) state.pending[tag].shift();
  }
}

/* ---------- 音訊 chunk 路由 ---------- */
audio.onChunk = ({ int16, rms }) => {
  if (state.phase === 'call' && state.holding) {
    setWave(state.holding === 'me' ? 'wave-me' : 'wave-them', rms);
    sendChunk(state.holding === 'me' ? 'toForeign' : 'toMine', int16);
  } else if (state.phase === 'listen' && state.listening) {
    setWave('wave-listen', rms);
    sendChunk('toMine', int16);
  }
};

audio.onVoiceEvent = vlogAudio; // 每條語音的到達/播放/缺口 → 語音記錄

audio.onMicLost = () => {
  toast('麥克風中斷了。');
  endSession(true);
};

function setWave(id, rms) {
  document.getElementById(id)?.style.setProperty('--level', Math.min(1, rms * 14).toFixed(3));
}

function clearWaves() {
  for (const id of ['wave-me', 'wave-them', 'wave-listen']) {
    document.getElementById(id)?.style.setProperty('--level', '0');
  }
}

/* ---------- 通話開始 / 結束 ---------- */
async function startSession(mode) {
  try {
    await audio.start(); // 使用者手勢中開麥克風（通話隱喻：按下才開）
  } catch (err) {
    toast(err?.name === 'NotAllowedError' ? '需要麥克風權限。' : `無法啟動麥克風：${err?.message || err}`, 6000);
    return;
  }
  // 教訓：通話期間不要反覆開關 mic track —— iOS 每次切換都會重新配置音訊路由，
  // 讓後續播放斷斷續續。整通電話保持開啟，收不收音由回合狀態機（軟體層）決定。
  audio.setMicEnabled(true);
  state.phase = mode;
  document.body.dataset.manual = settings.voiceAfterRelease && settings.manualPlay ? 'on' : '';
  state.callHadTurns = false;
  state.lastActivity = Date.now();
  document.body.dataset.phase = mode;
  $('#view-home').classList.add('hidden');
  $('#view-call').classList.toggle('hidden', mode !== 'call');
  $('#view-listen').classList.toggle('hidden', mode !== 'listen');
  ensureSessions(mode === 'call' ? ['toForeign', 'toMine'] : ['toMine']);
  if (mode === 'listen') {
    $('#listen-feed').innerHTML = '';
    setListening(true); // 進入即開始聆聽，可點按暫停
  }
  acquireWakeLock();
  renderLive();
}

async function endSession(silent = false) {
  cancelAwaitVoice();
  cancelManualWait();
  state.replay = { chunks: [], secs: 0 };
  updateReplayBtn();
  releaseHold();
  setListening(false);
  finalizeAllTurns();
  hidePendingDots();
  closeSessions();
  await audio.close(); // 通話隱喻：結束就關麥克風，iOS 錄音指示燈熄滅
  clearWaves();
  const hadTurns = state.callHadTurns;
  state.phase = 'home';
  document.body.dataset.phase = 'home';
  $('#view-call').classList.add('hidden');
  $('#view-listen').classList.add('hidden');
  $('#view-home').classList.remove('hidden');
  // 清空面對面殘留內容
  for (const id of ['theirs-src', 'theirs-dst', 'mine-src', 'mine-dst']) $(`#${id}`).textContent = '';
  $('#theirs-src-row').classList.remove('show');
  $('#mine-src-row').classList.remove('show');
  renderLive();
  if (!silent && hadTurns) openTranscript(); // 結束後進入逐字稿檢視
}

/* ---------- 按住說話（沿用歷代競態防線） ---------- */
async function beginHold(side, btn) {
  if (state.phase !== 'call' || state.holding) return;
  audio.kick();
  if (!state.pressed[side]) return; // 按下後已放開
  if (state.awaitVoice || state.manualWait) vlogMark('interrupted'); // 搶話：上一輪還沒播的語音作廢
  cancelAwaitVoice();
  cancelManualWait();
  audio.stopPlayback(); // 停掉還沒播完（含暫存）的譯文
  state.holding = side;
  ensureSessions([side === 'me' ? 'toForeign' : 'toMine']); // 每輪斷線模式：按下即重連（開頭進緩衝不漏字）
  state.lastActivity = Date.now();
  if (settings.voiceAfterRelease) audio.beginVoiceHold(); // 錄音中譯文語音先暫存
  btn.classList.add('holding');
  document.body.dataset.holding = side;
  hidePendingDots();
  if (side === 'me') { state.replay = { chunks: [], secs: 0 }; } // 新的一句開始 → 舊語音作廢
  updateReplayBtn();
  beginTurn(side === 'me' ? 'toForeign' : 'toMine');
  vlogBegin({
    tag: side === 'me' ? 'toForeign' : 'toMine',
    dir: side === 'me' ? `我 → ${foreign().native}` : `${foreign().native} → 我`,
    textOnly: side === 'them' && themTextOnly(),
  });
  updateTalkLabels();
  renderLive();
}

function releaseHold() {
  state.pressed.me = false;
  state.pressed.them = false;
  if (!state.holding) return;
  const side = state.holding;
  const tag = side === 'me' ? 'toForeign' : 'toMine';
  state.holding = null;
  document.body.dataset.holding = '';
  $('#hold-me').classList.remove('holding');
  $('#hold-them').classList.remove('holding');
  clearWaves();
  showPendingDots(); // 放開 → 翻譯中跳動點（固定高度區）
  updateTalkLabels();
  renderLive();

  // 放開得太快時，伺服器的 VAD 等不到「靜音」就無法把句子收尾（翻譯只出現一半的根因）
  // → 補送 1.5 秒靜音讓它乾脆結束這一句
  sendSilenceTail(tag);
  vlogMark('release');

  if (tag === 'toMine' && themTextOnly()) {
    // 對方方向純文字：沒有中文語音要等，字幕跑完（turn-complete）就收尾＋斷線
    audio.endVoiceHold(); // 順帶放掉可能殘留的暫存
    return;
  }

  if (settings.voiceAfterRelease && settings.manualPlay) {
    // 手動開播：不做任何自動判斷，等使用者看著接收指示器自己按「▶ 播放」
    state.manualWait = tag;
    $('#manual-play').classList.remove('hidden');
  } else if (settings.voiceAfterRelease) {
    // 語音等「翻譯完整」才播：turn-complete 或文字＋語音都停止增長（15 秒保險絲）
    beginAwaitVoice(tag);
  } else {
    vlogMark('voice-start', { reason: 'instant' });
    audio.endVoiceHold();
    watchPlaybackThenRecycle(tag);
  }
}

function cancelManualWait() {
  state.manualWait = null;
  $('#manual-play').classList.add('hidden');
}

function manualPlayNow() {
  if (!state.manualWait || state.phase !== 'call') return;
  const tag = state.manualWait;
  cancelManualWait();
  hidePendingDots();
  vlogMark('voice-start', { reason: 'manual' });
  audio.endVoiceHold(); // 使用者判定完整 → 從本機暫存播出
  watchPlaybackThenRecycle(tag);
}

function sendSilenceTail(tag) {
  if (useMock()) return; // 假引擎不需要，且會干擾其觸發節奏
  const silent = new Int16Array(1600); // 100ms
  const chunks = Math.round((settings.silenceTailSec ?? 1.5) * 10);
  for (let i = 0; i < chunks; i++) sendChunk(tag, silent);
}

function beginAwaitVoice(tag) {
  cancelAwaitVoice();
  const aw = { tag, releasedAt: Date.now(), lastTextAt: Date.now(), lastAudioAt: Date.now(), poll: null };
  const idleLimit = (settings.voiceIdleSec ?? 1.4) * 1000;
  const maxWait = (settings.voiceMaxWaitSec ?? 15) * 1000;
  aw.poll = setInterval(() => {
    const textIdle = Date.now() - aw.lastTextAt;
    const audioIdle = Date.now() - aw.lastAudioAt;
    const totalMs = Date.now() - aw.releasedAt;
    // 「文字」與「語音」都停止增長才算完整。v8 以前只看文字，但文字通常比語音先到完，
    // 長句時常在語音只到一半時就開播 → 後半段變成邊下載邊播 → 尾段斷斷續續（真正根因）。
    if ((textIdle > idleLimit && audioIdle > idleLimit && totalMs > 800) || totalMs > maxWait) {
      releaseVoiceNow(totalMs > maxWait ? 'maxwait' : 'idle');
    }
  }, 200);
  state.awaitVoice = aw;
}

function cancelAwaitVoice() {
  if (state.awaitVoice) {
    clearInterval(state.awaitVoice.poll);
    state.awaitVoice = null;
  }
}

function releaseVoiceNow(reason = 'idle') {
  const tag = state.awaitVoice?.tag;
  cancelAwaitVoice();
  hidePendingDots();
  vlogMark('voice-start', { reason });
  audio.endVoiceHold(); // 此刻整段語音已完整在本地 → 播放不再依賴網路，不會斷斷續續
  if (tag) watchPlaybackThenRecycle(tag);
}

// 語音播完後把該輪用過的連線換成全新的（趁空檔，下一輪按下時已就緒）
function watchPlaybackThenRecycle(tag) {
  const t0 = Date.now();
  let quiet = 0;
  const iv = setInterval(() => {
    if (state.phase !== 'call') { clearInterval(iv); return; }
    if (state.holding) { clearInterval(iv); return; } // 已開始下一輪，別打擾
    // 播放中偶爾有短暫縫隙，一瞬間的 isSpeaking=false 不代表播完；
    // 要「連續 3 次安靜」且「1 秒內沒再收到語音資料」才回收，否則會把還在送語音的連線砍斷（截斷後半句）
    const audioQuiet = Date.now() - (state.lastAudioAt[tag] || 0) > 1000;
    quiet = !audio.isSpeaking && audioQuiet ? quiet + 1 : 0;
    if (quiet >= 3 || Date.now() - t0 > 60000) {
      clearInterval(iv);
      if (state.phase === 'call' && !state.holding) {
        vlogMark('recycle');
        state.sessions[tag]?.close();
        state.sessions[tag] = null;
        // 預設每輪確實斷線省額度，按下說話鈕才重連；關閉此設定則立刻換一條新連線備用
        if (!settings.autoDisconnect) ensureSessions([tag]);
        renderLive();
      }
    }
  }, 300);
}

function bindHold(btn, side) {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (settings.talkMode === 'toggle') return; // 點擊式走 click
    btn.setPointerCapture?.(e.pointerId);
    state.pressed[side] = true;
    beginHold(side, btn);
  });
  for (const evt of ['pointerup', 'pointercancel']) {
    btn.addEventListener(evt, () => {
      if (settings.talkMode === 'toggle') return;
      state.pressed[side] = false;
      if (state.holding === side) releaseHold();
    });
  }
  // 點擊式：點一下開始、再點一下結束（全手動，無任何自動判斷）
  btn.addEventListener('click', () => {
    if (settings.talkMode !== 'toggle' || state.phase !== 'call') return;
    if (state.holding === side) {
      releaseHold();
    } else {
      if (state.holding) releaseHold(); // 換邊：先結束對方那輪
      state.pressed[side] = true;
      beginHold(side, btn);
    }
  });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}
// 全域 catch-all 只適用於按住式；點擊式的結束必須完全由使用者手動觸發
for (const evt of ['pointerup', 'pointercancel']) {
  window.addEventListener(evt, () => { if (settings.talkMode !== 'toggle') releaseHold(); }, true);
}
window.addEventListener('blur', () => { if (settings.talkMode !== 'toggle') releaseHold(); });

/* ---------- 外語語音重播（對方沒聽清楚 → 自己按一下再聽一次） ---------- */
// 上一句「我 → 外語」的翻譯語音留存本機（上限 120 秒），重播完全不動用網路與額度。
function rememberReplay(b64, sec) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  state.replay.chunks.push(new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2)));
  state.replay.secs += sec;
  while (state.replay.secs > 120 && state.replay.chunks.length) {
    const c = state.replay.chunks.shift();
    state.replay.secs -= c.length / 24000;
  }
  updateReplayBtn();
}

function updateReplayBtn() {
  const show = state.phase === 'call' && state.replay.secs > 0 &&
    !state.holding && !state.awaitVoice && !state.manualWait;
  $('#replay-them').classList.toggle('hidden', !show);
}

// 重播前把靜音裁掉：伺服器常在語音前後夾帶大段空白（第二輪起尤其明顯），
// 直接重播會先安靜 2-3 秒。以 10ms 視窗的峰值做閘門：裁掉頭尾、中段長靜音壓縮到 0.25 秒。
function trimSilence(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Int16Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }

  const WIN = 240; // 10ms @ 24kHz
  const THR = 400; // 峰值門檻（約 -38 dBFS，低於此視為無聲）
  const nWin = Math.ceil(all.length / WIN);
  const loud = new Uint8Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const end = Math.min(all.length, (w + 1) * WIN);
    for (let i = w * WIN; i < end; i++) {
      if (Math.abs(all[i]) > THR) { loud[w] = 1; break; }
    }
  }
  const first = loud.indexOf(1);
  if (first === -1) return all; // 整段無聲（不太可能）：原樣播
  const last = loud.lastIndexOf(1);

  const keep = [];
  let silentRun = 0;
  for (let w = Math.max(0, first - 5); w <= Math.min(nWin - 1, last + 5); w++) {
    if (loud[w]) { silentRun = 0; keep.push(w); }
    else if ((silentRun += 1) <= 25) keep.push(w); // 中段停頓最多保留 0.25s
  }
  const out = new Int16Array(keep.length * WIN);
  let oo = 0;
  for (const w of keep) {
    const seg = all.subarray(w * WIN, Math.min(all.length, (w + 1) * WIN));
    out.set(seg, oo);
    oo += seg.length;
  }
  return out.subarray(0, oo);
}

function replayLast() {
  if (state.phase !== 'call' || state.holding || !state.replay.secs) return;
  audio.kick();
  audio.stopPlayback(); // 從頭重播（若還在播就先停掉）
  audio.scheduleInt16(trimSilence(state.replay.chunks)); // 單一連續 buffer：無縫、無空白
  state.lastActivity = Date.now();
}

/* ---------- 語音接收指示器（即時看到「下載是否完全」，可開關） ---------- */
// 每 250ms 依語音記錄（vlog.cur）更新：收到幾條/幾秒、仍在接收還是已靜止幾秒。
// 讓使用者親眼確認斷音是「語音還沒下載完」（伺服器端）還是別的原因，
// 並在手動開播模式下自行判斷按「▶ 播放」的時機。
setInterval(() => {
  const el = $('#voice-ind');
  if (!el) return;
  const active = state.phase === 'call' && settings.voiceIndicator &&
    (state.holding || state.awaitVoice || state.manualWait);
  updateReplayBtn(); // 順便維護重播鍵顯示（同一節奏，狀態轉換都涵蓋）
  if (!active || !vlog.cur || vlog.cur.textOnly) { el.classList.add('hidden'); return; } // 純文字回合沒有語音可指示
  el.classList.remove('hidden');
  const t = vlog.cur;
  const n = t.chunks.length;
  if (n === 0) {
    el.textContent = '等待語音…';
    el.dataset.state = 'wait';
    return;
  }
  const secs = t.chunks.reduce((s, c) => s + c.durMs, 0) / 1000;
  const idle = (performance.now() - t.t0 - Math.max(...t.chunks.map((c) => c.arriveMs))) / 1000;
  if (idle < 1.2) {
    el.textContent = `⬇ 語音接收中 ${n} 條・${secs.toFixed(1)}s`;
    el.dataset.state = 'recv';
  } else {
    el.textContent = `✓ 已靜止 ${idle.toFixed(1)}s（${n} 條・${secs.toFixed(1)}s）`;
    el.dataset.state = 'quiet';
  }
}, 250);

/* ---------- 翻譯中跳動點（固定高度，不跳版面） ---------- */
function showPendingDots() {
  if (state.phase !== 'call') return;
  $('#pending-dots').classList.remove('hidden');
  clearTimeout(state.pendingTimer);
  state.pendingTimer = setTimeout(hidePendingDots, 12000);
}
function hidePendingDots() {
  clearTimeout(state.pendingTimer);
  $('#pending-dots')?.classList.add('hidden');
}

/* ---------- 聆聽模式 ---------- */
function setListening(on, skipUi = false) {
  state.listening = on; // 收不收音由軟體層決定，不動 mic track（iOS 路由穩定性）
  if (skipUi) return;
  const btn = $('#listen-toggle');
  btn.classList.toggle('on', on);
  btn.querySelector('span').textContent = on ? '停止聆聽' : '繼續聆聽';
  btn.setAttribute('aria-label', on ? '停止聆聽' : '繼續聆聽');
  $('#listen-state').textContent = on ? '聆聽中' : '已暫停';
  document.body.dataset.listening = on ? 'on' : '';
  if (!on) clearWaves();
}

function renderListenTurn(turn) {
  let el = turn._el;
  if (!el) {
    el = document.createElement('div');
    el.className = 'listen-turn';
    el.innerHTML = '<div class="dst"></div><div class="src"></div>';
    $('#listen-feed').appendChild(el);
    while ($('#listen-feed').children.length > 80) $('#listen-feed').firstChild.remove();
    turn._el = el;
  }
  el.querySelector('.dst').textContent = turn.dst;
  el.querySelector('.src').textContent = turn.src;
  $('#listen-feed').scrollTop = $('#listen-feed').scrollHeight;
}

/* ---------- 逐字稿檢視 ---------- */
async function openTranscript() {
  finalizeAllTurns();
  const turns = await store.all();
  const list = $('#tr-list');
  list.innerHTML = '';
  if (turns.length === 0) {
    list.innerHTML = '<p class="tr-empty">還沒有紀錄。逐字稿只存在這台裝置。</p>';
  }
  for (const t of turns.slice(-200)) {
    const div = document.createElement('div');
    div.className = `tr-turn ${t.side}`;
    const time = new Date(t.ts).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    div.innerHTML = '<div class="tr-meta"></div><div class="tr-src"></div><div class="tr-dst"></div>';
    div.querySelector('.tr-meta').textContent = `${time} · ${t.side === 'me' ? `中文 → ${t.dstLang}` : `${t.srcLang} → 中文`}`;
    div.querySelector('.tr-src').textContent = t.src;
    div.querySelector('.tr-dst').textContent = t.dst;
    list.appendChild(div);
  }
  $('#transcript').showModal();
  list.scrollTop = list.scrollHeight;
}

function bindTranscript() {
  $('#open-transcript').addEventListener('click', openTranscript);
  $('#tr-close').addEventListener('click', () => $('#transcript').close());
  $('#tr-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(formatTxt(await store.all())).catch(() => {});
    toast('逐字稿已複製。');
  });
  $('#tr-share').addEventListener('click', async () => {
    const text = formatTxt(await store.all());
    if (navigator.share) {
      await navigator.share({ title: '口譯機逐字稿', text }).catch(() => {});
    } else {
      await navigator.clipboard.writeText(text).catch(() => {});
      toast('此裝置不支援分享，已改為複製。');
    }
  });
  $('#tr-export').addEventListener('click', async () => {
    downloadTxt(`口譯逐字稿-${new Date().toISOString().slice(0, 10)}.txt`, formatTxt(await store.all()));
  });
  $('#tr-clear').addEventListener('click', async () => {
    if (confirm('確定清除所有逐字稿？')) {
      await store.clear();
      openTranscript();
    }
  });
}

/* ---------- 狀態顯示 ---------- */
function renderLive() {
  const states = ['toForeign', 'toMine'].map((t) => state.sessions[t]?.state).filter(Boolean);
  const connecting = states.includes('connecting') || states.includes('reconnecting');
  document.body.dataset.conn = connecting ? 'connecting' : states.includes('open') ? 'open' : 'idle';
  if (state.phase === 'listen' && connecting) $('#listen-state').textContent = '連線中…';
}

// 按鈕文字依操作模式與狀態切換（點擊式錄音中顯示「再點一下結束」）
function updateTalkLabels() {
  const lang = foreign();
  const toggle = settings.talkMode === 'toggle';
  const meText = state.holding === 'me' && toggle ? '⏹ 再點一下結束' : (toggle ? '點擊說話' : '按住說話');
  const themText = state.holding === 'them' && toggle ? `⏹ ${lang.ui.stop}` : (toggle ? lang.ui.tap : lang.ui.hold);
  $('#hold-me-label').textContent = meText;
  $('#hold-me').setAttribute('aria-label', meText);
  $('#hold-them-label').textContent = themText;
  $('#hold-them').setAttribute('aria-label', themText);
}

/* ---------- 語言 ---------- */
function renderLangUI() {
  const lang = foreign();
  $('#theirs-lang').textContent = lang.native;
  $('#theirs-live').textContent = lang.ui.live;
  $('#theirs-src-label').textContent = lang.ui.original;
  $('#replay-them').setAttribute('aria-label', lang.ui.replay);
  $('#replay-them').setAttribute('title', lang.ui.replay);
  updateTalkLabels();
  $('#pair-foreign').textContent = lang.native;
  $('#listen-lang').textContent = `${lang.native} → 中文`;
}

function fillLangSelect() {
  const sel = $('#foreign-lang');
  sel.innerHTML = '';
  for (const l of FOREIGN_LANGS) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = `${l.flag} ${l.name} ${l.native}`;
    sel.appendChild(opt);
  }
  sel.value = settings.foreignLang;
  sel.addEventListener('change', () => {
    settings = saveSettings({ foreignLang: sel.value });
    renderLangUI();
    // 換語言 → toForeign 連線下次建立時採用新目標
    state.sessions.toForeign?.close();
    state.sessions.toForeign = null;
  });
}

/* ---------- 省額度：閒置自動結束 ---------- */
setInterval(() => {
  const min = settings.idleDisconnectMin;
  if (!min || min <= 0 || state.phase === 'home') return;
  if (!state.holding && !state.listening && !audio.isSpeaking &&
      Date.now() - state.lastActivity > min * 60_000) {
    toast('閒置已自動結束（麥克風已關閉）。');
    endSession(true);
  }
}, 10_000);

/* ---------- Wake Lock ---------- */
async function acquireWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* unsupported */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.phase !== 'home') acquireWakeLock();
});

/* ---------- 設定 ---------- */
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', settings.theme === 'light' ? '#f4f6f9' : '#0e1116');
}

function openSettings(firstRun = false) {
  $('#welcome').classList.toggle('hidden', !firstRun);
  $('#set-key').value = settings.apiKey;
  $('#set-key2').value = settings.apiKeyThem;
  $('#set-demo').checked = settings.demoMode;
  $('#set-them-text').checked = settings.themTextOnly;
  $('#set-auto-disc').checked = settings.autoDisconnect;
  $('#set-talk-mode').value = settings.talkMode;
  $('#set-voice-after').checked = settings.voiceAfterRelease;
  $('#set-manual-play').checked = settings.manualPlay;
  $('#set-voice-ind').checked = settings.voiceIndicator;
  $('#set-voice-idle').value = settings.voiceIdleSec;
  $('#set-voice-max').value = settings.voiceMaxWaitSec;
  $('#set-tail').value = settings.silenceTailSec;
  syncVoiceParamLabels();
  $('#voice-params').classList.toggle('off', !settings.voiceAfterRelease);
  $('#set-theme').value = settings.theme;
  $('#set-font').value = settings.fontScale;
  $('#set-idle').value = settings.idleDisconnectMin;
  let u = {};
  try { u = JSON.parse(localStorage.getItem('kouyiji.usage') || '{}'); } catch { /* none */ }
  $('#usage-line').textContent = u.day ? `今日已用：送出 ${Math.round(u.sent || 0)} 秒、接收 ${Math.round(u.recv || 0)} 秒` : '今日尚未使用';
  $('#settings').showModal();
}

function syncVoiceParamLabels() {
  $('#lbl-voice-idle').textContent = Number($('#set-voice-idle').value).toFixed(1);
  $('#lbl-voice-max').textContent = String(Math.round($('#set-voice-max').value));
  $('#lbl-tail').textContent = Number($('#set-tail').value).toFixed(1);
}

function bindSettings() {
  $('#gear').addEventListener('click', () => openSettings(false));
  for (const id of ['set-voice-idle', 'set-voice-max', 'set-tail']) {
    $(`#${id}`).addEventListener('input', syncVoiceParamLabels);
  }
  $('#set-voice-after').addEventListener('change', (e) => {
    $('#voice-params').classList.toggle('off', !e.target.checked);
  });
  $('#settings-close').addEventListener('click', () => $('#settings').close());
  $('#settings-save').addEventListener('click', () => {
    settings = saveSettings({
      apiKey: $('#set-key').value.trim(),
      apiKeyThem: $('#set-key2').value.trim(),
      demoMode: $('#set-demo').checked,
      themTextOnly: $('#set-them-text').checked,
      autoDisconnect: $('#set-auto-disc').checked,
      talkMode: $('#set-talk-mode').value,
      voiceAfterRelease: $('#set-voice-after').checked,
      manualPlay: $('#set-manual-play').checked,
      voiceIndicator: $('#set-voice-ind').checked,
      voiceIdleSec: Math.min(3, Math.max(0.5, parseFloat($('#set-voice-idle').value) || 1.4)),
      voiceMaxWaitSec: Math.min(30, Math.max(3, parseFloat($('#set-voice-max').value) || 15)),
      silenceTailSec: Math.min(3, Math.max(0.5, parseFloat($('#set-tail').value) || 1.5)),
      theme: $('#set-theme').value,
      fontScale: parseFloat($('#set-font').value) || 1,
      idleDisconnectMin: Math.max(0, parseFloat($('#set-idle').value) || 0),
    });
    document.documentElement.style.setProperty('--font-scale', settings.fontScale);
    applyTheme();
    updateTalkLabels();
    if (!settings.voiceAfterRelease) audio.endVoiceHold(); // 關閉功能時放出可能的暫存
    closeSessions();
    $('#settings').close();
  });
  $('#demo-start').addEventListener('click', () => {
    settings = saveSettings({ demoMode: true });
    $('#settings').close();
    toast('Demo 模式已開啟，按「開始對話」試玩。');
  });
  $('#open-voicelog').addEventListener('click', () => {
    renderVoiceLog($('#vlog-list'));
    $('#voicelog').showModal();
  });
  $('#vlog-close').addEventListener('click', () => $('#voicelog').close());
  $('#run-diag').addEventListener('click', async () => {
    const box = $('#diag-results');
    box.classList.remove('hidden');
    box.textContent = '診斷中…（約 15 秒，請允許麥克風）';
    const render = (results) => {
      box.innerHTML = '';
      for (const r of results) {
        const div = document.createElement('div');
        div.className = `diag-row ${r.ok ? 'ok' : 'bad'}`;
        div.textContent = `${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`;
        box.appendChild(div);
      }
    };
    const results = await runDiagnostics(settings, render);
    render(results);
    const btn = $('#copy-diag');
    btn.classList.remove('hidden');
    btn.onclick = async () => {
      await navigator.clipboard.writeText(formatDiagnostics(results)).catch(() => {});
      toast('診斷結果已複製。');
    };
  });
}

/* ---------- 首頁 ---------- */
function bindHome() {
  for (const btn of document.querySelectorAll('#mode-seg .seg')) {
    btn.addEventListener('click', () => {
      state.mode = btn.dataset.mode;
      for (const b of document.querySelectorAll('#mode-seg .seg')) {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', String(active));
      }
      $('#mode-hint').textContent = state.mode === 'call'
        ? '兩人面對面：手機平放中間，各自按住自己那側說話'
        : '聽演講、導覽：對方的外語即時變成中文字幕';
      $('#start-label').textContent = state.mode === 'call' ? '開始對話' : '開始聆聽';
    });
  }
  $('#start-btn').addEventListener('click', () => {
    if (!settings.apiKey && !settings.demoMode) { openSettings(true); return; }
    startSession(state.mode);
  });
  $('#end-call').addEventListener('click', () => endSession());
  $('#listen-end').addEventListener('click', () => endSession());
  $('#listen-toggle').addEventListener('click', () => setListening(!state.listening));
  $('#pair').addEventListener('click', () => {
    toast('要換語言請先結束通話，回首頁選擇。', 3500);
  });
  $('#manual-play').addEventListener('click', manualPlayNow);
  $('#replay-them').addEventListener('click', replayLast);
}

/* ---------- 啟動 ---------- */
function boot() {
  $('#ver').textContent = self.APP_VERSION || '?';
  document.documentElement.style.setProperty('--font-scale', settings.fontScale);
  applyTheme();
  fillLangSelect();
  renderLangUI();
  bindHold($('#hold-me'), 'me');
  bindHold($('#hold-them'), 'them');
  bindHome();
  bindSettings();
  bindTranscript();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (!settings.apiKey && !settings.demoMode) openSettings(true);
  window.__kouyiji = { audio, state, store, vlog, hooks: { beginAwaitVoice }, get settings() { return settings; } };
}

boot();

// 語音記錄 —— 把每一輪翻譯語音「逐條」記下來並視覺化：
// 每條語音第幾條、什麼時候從網路到達、什麼時候真正播出、缺口發生在哪，
// 讓「明明是本機暫存為什麼還會斷」不再用猜的，打開記錄一看就知道。
//
// 只存在記憶體（最近 12 輪），結束通話後回首頁 → 設定 → 🎧 語音記錄 查看。

const MAX_TURNS = 12;

export const vlog = {
  turns: [], // 最新在前
  cur: null,
};

// 一輪開始（按下說話鈕）
export function vlogBegin(meta) {
  vlog.cur = {
    ...meta, // {tag, dir}
    startedAt: Date.now(),
    t0: performance.now(),
    chunks: [], // {idx, arriveMs, durMs, held, playMs?, gapMs?}
    marks: [], // {type, ms, reason?}
  };
  vlog.turns.unshift(vlog.cur);
  if (vlog.turns.length > MAX_TURNS) vlog.turns.pop();
}

// 時間軸標記：release(放開)/voice-start(開播)/turn-complete/recycle/interrupted/suspend
export function vlogMark(type, extra = {}) {
  const t = vlog.cur;
  if (!t) return;
  t.marks.push({ type, ms: performance.now() - t.t0, ...extra });
}

// audio.js 的儀表事件（arrive=到達、play=排入播放、suspend=系統暫停音訊）
export function vlogAudio(ev) {
  const t = vlog.cur;
  if (!t) return;
  if (ev.type === 'arrive') {
    t.chunks.push({ idx: ev.idx, arriveMs: performance.now() - t.t0, durMs: ev.sec * 1000, held: ev.held });
  } else if (ev.type === 'play') {
    const c = t.chunks.find((x) => x.idx === ev.idx);
    if (c) { c.playMs = ev.atMs - t.t0; c.gapMs = ev.gapMs; }
  } else if (ev.type === 'suspend') {
    vlogMark('suspend');
  }
}

/* ---------- 呈現 ---------- */

const REASONS = {
  'turn-complete': '伺服器完成訊號',
  idle: '文字與語音靜止',
  maxwait: '超時保險絲',
  instant: '即播模式（未暫存）',
  manual: '手動按下播放',
};

function fmtS(ms) { return (ms / 1000).toFixed(1); }

// 自動診斷：把數據翻成一句人話
function diagnose(t) {
  if (t.textOnly) {
    return [{ ok: true, text: '✓ 純文字模式（此方向不使用語音，僅字幕）。' }];
  }
  const voiceStart = t.marks.find((m) => m.type === 'voice-start');
  const played = t.chunks.filter((c) => c.playMs != null);
  const late = voiceStart ? t.chunks.filter((c) => c.arriveMs > voiceStart.ms + 50) : [];
  const gaps = played.filter((c) => (c.gapMs || 0) > 30);
  const suspends = t.marks.filter((m) => m.type === 'suspend').length;
  const out = [];
  if (t.chunks.length === 0) {
    out.push({ ok: false, text: '這一輪沒有收到任何語音資料（連線問題或伺服器沒有回覆語音）。' });
    return out;
  }
  if (late.length > 0) {
    out.push({ ok: false, text: `⚠️ 開播後仍有 ${late.length} 條（第 ${late.map((c) => c.idx).join('、')} 條）還在從網路到達 → 尾段容易斷。建議把「完整判定」秒數調高。` });
  }
  if (gaps.length > 0) {
    out.push({ ok: false, text: `⚠️ 播放中出現 ${gaps.length} 次缺口：第 ${gaps.map((c) => `${c.idx}（缺 ${Math.round(c.gapMs)}ms）`).join('、')} 條之前。` });
  }
  if (suspends > 0) {
    out.push({ ok: false, text: `⚠️ 播放中系統暫停過音訊 ${suspends} 次（切出 app、來電、接上/斷開藍牙耳機都會造成）。` });
  }
  if (out.length === 0) {
    out.push({ ok: true, text: `✅ 全部 ${t.chunks.length} 條在開播前已到齊，播放連續、無缺口 —— 若仍聽到斷音，多半是系統層（藍牙/擴音切換）造成。` });
  }
  return out;
}

export function renderVoiceLog(container) {
  container.innerHTML = '';
  if (vlog.turns.length === 0) {
    container.innerHTML = '<p class="tr-empty">還沒有記錄。開始對話並說一句話後，這裡會逐條列出翻譯語音的到達與播放狀況。</p>';
    return;
  }
  for (const t of vlog.turns) {
    const voiceStart = t.marks.find((m) => m.type === 'voice-start');
    const release = t.marks.find((m) => m.type === 'release');
    const totalSec = t.chunks.reduce((s, c) => s + c.durMs, 0) / 1000;
    const time = new Date(t.startedAt).toLocaleTimeString('zh-TW', { hour12: false });

    const div = document.createElement('div');
    div.className = 'vlog-turn';

    const head = document.createElement('div');
    head.className = 'vlog-head';
    head.textContent = `${time} · ${t.dir} · 語音 ${t.chunks.length} 條 / ${totalSec.toFixed(1)} 秒`
      + (voiceStart ? ` · 開播：${REASONS[voiceStart.reason] || voiceStart.reason || '—'}` : ' · （未開播）');
    div.appendChild(head);

    for (const d of diagnose(t)) {
      const p = document.createElement('p');
      p.className = `vlog-diag ${d.ok ? 'ok' : 'bad'}`;
      p.textContent = d.text;
      div.appendChild(p);
    }

    // 時間軸：上排＝網路到達、下排＝實際播放
    const scale = Math.max(
      1000,
      ...t.chunks.map((c) => c.arriveMs + c.durMs),
      ...t.chunks.filter((c) => c.playMs != null).map((c) => c.playMs + c.durMs),
      ...t.marks.map((m) => m.ms),
    );
    const tl = document.createElement('div');
    tl.className = 'vlog-tl';
    // 軌道與標記線共用同一個定位容器，百分比座標才會對齊
    const tracks = document.createElement('div');
    tracks.className = 'vlog-tracks';
    const pct = (ms) => `${Math.min(100, (ms / scale) * 100).toFixed(2)}%`;
    const w = (ms) => `${Math.max(0.6, (ms / scale) * 100).toFixed(2)}%`;

    const rowA = document.createElement('div');
    rowA.className = 'vlog-row';
    rowA.dataset.label = '到達';
    const rowP = document.createElement('div');
    rowP.className = 'vlog-row';
    rowP.dataset.label = '播放';
    for (const c of t.chunks) {
      const a = document.createElement('i');
      a.className = 'vlog-blk arrive';
      a.style.left = pct(c.arriveMs);
      a.style.width = w(c.durMs);
      a.title = `#${c.idx} 到達 ${fmtS(c.arriveMs)}s（${Math.round(c.durMs)}ms）`;
      rowA.appendChild(a);
      if (c.playMs != null) {
        const p = document.createElement('i');
        p.className = `vlog-blk play${(c.gapMs || 0) > 30 ? ' gap' : ''}`;
        p.style.left = pct(c.playMs);
        p.style.width = w(c.durMs);
        p.title = `#${c.idx} 播出 ${fmtS(c.playMs)}s${c.gapMs > 30 ? `，前有 ${Math.round(c.gapMs)}ms 缺口` : ''}`;
        rowP.appendChild(p);
      }
    }
    tracks.appendChild(rowA);
    tracks.appendChild(rowP);
    // 標記線：放開、開播、系統暫停
    const markDefs = [
      [release, 'release', '放開'],
      [voiceStart, 'voice', '開播'],
    ];
    for (const m of t.marks.filter((x) => x.type === 'suspend')) markDefs.push([m, 'suspend', '暫停']);
    for (const [m, cls, label] of markDefs) {
      if (!m) continue;
      const el = document.createElement('span');
      el.className = `vlog-mark ${cls}`;
      el.style.left = pct(m.ms);
      el.dataset.label = label;
      tracks.appendChild(el);
    }
    tl.appendChild(tracks);
    div.appendChild(tl);

    // 逐條明細（可展開）
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = '逐條明細';
    det.appendChild(sum);
    const table = document.createElement('table');
    table.className = 'vlog-table';
    table.innerHTML = '<thead><tr><th>#</th><th>到達</th><th>長度</th><th>播出</th><th>備註</th></tr></thead>';
    const tbody = document.createElement('tbody');
    for (const c of t.chunks) {
      const tr = document.createElement('tr');
      const notes = [];
      if (c.held) notes.push('暫存');
      if (voiceStart && c.arriveMs > voiceStart.ms + 50) notes.push('開播後才到');
      if ((c.gapMs || 0) > 30) notes.push(`⚠️ 缺口 ${Math.round(c.gapMs)}ms`);
      tr.innerHTML = `<td>${c.idx}</td><td>${fmtS(c.arriveMs)}s</td><td>${Math.round(c.durMs)}ms</td>`
        + `<td>${c.playMs != null ? fmtS(c.playMs) + 's' : '—'}</td><td>${notes.join('、') || '正常'}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    det.appendChild(table);
    div.appendChild(det);

    container.appendChild(div);
  }
}

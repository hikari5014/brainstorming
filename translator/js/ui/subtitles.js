// 字幕分段器 + 渲染。
// Live API 的轉錄是連續小碎片；這裡把碎片累積成「進行中的一句」，
// 在停頓（gap）或 turn-complete 時定稿、進歷史列與逐字稿。

import { langName } from '../languages.js';

const GAP_MS = 1500;
const MAX_HISTORY = 200;

export class Segmenter {
  constructor({ onLive, onFinal }) {
    this.onLive = onLive;
    this.onFinal = onFinal;
    this.current = new Map(); // key: `${tag}:${kind}` → {tag, kind, text, lang, ts, timer}
  }

  feed({ tag, kind, text, languageCode }) {
    const key = `${tag}:${kind}`;
    let seg = this.current.get(key);
    if (!seg) {
      seg = { tag, kind, text: '', lang: languageCode || '', ts: Date.now(), timer: null };
      this.current.set(key, seg);
    }
    seg.text += text;
    if (languageCode) seg.lang = languageCode;
    clearTimeout(seg.timer);
    seg.timer = setTimeout(() => this.finalize(key), GAP_MS);
    this.onLive?.(seg);
  }

  finalize(key) {
    const seg = this.current.get(key);
    if (!seg) return;
    clearTimeout(seg.timer);
    this.current.delete(key);
    if (seg.text.trim()) this.onFinal?.({ ...seg, endTs: Date.now() });
  }

  finalizeAll() {
    for (const key of [...this.current.keys()]) this.finalize(key);
  }
}

// 一個字幕面板：進行中的原文/譯文大字 + 歷史列表
export class SubtitlePanel {
  constructor(root) {
    this.root = root;
    this.history = root.querySelector('.sub-history');
    this.liveSrc = root.querySelector('.live-src');
    this.liveDst = root.querySelector('.live-dst');
  }

  updateLive(seg) {
    const el = seg.kind === 'input' ? this.liveSrc : this.liveDst;
    if (!el) return;
    el.textContent = seg.text;
    el.dataset.lang = seg.lang || '';
    el.classList.add('active');
  }

  pushFinal(seg) {
    const el = seg.kind === 'input' ? this.liveSrc : this.liveDst;
    if (el) {
      el.textContent = '';
      el.classList.remove('active');
    }
    if (!this.history) return;
    const row = document.createElement('div');
    row.className = `sub-row ${seg.kind}`;
    const langLabel = seg.lang ? `<span class="lang-chip">${langName(seg.lang)}</span>` : '';
    row.innerHTML = `${langLabel}<span class="sub-text"></span>`;
    row.querySelector('.sub-text').textContent = seg.text;
    this.history.appendChild(row);
    while (this.history.children.length > MAX_HISTORY) this.history.firstChild.remove();
    this.history.scrollTop = this.history.scrollHeight;
  }

  clear() {
    if (this.history) this.history.innerHTML = '';
    for (const el of [this.liveSrc, this.liveDst]) {
      if (el) {
        el.textContent = '';
        el.classList.remove('active');
      }
    }
  }
}

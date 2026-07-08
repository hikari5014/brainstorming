// 逐字稿：IndexedDB 儲存已定稿的字幕段落，支援 .txt / .srt 匯出。

const DB_NAME = 'liveTranslator';
const STORE = 'segments';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class TranscriptStore {
  constructor() {
    this.dbPromise = openDb().catch(() => null);
  }

  // segment: {ts, endTs, mode, kind, lang, text}
  async add(segment) {
    const db = await this.dbPromise;
    if (!db) return;
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(segment);
  }

  async all() {
    const db = await this.dbPromise;
    if (!db) return [];
    return new Promise((resolve) => {
      const out = [];
      const tx = db.transaction(STORE, 'readonly');
      const cursorReq = tx.objectStore(STORE).index('ts').openCursor();
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (cur) {
          out.push(cur.value);
          cur.continue();
        } else resolve(out);
      };
      cursorReq.onerror = () => resolve(out);
    });
  }

  async clear() {
    const db = await this.dbPromise;
    if (!db) return;
    db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
  }

  async exportTxt() {
    const rows = await this.all();
    const lines = rows.map((r) => {
      const time = new Date(r.ts).toLocaleString('zh-TW', { hour12: false });
      const label = r.kind === 'input' ? '原文' : '譯文';
      return `[${time}] [${r.mode}] [${label}${r.lang ? ' ' + r.lang : ''}] ${r.text}`;
    });
    return lines.join('\n');
  }

  // 只取譯文段落做 SRT 字幕
  async exportSrt() {
    const rows = (await this.all()).filter((r) => r.kind === 'output');
    if (rows.length === 0) return '';
    const t0 = rows[0].ts;
    const fmt = (ms) => {
      const total = Math.max(0, ms);
      const h = String(Math.floor(total / 3600000)).padStart(2, '0');
      const m = String(Math.floor((total % 3600000) / 60000)).padStart(2, '0');
      const s = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
      const cs = String(Math.floor(total % 1000)).padStart(3, '0');
      return `${h}:${m}:${s},${cs}`;
    };
    return rows
      .map((r, i) => {
        const start = r.ts - t0;
        const end = (r.endTs || r.ts + 2500) - t0;
        return `${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${r.text}\n`;
      })
      .join('\n');
  }
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

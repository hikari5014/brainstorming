// 逐字稿留存：IndexedDB 儲存每個回合（時間、方向、原文、譯文）。
// 商務情境的價值：結束後可查閱、複製、分享、匯出 .txt。

const DB = 'kouyiji';
const STORE = 'turns';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }).createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class TranscriptStore {
  constructor() {
    this.dbp = openDb().catch(() => null);
  }

  // turn: {ts, mode, side, srcLang, dstLang, src, dst}
  async add(turn) {
    const db = await this.dbp;
    if (!db) return;
    db.transaction(STORE, 'readwrite').objectStore(STORE).add(turn);
  }

  async all() {
    const db = await this.dbp;
    if (!db) return [];
    return new Promise((resolve) => {
      const out = [];
      const cur = db.transaction(STORE, 'readonly').objectStore(STORE).index('ts').openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { out.push(c.value); c.continue(); } else resolve(out);
      };
      cur.onerror = () => resolve(out);
    });
  }

  async clear() {
    const db = await this.dbp;
    if (!db) return;
    db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
  }
}

export function formatTxt(turns) {
  return turns.map((t) => {
    const time = new Date(t.ts).toLocaleString('zh-TW', { hour12: false });
    const dir = t.side === 'me' ? `中文 → ${t.dstLang}` : `${t.srcLang} → 中文`;
    return `[${time}] [${dir}]\n原文：${t.src}\n譯文：${t.dst}\n`;
  }).join('\n');
}

export function downloadTxt(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

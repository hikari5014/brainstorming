// 逐字稿留存：IndexedDB 儲存每個回合（時間、方向、原文、譯文）。
// 商務情境的價值：結束後可查閱、複製、分享、匯出 .txt。
// v14 起同一個資料庫加開 phrases store：常用句（中文＋外語＋語音 PCM）。

const DB = 'kouyiji';
const STORE = 'turns';
const PHRASES = 'phrases';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }).createIndex('ts', 'ts');
      }
      if (!db.objectStoreNames.contains(PHRASES)) {
        db.createObjectStore(PHRASES, { keyPath: 'id', autoIncrement: true }).createIndex('lang', 'lang');
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

  // turn: {ts, mode, side, srcLang, dstLang, src, dst, ...}；回傳新列 id（AI 潤飾後回頭更新用）
  async add(turn) {
    const db = await this.dbp;
    if (!db) return null;
    return new Promise((resolve) => {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).add(turn);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  async updateTurn(id, patch) {
    const db = await this.dbp;
    if (!db || id == null) return;
    const os = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const req = os.get(id);
    req.onsuccess = () => {
      if (req.result) os.put({ ...req.result, ...patch });
    };
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

  /* ---- 常用句：{id, ts, lang, src(中文), dst(外語), pcm(ArrayBuffer|null), secs, uses, lastUsed, pinned} ---- */

  async addPhrase(phrase) {
    const db = await this.dbp;
    if (!db) return null;
    return new Promise((resolve) => {
      const req = db.transaction(PHRASES, 'readwrite').objectStore(PHRASES).add(phrase);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }

  async allPhrases() {
    const db = await this.dbp;
    if (!db) return [];
    return new Promise((resolve) => {
      const out = [];
      const cur = db.transaction(PHRASES, 'readonly').objectStore(PHRASES).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { out.push(c.value); c.continue(); } else resolve(out);
      };
      cur.onerror = () => resolve(out);
    });
  }

  async updatePhrase(id, patch) {
    const db = await this.dbp;
    if (!db) return;
    const store = db.transaction(PHRASES, 'readwrite').objectStore(PHRASES);
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) store.put({ ...req.result, ...patch });
    };
  }

  async deletePhrase(id) {
    const db = await this.dbp;
    if (!db) return;
    db.transaction(PHRASES, 'readwrite').objectStore(PHRASES).delete(id);
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

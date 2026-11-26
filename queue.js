// 送る前の写真を IndexedDB に置く。電波が無くても撮れて、アプリを閉じても消えない
const DB = 'experiphoto';
const STORE = 'queue';

function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      db.close();
      resolve(req?.result);
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
    t.onabort = () => {
      db.close();
      reject(t.error || new Error('保存できませんでした'));
    };
  });
}

export const put = (job) => run('readwrite', (s) => s.put(job));
export const remove = (id) => run('readwrite', (s) => s.delete(id));
export const get = (id) => run('readonly', (s) => s.get(id));
export const all = async () => ((await run('readonly', (s) => s.getAll())) || []).sort((a, b) => a.addedAt - b.addedAt);

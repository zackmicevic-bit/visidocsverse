// VisiDocsVerse original-file sidecar: binary store for uploaded originals.
// Vault docs live in localStorage (small text JSON, ~5MB quota), so original
// BYTES must never go there — a single PDF would evict the whole workspace.
// Files live here in IndexedDB (large quota, File/Blob structured-clone safe);
// docs carry only the tiny pointer `origKey`. Cloud/master backups serialize
// vault JSON, so restored docs keep the pointer but byte-misses download as
// extracted text (.txt) instead. Docs imported before this store existed have
// no origKey and take the same .txt fallback.
const DBN = 'visidocsverse-orig', ST = 'originals', VER = 1;
let dbp = null;
function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    let q;
    try { q = indexedDB.open(DBN, VER); }
    catch (e) { rej(e); return; }
    q.onupgradeneeded = () => { q.result.createObjectStore(ST, { keyPath: 'key' }); };
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error || new Error('origdb open failed'));
  });
  return dbp;
}
function txDo(mode, fn) {
  return openDb().then(db => new Promise((res, rej) => {
    let tx;
    try { tx = db.transaction(ST, mode); }
    catch (e) { rej(e); return; }
    const out = fn(tx.objectStore(ST));
    tx.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
    tx.onerror = () => rej(tx.error || new Error('origdb tx failed'));
  }));
}
export async function origPut(rec) { await txDo('readwrite', st => st.put(rec)); }
export async function origGet(key) { return await txDo('readonly', st => st.get(key)) || null; }
export async function origKeys() { return await txDo('readonly', st => st.getAllKeys()) || []; }
export async function origDelete(key) { await txDo('readwrite', st => st.delete(key)); }

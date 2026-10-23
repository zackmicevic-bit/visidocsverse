// VisiDocsVerse image sidecar: binary store for document images (Word/PPT/PDF).
// Vault docs live in localStorage (small text JSON, ~5MB quota), so image BYTES
// must never go there — one photo would evict the whole workspace. Blobs live
// here in IndexedDB (large quota, structured-clone safe); docs carry only tiny
// metadata rows {key, cap, w, h}. Cloud/master backups serialize vault JSON, so
// restored docs keep their metadata but byte-misses hydrate as placeholders.
const DBN = 'visidocsverse-img', OLD_DBN = 'docuverse-img', ST = 'images', VER = 1;
let dbp = null;
function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    let q;
    try { q = indexedDB.open(DBN, VER); }
    catch (e) { rej(e); return; }
    q.onupgradeneeded = () => { q.result.createObjectStore(ST, { keyPath: 'key' }); };
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error || new Error('imgdb open failed'));
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
    tx.onerror = () => rej(tx.error || new Error('imgdb tx failed'));
  }));
}
export async function imgPut(rec) { await txDo('readwrite', st => st.put(rec)); }
export async function imgGet(key) { return await txDo('readonly', st => st.get(key)) || null; }
export async function imgKeys() { return await txDo('readonly', st => st.getAllKeys()) || []; }
export async function imgDelete(key) { await txDo('readwrite', st => st.delete(key)); }
// VisiDocsVerse rename: one-time copy of pre-release image bytes into the new store.
export async function migrateImageDB() {
  if (DBN === OLD_DBN) return;
  let recs = [];
  try {
    const old = await new Promise((res, rej) => {
      let q; try { q = indexedDB.open(OLD_DBN, VER); } catch (e) { rej(e); return; }
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error || new Error('old imgdb open failed'));
    });
    try {
      if (!old.objectStoreNames.contains(ST)) { old.close(); return; }
      recs = await new Promise((res, rej) => {
        let tx; try { tx = old.transaction(ST, 'readonly'); } catch (e) { rej(e); return; }
        const rq = tx.objectStore(ST).getAll();
        rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
      });
    } finally { try { old.close(); } catch {} }
  } catch { return; }
  if (!recs.length) return;
  let have = [];
  try { have = await imgKeys(); } catch { have = []; }
  const seen = new Set(have);
  for (const rec of recs) {
    if (rec && rec.key != null && !seen.has(rec.key)) { try { await imgPut(rec); } catch {} }
  }
}

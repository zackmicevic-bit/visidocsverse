// VisiDocsverse disk vault — originals on the user's hard drive (desktop installs).
//
// Added so books of ANY length import in their entirety: the IndexedDB sidecar
// (origstore.js) stays the web fallback with its 100MB safety cap, but on a
// desktop shell every upload's full bytes are filed in an app vault folder on
// disk — no size cap, no silent omission. Entries are keyed by the doc's
// origKey (`orig_…`), so copies across canvases share one file, and the purge
// sweep deletes files nobody references anymore.
//
// Offline-safe by construction: the Tauri JS bindings are vendored locally
// (src/vendor/tauri-*.bundle.mjs — no CDN, no network). Off-desktop
// (web preview, shells without Tauri IPC) every entry point resolves to
// {ok:false} / null and the caller falls back to the IndexedDB sidecar.

const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;
const FILE_RE = /^[A-Za-z0-9_-]{1,128}\.[a-z0-9]{1,8}$/;

let fsMod = null, pathMod = null;
let loadTried = false;
let dirCache = null;    // absolute vault dir, once resolved
let usableCache = null; // true/false once probed (session-scoped)

export function diskIpcPresent() {
  try {
    return !!(window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function');
  } catch { return false; }
}

async function bindings() {
  if (fsMod && pathMod) return { fs: fsMod, path: pathMod };
  if (!diskIpcPresent()) return null;
  if (loadTried) return null;
  loadTried = true;
  try {
    const [fs, path] = await Promise.all([
      import('./vendor/tauri-plugin-fs.bundle.mjs'),
      import('./vendor/tauri-api-path.bundle.mjs'),
    ]);
    if (!fs || !path || typeof fs.writeFile !== 'function' || typeof path.appLocalDataDir !== 'function') return null;
    fsMod = fs; pathMod = path;
    return { fs, path };
  } catch (e) {
    console.warn('disk vault unavailable (Tauri bindings failed to load)', (e && e.message) || e);
    return null;
  }
}

// Absolute vault dir, e.g. <AppLocalData>/VisiDocsverse Vault/originals/
export async function diskVaultDir() {
  if (dirCache) return dirCache;
  const b = await bindings();
  if (!b) throw new Error('no Tauri IPC');
  const base = await b.path.appLocalDataDir();
  const join = b.path.join || ((...parts) => parts.join('/'));
  dirCache = await join(base, 'VisiDocsverse Vault', 'originals');
  return dirCache;
}

// Session-cached probe: bindings load + vault dir creatable.
export async function diskUsable() {
  if (usableCache === true) return true;
  // No IPC in this shell (web preview): stay off quietly — the caller falls
  // back to the browser sidecar. A failed probe while IPC exists retries,
  // so a late-initializing bridge still comes online.
  if (usableCache === false && !diskIpcPresent()) return false;
  try {
    const b = await bindings();
    if (!b) { usableCache = false; return false; }
    const dir = await diskVaultDir();
    await b.fs.mkdir(dir, { recursive: true });
    usableCache = true;
    return true;
  } catch (e) {
    console.warn('disk vault unavailable (probe failed)', (e && e.message) || e);
    usableCache = false;
    return false;
  }
}

export function diskFileName(key, docName) {
  const k = String(key || '');
  if (!KEY_RE.test(k)) throw new Error('bad original key');
  const m = String(docName || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return k + (m ? '.' + m[1] : '.bin');
}

const MIME_BY_EXT = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', m4v: 'video/x-m4v', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/opus',
  txt: 'text/plain', md: 'text/markdown',
  markdown: 'text/markdown', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function mimeFor(file) {
  const m = String(file || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return (m && MIME_BY_EXT[m[1]]) || 'application/octet-stream';
}

// Store a File/Blob under key. Returns the stored filename. Throws on failure.
export async function diskPut(key, blob, docName) {
  const b = await bindings();
  if (!b) throw new Error('no Tauri IPC');
  const dir = await diskVaultDir();
  await b.fs.mkdir(dir, { recursive: true });
  const file = diskFileName(key, docName);
  const join = b.path.join || ((...parts) => parts.join('/'));
  const full = await join(dir, file);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.length) throw new Error('empty file');
  await b.fs.writeFile(full, bytes);
  usableCache = true;
  return file;
}

function pickFile(key, fileOrName, entries) {
  const k = String(key || '');
  if (fileOrName && FILE_RE.test(String(fileOrName)) && String(fileOrName).startsWith(k)) return String(fileOrName);
  if (Array.isArray(entries)) {
    for (const e of entries) {
      const nm = e && (e.name || (typeof e === 'string' ? e : ''));
      if (typeof nm === 'string' && nm.startsWith(k) && FILE_RE.test(nm)) return nm;
    }
  }
  return null;
}

// Read the stored bytes as a Blob, or null when missing/unreadable.
export async function diskGetBlob(key, fileOrName) {
  const k = String(key || '');
  if (!KEY_RE.test(k)) return null;
  const b = await bindings();
  if (!b) return null;
  try {
    const dir = await diskVaultDir();
    const join = b.path.join || ((...parts) => parts.join('/'));
    let file = (fileOrName && FILE_RE.test(String(fileOrName)) && String(fileOrName).startsWith(k))
      ? String(fileOrName) : null;
    if (!file) {
      let entries = [];
      try { entries = await b.fs.readDir(dir); } catch { entries = []; }
      file = pickFile(k, null, entries);
      if (!file) return null;
    }
    const full = await join(dir, file);
    const data = await b.fs.readFile(full);
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data || []);
    if (!bytes.length) return null;
    return new Blob([bytes], { type: mimeFor(file) });
  } catch (e) {
    console.warn('disk vault read missed for ' + k, (e && e.message) || e);
    return null;
  }
}

export async function diskDelete(key, fileOrName) {
  const k = String(key || '');
  if (!KEY_RE.test(k)) return;
  const b = await bindings();
  if (!b) return;
  try {
    const dir = await diskVaultDir();
    const join = b.path.join || ((...parts) => parts.join('/'));
    let file = (fileOrName && FILE_RE.test(String(fileOrName)) && String(fileOrName).startsWith(k))
      ? String(fileOrName) : null;
    if (!file) {
      let entries = [];
      try { entries = await b.fs.readDir(dir); } catch { entries = []; }
      file = pickFile(k, null, entries);
      if (!file) return;
    }
    await b.fs.remove(await join(dir, file));
  } catch { /* already gone — orphan sweeps are best-effort */ }
}

// Every stored origKey (filenames are <key>.<ext>).
export async function diskListKeys() {
  const b = await bindings();
  if (!b) return [];
  try {
    const dir = await diskVaultDir();
    let entries = [];
    try { entries = await b.fs.readDir(dir); } catch { return []; }
    const out = [];
    for (const e of entries) {
      const nm = e && (e.name || (typeof e === 'string' ? e : ''));
      if (typeof nm !== 'string') continue;
      const m = nm.match(/^([A-Za-z0-9_-]{1,128})\.[a-z0-9]{1,8}$/);
      if (m) out.push(m[1]);
    }
    return out;
  } catch { return []; }
}

// Human-readable vault location for toasts (last two path segments).
export async function diskVaultLabel() {
  try {
    const dir = await diskVaultDir();
    const parts = String(dir).replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/');
  } catch { return 'app vault'; }
}

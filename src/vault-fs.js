// VisiDocsVerse vault-folder backend (desktop installers only).
//
// The app's live stores stay exactly as they are — vault text in localStorage,
// image/original bytes in IndexedDB sidecars — and the linked folder is a
// durable, human-readable MIRROR written one way only (app -> disk,
// fire-and-forget, never read back during normal use). A dead drive, a rename
// in Finder, or a mid-sync Dropbox can never break the running universe.
//
// Why raw invoke and not the @tauri-apps JS packages: the desktop export is a
// plain file copy (no bundler — see src/tools/desktop/README-DESKTOP.md), so
// bare npm specifiers wouldn't resolve. `window.__TAURI__.core.invoke` is the
// documented low-level transport the plugin wrappers themselves use, and it
// needs zero frontend dependencies. Every command below degrades to a status
// code (never throws), and on non-desktop shells every entry point reports
// 'unavailable' so the web build runs byte-identical code paths.
// Required Rust side (build machine): tauri-plugin-fs + tauri-plugin-dialog +
// tauri-plugin-opener in main.rs / Cargo.toml, with capabilities granting
// fs read/write/mkdir/remove/stat/read-dir under $HOME/**, dialog open, and
// opener open-path + reveal-item-in-dir. The desktop smoke checklist in
// README-DESKTOP.md verifies each command name used here.
const DIR_KEY = 'visidocsverse.vaultDir'; // localStorage: the linked folder's absolute path
const MIRROR_MAX = 25 * 1024 * 1024; // per-file mirror cap (bigger originals stay IndexedDB-only)
const CHUNK = 2 * 1024 * 1024; // write_file payloads are JSON number arrays — chunk them

export function isDesktopShell() {
  try {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__) return true;
    const p = String(location.protocol || '').toLowerCase();
    if (p === 'tauri:' || p === 'wry:' || p === 'app:') return true;
    const ua = String(navigator.userAgent || '').toLowerCase();
    if (ua.includes(' tauri/') || ua.includes('electron/') || ua.includes(' wry/')) return true;
  } catch { /* default below */ }
  return false;
}

function invokeFn() {
  try {
    const f = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;
    return (typeof f === 'function') ? f.bind(window.__TAURI__.core) : null;
  } catch { return null; }
}
export function isVaultBackendAvailable() { return isDesktopShell() && !!invokeFn(); }
async function ti(cmd, args) { return await invokeFn()(cmd, args || {}); }

export function getVaultDir() {
  try { return (localStorage.getItem(DIR_KEY) || '').trim() || null; }
  catch { return null; }
}
function setVaultDir(p) {
  try { if (p) localStorage.setItem(DIR_KEY, p); else localStorage.removeItem(DIR_KEY); } catch {}
}

// Finder-safe file name for a body: keep the user's real name (extension and
// all), replacing only characters no OS allows. Same spirit as vault.rename.
export function fileNameFor(name) {
  let s = String(name || 'untitled').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/[. ]+$/, '').trim();
  if (!s) s = 'untitled';
  return s.slice(0, 120);
}
const join = (dir, file) => String(dir).replace(/\/+$/, '') + '/' + file;
const ORIG_DIR = (dir) => join(dir, 'originals');

// Link flow: picker -> verify writability (mkdir + probe files) -> persist.
// Returns {dir} | {cancelled} | {error}. Never throws.
export async function linkVaultDir() {
  if (!isVaultBackendAvailable()) return { error: 'desktop-only' };
  let dir = null;
  try {
    const picked = await ti('plugin:dialog|open', { options: { directory: true, multiple: false, title: 'Choose vault folder' } });
    if (!picked) return { cancelled: true };
    dir = Array.isArray(picked) ? picked[0] : picked;
    if (!dir) return { cancelled: true };
  } catch (e) { return { error: 'picker-blocked' }; }
  try {
    await ti('plugin:fs|mkdir', { path: ORIG_DIR(dir), recursive: true });
    setVaultDir(String(dir));
    return { dir: String(dir) };
  } catch (e) { return { error: 'not-writable' }; }
}
export function unlinkVaultDir() { setVaultDir(null); }

// Linked AND still usable (drive plugged in, folder not deleted).
export async function checkLinked() {
  const dir = getVaultDir();
  if (!dir || !isVaultBackendAvailable()) return { linked: false, dir: null, ok: false };
  try {
    const ok = await ti('plugin:fs|exists', { path: ORIG_DIR(dir) });
    return { linked: true, dir, ok: !!ok };
  } catch { return { linked: true, dir, ok: false }; }
}

// Mirror one original's bytes to originals/<fileName>. Returns a status code
// for the caller's toast wording. Never throws.
export async function mirrorBytes(fileName, blob) {
  if (!isVaultBackendAvailable()) return 'unavailable';
  const st = await checkLinked();
  if (!st.linked) return 'unlinked';
  if (!st.ok) return 'missing';
  try {
    if (!blob || !(blob.size > 0)) return 'failed';
    if (blob.size > MIRROR_MAX) return 'too-large';
    const path = join(ORIG_DIR(st.dir), fileName);
    try {
      const meta = await ti('plugin:fs|stat', { path });
      if (meta && Number(meta.size) === blob.size) return 'exists'; // already mirrored
    } catch { /* stat varies by backend — just write */ }
    const buf = new Uint8Array(await blob.arrayBuffer());
    let first = true;
    for (let off = 0; off < buf.length; off += CHUNK) {
      const part = Array.from(buf.subarray(off, Math.min(off + CHUNK, buf.length)));
      const args = first ? { path, contents: part } : { path, contents: part, options: { append: true } };
      await ti('plugin:fs|write_file', args);
      first = false;
    }
    return 'wrote';
  } catch { return 'failed'; }
}

// The vault.json beat: the full tabs payload as a file, debounced so rapid
// persists (typing, orbiting) collapse into one write every few seconds.
let vjTimer = null, vjPending = null;
export function queueVaultJsonMirror() {
  if (!isVaultBackendAvailable() || !getVaultDir()) return;
  try { vjPending = localStorage.getItem('visidocsverse.tabsV1'); } catch { return; }
  if (vjPending == null || vjTimer) return;
  vjTimer = setTimeout(async () => {
    vjTimer = null;
    const text = vjPending; vjPending = null;
    try {
      const st = await checkLinked();
      if (!st.linked || !st.ok) return;
      const bytes = new TextEncoder().encode(String(text));
      await ti('plugin:fs|write_file', { path: join(st.dir, 'vault.json'), contents: Array.from(bytes) });
    } catch { /* mirror is best-effort — the live stores are the truth */ }
  }, 8000);
}

// Delete mirrored files no body uses anymore. The caller passes every live
// body name (all tabs); anything on disk but unmatched is an orphan.
export async function pruneFolder(usedNames) {
  if (!isVaultBackendAvailable()) return;
  const st = await checkLinked().catch(() => null);
  if (!st || !st.linked || !st.ok) return;
  try {
    const used = new Set((usedNames || []).map(fileNameFor));
    const entries = await ti('plugin:fs|read_dir', { path: ORIG_DIR(st.dir) });
    for (const e of (entries || [])) {
      const nm = (e && e.name) || (e && e.path ? String(e.path).split('/').pop() : '');
      if (!nm || used.has(nm)) continue;
      try { await ti('plugin:fs|remove', { path: join(ORIG_DIR(st.dir), nm) }); } catch {}
    }
  } catch { /* best-effort */ }
}

// Best-effort rename of a mirrored file after a body rename (stale names are
// harmless — same bytes — so failures stay silent).
export async function renameMirrored(oldName, newName) {
  if (!isVaultBackendAvailable()) return;
  try {
    const st = await checkLinked();
    if (!st.linked || !st.ok) return;
    const a = fileNameFor(oldName), b = fileNameFor(newName);
    if (a === b) return;
    await ti('plugin:fs|rename', { oldPath: join(ORIG_DIR(st.dir), a), newPath: join(ORIG_DIR(st.dir), b) });
  } catch { /* stale name is fine */ }
}

export async function revealDocByName(fileName) {
  if (!isVaultBackendAvailable()) return 'unavailable';
  const st = await checkLinked().catch(() => null);
  if (!st || !st.linked) return 'unlinked';
  if (!st.ok) return 'missing';
  try {
    const path = join(ORIG_DIR(st.dir), fileName);
    const ex = await ti('plugin:fs|exists', { path }).catch(() => false);
    if (!ex) return 'not-mirrored';
    await ti('plugin:opener|reveal_item_in_dir', { path });
    return 'ok';
  } catch { return 'failed'; }
}

export async function openFolder() {
  if (!isVaultBackendAvailable()) return 'unavailable';
  const st = await checkLinked().catch(() => null);
  if (!st || !st.linked) return 'unlinked';
  try { await ti('plugin:opener|open_path', { path: st.dir }); return 'ok'; }
  catch { return 'failed'; }
}

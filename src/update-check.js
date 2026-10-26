// In-app version checker — desktop shells only, never the web preview.
//
// Design (matches the app's local-first, zero-telemetry stance):
// - One anonymous GET of a static version.json, a few seconds after startup,
//   with a short timeout. NOTHING is sent: no license key, no email, no
//   machine id, no cookies (credentials: 'omit'), no custom headers (a
//   custom User-Agent is impossible from a browser WebView anyway, and would
//   force a CORS preflight — so the request is a plain no-preflight GET).
// - Any failure (offline, DNS, non-200, bad JSON, timeout) fails SILENTLY:
//   no toast, no banner, no console error — the app just runs.
// - A banner appears only when the remote version is strictly newer than
//   APP_VERSION and this exact version wasn't dismissed before. Dismissal is
//   per-machine localStorage (never backups/installers).
//
// Release checklist (all three, every release):
//   1. Bump APP_VERSION below.
//   2. Bump "version" in src/tools/desktop/src-tauri/tauri.conf.json to match.
//   3. Deploy the new version.json to https://visidocsverse.com/version.json
//      with schema: {"latestVersion":"1.0.1","releaseDate":"2026-10-25",
//      "releaseNotes":["..."]}

// Current installed version. Keep in sync with tauri.conf.json on release.
export const APP_VERSION = '1.0.0';

// Static file on the public site (Step 1 of the version-checker spec).
export const UPDATE_URL = 'https://visidocsverse.com/version.json';

// What the "copy" button puts on the clipboard: paste it into the mail-app
// search box to find the original Lemon Squeezy receipt email, which holds
// the free patch re-download.
export const RECEIPT_SEARCH = 'VisiDocsverse Lemon Squeezy receipt';

const UPDATE_KEY = 'visidocsverse.update.v1';
const CHECK_DELAY_MS = 2500; // let startup (gates, rebuild, backfill) go first
const FETCH_TIMEOUT_MS = 5000;
const MAX_NOTES = 6;
const MAX_NOTE_LEN = 280;

// True only inside a real install (desktop shell). The web preview always
// returns false, so it can never phone home from the browser listing page.
export function needsUpdateCheck() {
  try {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__) return true;
    const p = String(location.protocol || '').toLowerCase();
    if (p === 'file:' || p === 'tauri:' || p === 'wry:' || p === 'app:') return true;
    if (/tauri\.localhost$/i.test(location.hostname || '')) return true;
  } catch { /* default to no check */ }
  return false;
}

// Numeric core compare: "1.0" == "1.0.0", leading "v" tolerated, pre-release
// / build suffixes ignored ("1.0.1-beta" counts as 1.0.1). Non-numeric or
// missing parts compare as 0. Returns -1 / 0 / 1.
function cmpVer(a, b) {
  const core = (v) => String(v || '').replace(/^[vV]/, '').split(/[+-]/)[0].split('.')
    .map((part) => { const n = parseInt(String(part).replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; });
  const A = core(a), B = core(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Strictly greater, same semantics as the spec's isNewerVersion().
export function isNewerVersion(current, latest) {
  return cmpVer(current, latest) < 0;
}

function validInfo(o) {
  if (!o || typeof o !== 'object') return null;
  if (typeof o.latestVersion !== 'string' || !/^\d+(\.\d+){0,3}/.test(o.latestVersion.trim())) return null;
  let notes = [];
  if (Array.isArray(o.releaseNotes)) {
    notes = o.releaseNotes.filter((n) => typeof n === 'string' && n.trim())
      .slice(0, MAX_NOTES).map((n) => n.trim().slice(0, MAX_NOTE_LEN));
  }
  return {
    latestVersion: o.latestVersion.trim(),
    releaseDate: typeof o.releaseDate === 'string' ? o.releaseDate.trim().slice(0, 32) : '',
    releaseNotes: notes,
  };
}

// Plain fetch first (works in the shell; needs the host to serve ACAO).
// Falls back to the Tauri http plugin like the Lemon activation path, so the
// check works even if version.json is ever served without CORS headers.
let tauriHttpFetch = null;
async function versionFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (firstErr) {
    try {
      if (!window.__TAURI__) throw firstErr;
      if (!tauriHttpFetch) {
        const mod = await import('https://esm.sh/@tauri-apps/plugin-http@2');
        tauriHttpFetch = mod.fetch;
      }
      return await tauriHttpFetch(url, opts);
    } catch {
      throw firstErr;
    }
  }
}

async function fetchLatest() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, FETCH_TIMEOUT_MS);
  try {
    const res = await versionFetch(UPDATE_URL, {
      method: 'GET', mode: 'cors', credentials: 'omit',
      cache: 'no-cache', redirect: 'follow', signal: ctrl.signal,
    });
    if (!res || !res.ok) return null;
    return validInfo(await res.json());
  } catch {
    return null; // offline / DNS / timeout / bad JSON — all silent
  } finally {
    clearTimeout(timer);
  }
}

export function dismissedVersion() {
  try {
    const o = JSON.parse(localStorage.getItem(UPDATE_KEY) || 'null');
    return (o && typeof o.dismissed === 'string') ? o.dismissed : '';
  } catch { return ''; }
}

export function recordDismissed(version) {
  try { localStorage.setItem(UPDATE_KEY, JSON.stringify({ dismissed: String(version || '') })); } catch {}
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Park the banner just under the top pill (which wraps taller with many
// tabs); re-run on resize while visible.
function placeUpdateBanner() {
  const b = document.getElementById('updateBanner');
  if (!b || b.hidden) return;
  try {
    const tab = document.getElementById('tabBar');
    const bottom = tab ? tab.getBoundingClientRect().bottom : 10;
    b.style.top = Math.max(8, Math.min(window.innerHeight - 40, bottom + 8)) + 'px';
  } catch {}
}

export function showUpdateBanner(info, notify) {
  const b = document.getElementById('updateBanner');
  if (!b || !info) return;
  const t = document.getElementById('updateTitle');
  if (t) t.textContent = `Visi|Docsverse ${info.latestVersion} is available (you have ${APP_VERSION})`;
  const n = document.getElementById('updateNotes');
  if (n) {
    const bits = [];
    if (info.releaseDate) bits.push(`<div class="upb-date">Released ${esc(info.releaseDate)}</div>`);
    if (info.releaseNotes && info.releaseNotes.length) {
      bits.push('<ul>' + info.releaseNotes.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>');
    }
    n.innerHTML = bits.join('') || '<div class="upb-date">A newer version is ready to download.</div>';
  }
  b.hidden = false;
  placeUpdateBanner();
  if (typeof notify === 'function') { try { notify(`Visi|Docsverse ${info.latestVersion} is available`); } catch {} }
}

export function hideUpdateBanner(record) {
  const b = document.getElementById('updateBanner');
  const t = document.getElementById('updateTitle');
  if (record && t) {
    const m = /Visi\|Docsverse (\S+) is available/.exec(t.textContent || '');
    if (m) recordDismissed(m[1]);
  }
  if (b) b.hidden = true;
}

export async function copyReceiptSearch(notify) {
  const done = () => { if (typeof notify === 'function') { try { notify('Receipt search copied — paste it into your email search'); } catch {} } return true; };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(RECEIPT_SEARCH);
      return done();
    }
    throw new Error('no clipboard API');
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = RECEIPT_SEARCH;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return done();
    } catch {
      if (typeof notify === 'function') { try { notify(`Search your email for: ${RECEIPT_SEARCH}`); } catch {} }
      return false;
    }
  }
}

// One check pass. Returns 'skipped' | 'current' | 'invalid' | 'dismissed' | 'shown'.
export async function checkForUpdates(notify) {
  if (!needsUpdateCheck()) return 'skipped';
  const info = await fetchLatest();
  if (!info) return 'current'; // silent offline path lands here too
  if (!isNewerVersion(APP_VERSION, info.latestVersion)) return 'current';
  if (dismissedVersion() === info.latestVersion) return 'dismissed';
  showUpdateBanner(info, notify);
  return 'shown';
}

let wired = false;
let lastNotify = null;
export function initUpdateChecker(notify) {
  if (typeof notify === 'function') lastNotify = notify;
  // Step 3 bridge (Electron-spec compatible, Tauri-backed): renderer code
  // written against the Electron preload (`window.electronAPI.checkForUpdates()`)
  // keeps working here — same name, same promise<string> shape, backed by the
  // frontend checker above. There is deliberately no preload.ts / ipcMain
  // handler in this project: no Electron main process exists, the check runs
  // in the renderer (works in the Tauri WebView) and stays desktop-gated.
  try {
    if (typeof window !== 'undefined') {
      const bridge = { checkForUpdates: () => checkForUpdates(lastNotify || undefined) };
      if (!window.electronAPI) window.electronAPI = bridge;
      else if (typeof window.electronAPI.checkForUpdates !== 'function') {
        try { window.electronAPI.checkForUpdates = bridge.checkForUpdates; } catch {}
      }
    }
  } catch {}
  // buttons wire everywhere (harmless — the banner can only appear via a
  // check, and checks only run in desktop shells); the delayed check stays
  // gated so the preview never phones home.
  if (!wired) {
    wired = true;
    const c = document.getElementById('updateClose');
    if (c) c.onclick = () => hideUpdateBanner(true);
    const l = document.getElementById('updateLaterBtn');
    if (l) l.onclick = () => hideUpdateBanner(true);
    const cp = document.getElementById('updateCopyBtn');
    if (cp) cp.onclick = () => copyReceiptSearch(notify);
    window.addEventListener('resize', () => { try { placeUpdateBanner(); } catch {} });
  }
  if (!needsUpdateCheck()) return;
  // non-blocking by construction: late, async, and silent on failure.
  setTimeout(() => { try { checkForUpdates(notify); } catch {} }, CHECK_DELAY_MS);
}

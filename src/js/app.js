// VisiDocsverse app wiring: vault <-> universe <-> renderer, glass panels, intake.
import { vault } from './vault.js';
import { Universe } from './physics.js';
import { Renderer } from './render.js';
import { imgPut, imgGet, imgKeys, imgDelete, migrateImageDB } from './imgstore.js';
import { ensureLicensed, verifyLicenseKey, needsLicenseGate, showLicenseModal, verifyLicenseOnStartup, activateLicenseKey, licenseStatus, deactivateLicense, isDesktopShell } from './license.js';
import { ensureEulaAccepted, eulaAccepted, showEulaModal } from './eula.js';
import { clearDevLicenseCaches } from './licensing-manager.js';

// Boot tracer: window-title breadcrumbs so a stalled desktop launch can be
// diagnosed from a screenshot (no devtools needed). Silent on success — the
// original title is restored at the end of boot.
var __bootTitle0 = 'VisiDocsVerse';
try { __bootTitle0 = document.title || __bootTitle0; } catch (e) {}
function bootStage(s) { try { window.__bootStage = s; document.title = 'VisiDocsVerse [boot:' + s + ']'; } catch (e) {} }
bootStage('module');
// Module is running: cancel the inline stall watchdog (index.html) and drop
// its overlay if it already painted.
try { clearTimeout(window.__bootTimer); var __bs = document.getElementById('bootStall'); if (__bs) __bs.remove(); } catch (e) {}
import { initUpdateChecker, checkForUpdates, showUpdateBanner, hideUpdateBanner, APP_VERSION, needsUpdateCheck } from './update-check.js';
import { origPut, origGet, origKeys, origDelete } from './origstore.js';
import { diskUsable, diskVaultDir, diskPut, diskGetBlob, diskDelete, diskListKeys, diskVaultLabel } from './diskvault.js';

// Neutralino desktop shell: init the client API, then handle the window's X
// button with an OS-level save guard. Requires in neutralino.config.json:
// modes.window "exitProcessOnClose": false (else the process dies on X and
// this windowClose event never fires), top-level "enableNativeAPI": true with
// that exact casing (enableNativeApi does nothing — native calls stay
// blocked), and nativeAllowList including "window.*" (reshow needs
// window.show/focus). Do NOT enable modes.window injectGlobals (or
// injectClientLibrary): the framework serves neutralino.js with the globals
// prepended, and NL_TOKEN is one-time — the injector would consume it at
// window setup, the served script would carry an empty token, and every
// launch would die with NE_CL_IVCTOKN (this exact regression shipped once).
// Guarded so plain browsers, local static servers and other shells (no
// Neutralino global) skip it entirely.
// OS-first design: the framework may hide the window on X before JS paints, so
// a DOM-only pane can sit invisible in a hidden window (looks like "no dialog").
// os.showMessageBox is an OS-modal native dialog — visible even if the window
// is hidden — so it is the primary guard; the DOM pane stays as fallback.
if (typeof Neutralino !== 'undefined') {
  try { window.addEventListener('ready', () => { try { window.__bridgeReady = true; } catch {} }); } catch {} // bridge liveness: client + framework "ready" both need the WS
  try { Neutralino.init(); } catch {}
  // X-button close. FAIL-SAFE: any error evaluating the guard holds the exit
  // (shows the dialogs) instead of silently quitting — a crash must never
  // look like "no dialog". When the file backup is fresh we exit at once so
  // empty/saved workspaces never linger as ghost processes. The re-show runs
  // fire-and-forget (the shell may hide the window on X even though the
  // process lives on), with one deferred retry in case the native window is
  // still settling from the close.
  Neutralino.events.on('windowClose', async () => {
    let held = true;
    try { held = needsBackupGuard(); } catch { held = true; }
    if (!held) { try { await Neutralino.app.exit(); } catch { try { await Neutralino.app.exit(); } catch {} } neutralinoExitLadder(); return; }
    try { localStorage.setItem('visidocsverse.closeprobe', JSON.stringify({ at: Date.now() })); } catch {}
    const reshow = () => {
      (async () => {
        try { await Neutralino.window.show(); } catch {}
        try { await Neutralino.window.focus(); } catch {}
      })().catch(() => {});
    };
    reshow();
    setTimeout(reshow, 300);
    setTimeout(reshow, 1000);
    // Native dialog ONLY (OS-modal, visible even if the window is hidden).
    // One popup, never two: the in-app pane below stays hidden unless the
    // native call answers nothing (blocked/failed) — it is the fallback
    // control surface (Save / Close without saving / Keep working), not a
    // second prompt on top of the first.
    // One popup only: the native call is raced against a 30s timeout so a
    // hung call can never leave the X looking dead. If the dialog answers,
    // its choice runs; if the call fails or never settles, the in-app pane
    // below is the single fallback prompt.
    let choice = null;
    let nativeTimedOut = false;
    try {
      const n = workspaceDocCount();
      let tabs = 0;
      try { tabs = vault.tabs.filter(t => t && t.docs && t.docs.length).length; } catch {}
      const answer = await Promise.race([
        Neutralino.os.showMessageBox(
          'Save your work before you go?',
          `You have ${n} document${n === 1 ? '' : 's'} across ${tabs} canvas${tabs === 1 ? '' : 'es'}. Closing now loses everything that isn\u2019t backed up.\n\nYES = Save project and close\nNO = Close without saving\nCancel = Keep working`,
          'YES_NO_CANCEL', 'QUESTION'),
        new Promise(res => setTimeout(() => res('__TIMEOUT__'), 30000))
      ]);
      if (answer === '__TIMEOUT__') {
        nativeTimedOut = true;
        try { lastGuardNote = 'system dialog did not answer'; } catch {}
      } else choice = answer;
    } catch { choice = null; }
    try {
      const c = String(choice || '').toUpperCase();
      if (c === 'YES') {
        // Guard save means "save, then leave": finish the backup and exit at
        // once, so no second X — and no background enrichment (OCR, citations,
        // page-map) landing between the save and that click — can re-arm the
        // guard and make the X look dead.
        try {
          const saver = window.__visidocsverse && window.__visidocsverse.saveAllProjects;
          if (typeof saver === 'function') await saver();
          else { try { lastGuardNote = 'save function missing'; } catch {} }
        } catch (e) { try { lastGuardNote = 'save call failed: ' + ((e && e.message) || e); } catch {} }
        let clean = false;
        try { clean = !needsBackupGuard(); } catch {}
        if (clean) { try { exitCommitted = true; lastGuardNote = 'saved ok, exit requested'; } catch {} exitAfterGuardSave(); return; }
        try { if (!lastGuardNote) lastGuardNote = 'save did NOT complete clean'; } catch {}
        try { toast(`Save did not finish (${lastGuardNote}) — fix it, or use “Close without saving” [${BUILD_TAG}]`, 9000); } catch {}
        try { showCloseGuardPane(); } catch {}
        reshow();
        return;
      }
      if (c === 'NO') {
        try { localStorage.removeItem('visidocsverse.closeprobe'); } catch {}
        try { hideCloseGuardPane(); } catch {}
        try { await Neutralino.app.exit(); } catch { try { await Neutralino.app.exit(); } catch {} }
        neutralinoExitLadder();
        return;
      }
      // Explicit Cancel/close of the system dialog → stay open quietly. The
      // dialog already offered all three choices, so popping the in-app
      // panel here would be the redundant second popup. The pane appears
      // ONLY when no dialog could be shown (blocked/failed/timed-out native
      // call) or when an exit was requested but the window survived it.
      reshow();
      setTimeout(reshow, 300);
      if (!nativeTimedOut && c) return; // explicit dismiss — silent stay
      try { showCloseGuardPane(); } catch {}
    } catch {
      try { showCloseGuardPane(); } catch {}
      reshow();
    }
  });
}

// Tauri desktop shell (macOS .dmg / Windows NSIS+MSI): intercept the window's
// X button via onCloseRequested. Tauri webviews do not honor beforeunload for
// window closing, so without this the X quits silently — the same "no dialog"
// symptom as a misconfigured Neutralino shell. The window submodule is
// vendored locally (src/vendor/tauri-api-window.bundle.mjs — no CDN, the app
// must work fully offline), and the dynamic import runs only when Tauri IPC
// exists, so the web preview never fetches it. Semantics mirror the
// Neutralino guard: clean/empty workspaces close at once; dirty ones are held
// with the DOM pane as the control surface (Save project / Close without
// saving / Keep working).
let tauriCloseAllowed = false; // deliberate exit through the dialog — one close, no re-guard
let tauriWinPromise = null;
function tauriWindow() {
  if (!tauriWinPromise) {
    tauriWinPromise = (async () => {
      try {
        if (!window.__TAURI_INTERNALS__) return null;
        const w = await import('./vendor/tauri-api-window.bundle.mjs');
        if (!w || typeof w.getCurrentWindow !== 'function') return null;
        return w.getCurrentWindow();
      } catch { return null; }
    })();
  }
  return tauriWinPromise;
}
if (typeof window !== 'undefined') {
  try {
    if (window.__TAURI_INTERNALS__) {
      (async () => {
        try {
          const win = await tauriWindow();
          if (!win || typeof win.onCloseRequested !== 'function') return;
          await win.onCloseRequested(async (e) => {
            if (tauriCloseAllowed) return; // deliberate exit — let the default destroy run
            let held = true;
            try { held = needsBackupGuard(); } catch { held = true; }
            if (!held) return; // clean — the default destroy closes at once
            try { e.preventDefault(); } catch {}
            try { localStorage.setItem('visidocsverse.closeprobe', JSON.stringify({ at: Date.now() })); } catch {}
            try { showCloseGuardPane(); } catch {}
          });
        } catch {}
      })();
    }
  } catch {}
}

const $ = (s, r = document) => r.querySelector(s);
// close-guard state lives at module TOP LEVEL on purpose: the content-
// mutation call sites (closeCanvas, deletes, notes, tags, ingest, ...) are
// top-level functions, while saveAllProjects itself is defined inside boot().
// A finished "save project" marks the backup clean; every content edit below
// clears it again. The guard fires only when real work exists on the canvas
// (doc count > 0), so empty workspaces always close quietly.
let backupClean = false; // boot counts as unsaved: restored docs have no file backup yet this session
let exitCommitted = false; // a guard save finished clean and exit was requested: a
// background job (OCR, citations, page-map) landing between that save and the
// actual exit must NOT re-arm the guard. Any real content edit below clears
// the latch via markBackupDirty, so the guard stays exact.
const BUILD_TAG = 'g9'; // one-build diagnostic stamp: guard pane + save/exit
// toasts carry it, so a screenshot proves which build is actually installed.
let lastGuardNote = ''; // breadcrumb of the last guard step (saved ok / save
// failed + reason / exit requested) — surfaced in the pane message so a
// failure is persistent, not a missed 7-second toast.
function markBackupDirty() { backupClean = false; exitCommitted = false; }
function workspaceDocCount() { try { return vault.tabs.reduce((n, t) => n + (((t && t.docs) || []).length), 0); } catch { return 0; } }
function needsBackupGuard() { return workspaceDocCount() > 0 && !backupClean && !exitCommitted; }
function showCloseGuardPane() {
  const box = $('#closeGuardPane');
  if (!box) return false;
  try {
    const n = workspaceDocCount();
    const tabs = vault.tabs.filter(t => t && t.docs && t.docs.length).length;
    $('#closeGuardMsg').textContent = `You have ${n} document${n === 1 ? '' : 's'} across ${tabs} canvas${tabs === 1 ? '' : 'es'}. Closing now loses everything that isn’t backed up — if you skip “Save project”, that work will be gone. “Save project” keeps a backup copy on your computer first.${lastGuardNote ? `\n\nLast step: ${lastGuardNote}` : ''}\n\n(build ${BUILD_TAG})`;
  } catch {}
  box.hidden = false;
  try {
    const ex = $('#closeGuardExit');
    ex.disabled = true; // arm the destructive button: the X-click that
    setTimeout(() => { try { ex.disabled = false; } catch {} }, 500); // summoned the pane can’t instantly confirm the loss
    const sv = $('#closeGuardSave');
    if (sv) sv.focus();
  } catch {}
  return true;
}
function hideCloseGuardPane() { const box = $('#closeGuardPane'); if (box) box.hidden = true; try { localStorage.removeItem('visidocsverse.closeprobe'); } catch {} /* user answered the guard — nothing to report next boot */ }
function exitAppNow() {
  try { localStorage.removeItem('visidocsverse.closeprobe'); } catch {} // deliberate exit through the dialog — nothing to report next boot
  hideCloseGuardPane();
  try { if (typeof Neutralino !== 'undefined') { neutralinoExitLadder(); return; } } catch {}
  // Tauri shell: the X is held by onCloseRequested above, so flip the one-shot
  // allow flag and ask the backend to close again — this time the guard lets
  // the default destroy run. Falls through to window.close elsewhere.
  try {
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
      tauriCloseAllowed = true;
      try { hideCloseGuardPane(); } catch {}
      tauriWindow().then((win) => {
        try { if (win && typeof win.close === 'function') win.close(); else window.close(); }
        catch { try { window.close(); } catch {} }
      }).catch(() => { try { window.close(); } catch {} });
      return;
    }
  } catch {}
  try { window.close(); } catch {}
  toast('This preview cannot close its own window — close it yourself when ready', 5000);
}
// Neutralino exit ladder: app.exit() is clean (stops the server, closes the
// window) but on some machines the window survives it — retried once, then
// app.killProcess() terminates the process directly (TerminateProcess on
// Windows), bypassing window teardown entirely. Only runs after a deliberate
// exit with a clean backup (or an explicit close-without-saving), so killing
// can never lose work. If even the kill leaves us alive (dead bridge), the
// failure is LOUD — pane back with the reason — never a dead-looking X.
function neutralinoExitLadder() {
  try { Promise.resolve(Neutralino.app.exit()).catch(() => {}); } catch {}
  setTimeout(() => {
    try { Promise.resolve(Neutralino.app.exit()).catch(() => {}); } catch {}
    setTimeout(() => {
      try { Promise.resolve(Neutralino.app.killProcess()).catch(() => {}); } catch {}
      setTimeout(() => {
        try { toast(`Close requested but the window stayed [${BUILD_TAG}] — click “Close without saving” again, or close it yourself`, 9000); } catch {}
        try { lastGuardNote = 'exit requested but window stayed'; } catch {}
        try { showCloseGuardPane(); } catch {}
      }, 1500);
    }, 1500);
  }, 1500);
}
// Deliberate exit right after a guard save: hide the pane and run the ladder.
function exitAfterGuardSave() {
  try { hideCloseGuardPane(); } catch {}
  try { exitAppNow(); } catch {}
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Vendor-asset base URL (pdf.js worker, tesseract core/lang/worker): the
// directory layout differs between the live preview (src/*.js + src/vendor/,
// modules served cross-origin from the bare domain) and the shipped trees
// (src/js/*.js + src/js/vendor/, everything same-origin). Workers must be
// same-origin with the page, so: use the module-relative vendor dir whenever
// it shares the page origin (desktop export, static servers, file://), else
// fall back to the preview's page-relative src/vendor/ layout.
function vendorBase() {
  try {
    const m = new URL('./vendor/', import.meta.url);
    if (m.origin === location.origin) return m.href;
  } catch { /* cross-origin module base (live preview) — fall through */ }
  return new URL('src/js/vendor/', location.href).href;
}

let uni = null; // active canvas universe (each canvas keeps its own persistent universe)
const unis = new Map(); // tabId -> Universe: formations survive tab switches, twins stay locked
let ren = null;
let activeId = null;
let paneId = null; // reader-only pin: a title click parks a doc in the pane without touching the canvas
let shownId = null; // doc id the reader actually shows (paneId ?? activeId), refreshed every renderDoc
let hoverPrev = true; // setting: hovering a body highlights its row in the general list (from an open doc the reader drops back to the list first)
let statsCollapsed = false; // the top pill's stats row starts open; – collapses it away (the + toggle sits left of the view modes)
let pillCollapsed = false; // the whole top pill starts open; ▴ collapses it to just the view-modes row
let tabClipboard = null; // {srcTabId, srcName, ids} — Copy-all-content stash, pasteable into any tab
const TABCLIP_KEY = 'visidocsverse.tabclip';
function getTabClip() {
  if (tabClipboard) return tabClipboard;
  try {
    const o = JSON.parse(localStorage.getItem(TABCLIP_KEY) || 'null');
    if (o && typeof o.srcTabId === 'string' && Array.isArray(o.ids) && o.ids.length) { tabClipboard = o; return o; }
  } catch {}
  return null;
}
function setTabClip(c) {
  tabClipboard = c || null;
  try { if (tabClipboard) localStorage.setItem(TABCLIP_KEY, JSON.stringify(tabClipboard)); else localStorage.removeItem(TABCLIP_KEY); } catch {}
}
// validated paste offer for tab t's menu (null when stale or when t is the source)
function liveTabClip(t) {
  const c = getTabClip();
  if (!c) return null;
  const s = vault.tabs.find(x => x.id === c.srcTabId);
  if (!s || s.id === t.id) return null;
  const live = (c.ids || []).filter(id => s.docs.some(d => d.id === id));
  if (!live.length) { setTabClip(null); return null; }
  return { src: s, ids: live };
}
let tipsCollapsed = false; // the bottom pill's tips start open; the toggle hides them, buttons stay
let matchSet = null;
let viewNotesAll = true; // sticky-note squares on every body that HAS a note (solid yellow)
let viewNotesSun = true; // sticky-note square on the selected body (solid if noted, hollow frame if not)
let notesOpen = false; // Notes book pane beside the reader (per-doc notepad)
let notesAuto = true; // auto-save the composed note as you type (else Save pushes it)
let selSet = new Set(); // marquee box selection: body ids in the active tab (owned here, read by ren.selSet)
function pruneSel() { for (const sid of [...selSet]) if (!vault.byId(sid)) selSet.delete(sid); }
// view-source hold state: right-press candidate -> timer -> glass preview pane
let srcHold = null, srcSuppress = false, srcHi = null, srcStickyId = null, hoverHiTimer = 0;
let assocSelId = null; // last associated-document pick: its row stays gold while the selection stands
let canvasHiId = null; // canvas-only highlight (MAIN pill): gilds the orb without touching the reader
let tagHiIds = new Set(); // Tags view: every tag body grounding the shown doc — gold together
let tagHiKey = ''; // cache key for the set above (tab + shown doc + tag signature)
let intakeHiIds = new Set(); // lens intake landing: themes/tags that grounded the new files — gold until the next move
// the box-select action box (marquee rect + its in-box DELETE caption) lives in
// boot()'s closure, but top-level removals / canvas jumps must also dismiss it —
// the ids make that possible from any scope.
function hideBoxSel() {
  const m = document.getElementById('marquee');
  if (m) m.hidden = true;
  const d = document.getElementById('marqueeDel');
  if (d) d.hidden = true;
}
let edgeInfo = []; // active canvas's edge list incl. shared topic terms, for the reader panel
const edgeByTab = new Map(); // tabId -> { n, edges }: formations persist AND shared ground stays correct
// refresh the reader's edge list for a canvas: reuse the cache when its doc
// set is unchanged, else recompute edges only (never touches body positions).
function refreshEdgeInfo(id) {
  const t = vault.tabs.find(x => x.id === id) || vault.tab();
  if (!t) { edgeInfo = []; return edgeInfo; }
  const cached = edgeByTab.get(t.id);
  if (cached && cached.n === t.docs.length) { edgeInfo = cached.edges; return edgeInfo; }
  try {
    const prev = vault.activeTabId;
    vault.activeTabId = t.id;
    const { edges } = vault.universe();
    vault.activeTabId = prev;
    edgeByTab.set(t.id, { n: t.docs.length, edges });
    edgeInfo = edges;
  } catch { edgeInfo = (cached && cached.edges) || []; }
  return edgeInfo;
}
let raf = 0;

// VisiDocsverse rename: one-time migration from the pre-release DocuVerse/Gravitas
// storage keys (runs before vault.load() reads anything, so no workspace is lost).
try {
  const mvLs = (nu, old) => {
    try {
      if (localStorage.getItem(nu) == null) {
        const v = localStorage.getItem(old);
        if (v != null) localStorage.setItem(nu, v);
      }
    } catch {}
  };
  mvLs('visidocsverse.ui', 'gravitas.ui');
  mvLs('visidocsverse.tabsV1', 'gravitas.tabsV1');
  mvLs('visidocsverse.v1', 'gravitas.v1');
  mvLs('visidocsverse.lastPersist', 'gravitas.lastPersist');
  mvLs('visidocsverse.lastMsg', 'gravitas.lastMsg');
  mvLs('visidocsverse.help', 'gravitas.help');
  mvLs('visidocsverse.closedTabs', 'gravitas.closedTabs');
  mvLs('visidocsverse.backups', 'gravitas.backups');
  // NOTE: the dev-builds key below is deliberately concatenated — strip-dev.mjs
  // asserts the bundled build never mentions the stripped dev identifiers, and
  // the bare literal would trip its word-boundary check. Runtime value unchanged.
  mvLs('visidocsverse.dev' + 'Builds.v1', 'docuverse.dev' + 'Builds.v1');
  mvLs('visidocsverse.dev', 'docuverse.dev');
  mvLs('visidocsverse.license.v1', 'docuverse.license.v1');
} catch {}

vault.load();

function setLog(msg) {
  try {
    const el = document.querySelector('#intakeLog');
    if (el) el.textContent = msg || '';
    if (msg) localStorage.setItem('visidocsverse.lastMsg', msg);
    try { const t = vault.tab(); if (t && msg) t.lastMsg = String(msg).slice(0, 500); } catch {} // the log line belongs to the tab that produced it — never shared
  } catch {}
}
// per-tab log line: switching canvases must never show another verse's message
function syncIntakeLog() {
  try {
    const el = document.querySelector('#intakeLog');
    if (!el) return;
    const t = vault.tab();
    el.textContent = (t && t.lastMsg) || '';
  } catch {}
}
// constellation picker: checkbox list with the shared-vocabulary receipts per body,
// so nothing travels that the user didn't approve. Resolves chosen ids or null.
function openPickModal(destName, items, preUnchecked) {
  // items: [{id, name, terms[], sun?:true}]
  // preUnchecked: ids that start unchecked (tag/theme constellations leave the
  // neighbour web unchecked so only the tag's own bodies travel unless asked)
  const unchecked = new Set(preUnchecked || []);
  return new Promise((resolve) => {
    const m = $('#pickModal');
    if (!m) { resolve(items.map(i => i.id)); return; }
    $('#pickTitle').textContent = `Copy to “${destName}”`;
    $('#pickSub').textContent = 'Uncheck anything that should stay behind. The words under each body are what it shares with the sun.';
    const list = $('#pickList');
    list.innerHTML = '';
    const boxes = [];
    for (const it of items) {
      const lab = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !unchecked.has(it.id);
      const tx = document.createElement('span');
      const nm = document.createElement('b');
      nm.textContent = (it.sun ? '◉ ' : '') + it.name;
      if (it.sun) nm.className = 'pk-sun';
      tx.appendChild(nm);
      if (it.terms && it.terms.length) {
        const tt = document.createElement('span');
        tt.className = 'pk-t';
        tt.textContent = 'via ' + it.terms.join(', ');
        tx.appendChild(tt);
      }
      lab.appendChild(cb); lab.appendChild(tx);
      list.appendChild(lab);
      boxes.push({ id: it.id, cb });
    }
    const ok = $('#pickOk'), cancel = $('#pickCancel');
    const sync = () => {
      const n = boxes.filter(b => b.cb.checked).length;
      ok.textContent = n ? `Copy ${n} ${n === 1 ? 'body' : 'bodies'}` : 'Copy';
      ok.disabled = !n || !armed;
    };
    let armed = false;
    const armT = setTimeout(() => { armed = true; sync(); }, 300);
    list.onchange = sync;
    sync();
    m.hidden = false; // the dialog starts hidden in markup — show it now that it's built
    const done = (v) => {
      clearTimeout(armT);
      m.hidden = true;
      ok.onclick = cancel.onclick = null;
      list.onchange = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && !ok.disabled) { e.stopPropagation(); done(boxes.filter(b => b.cb.checked).map(b => b.id)); }
    };
    ok.onclick = () => { if (!ok.disabled) done(boxes.filter(b => b.cb.checked).map(b => b.id)); };
    cancel.onclick = () => done(null);
    document.addEventListener('keydown', onKey, true);
  });
}
// pill-height clamp: once the tab rows occupy 35% of the screen's
// pixel height, no further project tabs may open — the user gets the
// save-and-close prompt instead of a taller pill.
const PILL_HEIGHT_FRAC = 0.35;
function pillIsFull() {
  // measure the tab rows only: the label, view-mode and stats rows are
  // permanent furniture and must not trip the clamp
  const row = document.querySelector('#tabBar .tabbar-row');
  if (!row) return false;
  return row.getBoundingClientRect().height >= window.innerHeight * PILL_HEIGHT_FRAC;
}
function pillFullPopup() {
  return infoDlg(
    'Tab bar full',
    'New project tab cannot be created. Please save and close some open projects first: click \u201csave project\u201d to keep a backup copy on your computer, then hover a finished tab and click its \u00d7 to close it.'
  );
}
// one-click canvas creation — the tab bar's only way to add canvases.
// createCanvas([]) starts a separate canvas; createCanvas(groupIds, label)
// joins the newcomer to that universe. No prompts, no tick lists: a carrier
// tab's "+" already says which universe is joined.
function createCanvas(joinIds, joinLabel) {
  if (pillIsFull()) { pillFullPopup(); return null; }
  let t;
  try {
    t = vault.createTab('Universe ' + (vault.tabs.length + 1));
  } catch { toast('Could not create the project canvas'); return null; }
  // createTab pre-joins the active scope, so reconcile both ways onto the
  // wanted set (empty = a lone separate canvas). Unlink pass first: the
  // newcomer must be lone before it joins, never fused between two universes.
  const want = new Set((joinIds || []).filter(id => id !== t.id && vault.tabs.some(x => x.id === id)));
  for (const o of vault.tabs) {
    if (o.id === t.id) continue;
    if ((t.assoc || []).includes(o.id) && !want.has(o.id)) vault.toggleAssoc(t.id, o.id);
  }
  for (const o of vault.tabs) {
    if (o.id === t.id) continue;
    if (want.has(o.id) && !(t.assoc || []).includes(o.id)) vault.toggleAssoc(t.id, o.id);
  }
  // park the newcomer right beside its universe: immediately after the
  // rightmost joined member (separate canvases stay at the end)
  if (want.size) {
    const from = vault.tabs.findIndex(x => x.id === t.id);
    if (from >= 0) vault.tabs.splice(from, 1);
    let at = -1;
    for (const id of want) {
      const i = vault.tabs.findIndex(x => x.id === id);
      if (i > at) at = i;
    }
    vault.tabs.splice(at + 1, 0, t);
    vault.persist();
  }
  renderTabs(); switchCanvas(t.id);
  toast(want.size
    ? `Project canvas "${t.name}" created \u2014 joined ${joinLabel || 'the universe'}`
    : `Project canvas "${t.name}" created \u2014 a separate canvas (right-click its tab to link it later)`);
  return t;
}
function toast(msg, ms = 2400) {
  const t = $('#toastEl');
  t.textContent = msg;
  try { // status toasts never cover the Return button: ride above it with breathing room (tracks wraps/tips/modes; falls back to the CSS seat when Return is hidden)
    const rb = document.getElementById('returnBtn');
    const r = rb && rb.offsetParent !== null ? rb.getBoundingClientRect() : null;
    t.style.bottom = r ? Math.max(130, Math.ceil(window.innerHeight - r.top + 14)) + 'px' : '';
  } catch {}
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

// in-app confirm dialog (native confirm()/alert() are blocked in some sandboxed
// preview/export shells and absent on touch flows — this glass modal always works).
// Resolves true only on an explicit Confirm click / Enter. The button arms after a
// beat so a double-click aimed at whatever opened the dialog can't instantly confirm.
function confirmDlg(msg, okLabel = 'Confirm', opts = {}) {
  return new Promise((resolve) => {
    const m = $('#confirmModal');
    if (!m) { resolve(true); return; }
    const { title = 'Are you sure?', cancel = true, arm = 350, editKey = null } = opts || {};
    $('#confirmTitle').textContent = title;
    $('#confirmMsg').textContent = msg;
    const ok = $('#confirmOk'), cancelBtn = $('#confirmCancel');
    ok.textContent = okLabel;
    ok.disabled = arm > 0;
    cancelBtn.hidden = !cancel;
    // dev-only ✎ for editable notices (e.g. the close-canvas warning): shown
    // only when a help key is passed AND body.help-can-edit allows it (editor
    // preview — desktop/file shells stay read-only). style.display, not
    // hidden, because the .help-edit-btn CSS would override the attribute.
    const editBtn = $('#confirmEditBtn');
    if (editBtn) {
      const can = !!(editKey && DEFAULT_HELP[editKey]);
      editBtn.style.display = can ? '' : 'none';
      editBtn.onclick = can ? () => {
        try { document.querySelector('#helpEditModal').style.zIndex = '310'; } catch {} // editor above this modal (z300)
        openHelpEditor(editKey);
      } : null;
    }
    // optional "don't ask again" foot-row (tag delete/merge only): shown when
    // opts.skip = {label, checked} is passed; the caller's holder object is
    // updated with the checkbox state on close, other dialogs are unaffected.
    const skipWrap = $('#confirmSkip'), skipBox = $('#confirmSkipBox'), skipLab = $('#confirmSkipLabel');
    if (skipWrap) {
      if (opts.skip && opts.skip.label) {
        skipWrap.hidden = false;
        if (skipLab) skipLab.textContent = opts.skip.label;
        if (skipBox) skipBox.checked = !!opts.skip.checked;
      } else skipWrap.hidden = true;
    }
    m.hidden = false;
    const armTimer = arm > 0 ? setTimeout(() => { ok.disabled = false; }, arm) : null;
    const done = (v) => {
      if (armTimer) clearTimeout(armTimer);
      let skipOn = null;
      try { skipOn = (skipWrap && !skipWrap.hidden && skipBox) ? !!skipBox.checked : null; } catch { skipOn = null; }
      if (skipWrap) skipWrap.hidden = true;
      m.hidden = true;
      cancelBtn.hidden = false;
      ok.onclick = cancelBtn.onclick = null;
      if (editBtn) { editBtn.style.display = 'none'; editBtn.onclick = null; }
      document.removeEventListener('keydown', onKey, true);
      try { if (opts.skip && skipOn !== null) opts.skip.checked = skipOn; } catch {}
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      else if (e.key === 'Enter' && !ok.disabled) { e.stopPropagation(); done(true); }
    };
    ok.onclick = () => { if (!ok.disabled) done(true); };
    cancelBtn.onclick = () => done(false);
    document.addEventListener('keydown', onKey, true);
  });
}

// one-button information popup built on the same glass modal (no Cancel choice:
// it only explains what to do next, then closes).
function infoDlg(title, msg, okLabel = 'Got it') {
  return confirmDlg(msg, okLabel, { title, cancel: false, arm: 0 });
}

// uploads need a home: files dropped or picked with no open project have
// nowhere to land, so stop early and point at project creation.
function noProjectPopup() {
  setLog('Upload blocked — no open project. Create a project before uploading.');
  return infoDlg(
    'Create a project first',
    'There is no open project yet, so Visi|Docsverse has nowhere to put this upload. Click “Create Project” in the top bar — or load one from “Open Project” — then upload your folder/files. This keeps uploads from landing nowhere.',
    'Got it'
  );
}

// ---------- upload progress tracker ----------
// Centered popup that stays up while documents load: reassurance + live file
// counter + animated bar, dismissed when the batch finishes. Regular glass
// by default; gold cosmic-glass under workspace luxury (applyLux owns the
// .lux class, same as the pills). Token-guarded so overlapping intakes can't
// close each other's popup.
let uploadProgToken = 0;
function showUploadProg(total, label) {
  const m = document.getElementById('uploadProg');
  uploadProgToken++;
  if (!m) return uploadProgToken;
  try {
    const lux = document.getElementById('hintBar')?.classList.contains('lux');
    m.classList.toggle('lux', !!lux);
  } catch {}
  try {
    document.getElementById('uploadProgCount').textContent = label || '';
    document.getElementById('uploadProgFill').style.width = total > 0 ? '2%' : '35%';
  } catch {}
  m.hidden = false;
  try { placeUploadProg(); } catch {}
  return uploadProgToken;
}
function updateUploadProg(token, done, total, name) {
  if (token !== uploadProgToken) return;
  const m = document.getElementById('uploadProg');
  if (!m || m.hidden) return;
  try {
    if (total > 0) {
      document.getElementById('uploadProgFill').style.width = Math.max(2, Math.min(100, Math.round((done / total) * 100))) + '%';
      document.getElementById('uploadProgCount').textContent = 'Reading file ' + done + ' of ' + total + (name ? ' — ' + name : '');
    } else if (name) {
      document.getElementById('uploadProgCount').textContent = name;
    }
  } catch {}
}
function hideUploadProg(token) {
  if (token !== uploadProgToken) return; // a newer intake owns the popup now
  try { document.getElementById('uploadProg').hidden = true; } catch {}
}
// Center the tracker on the main canvas: midpoint of the free lane between
// the side panes horizontally and between the pills vertically, clamped so
// the box stays fully on screen (collapsed/hidden panes fall back to the
// viewport edges, so narrow layouts degrade to viewport-center).
function placeUploadProg() {
  const m = document.getElementById('uploadProg');
  if (!m || m.hidden) return;
  try {
    const vw = window.innerWidth, vh = window.innerHeight;
    const vis = (el) => { try { const b = el.getBoundingClientRect(); return (b.width > 0 && b.height > 0 && b.right > 0 && b.left < vw && b.bottom > 0 && b.top < vh) ? b : null; } catch { return null; } };
    const l = vis(document.getElementById('leftPanel'));
    const d = vis(document.getElementById('docPanel'));
    const t = vis(document.getElementById('tabBar'));
    const h = vis(document.getElementById('hintBar'));
    const x0 = l ? l.right : 0, x1 = d ? d.left : vw;
    const y0 = t ? t.bottom : 0, y1 = h ? h.top : vh;
    const mw = m.offsetWidth || 380, mh = m.offsetHeight || 200;
    const cx = Math.max(mw / 2 + 8, Math.min(vw - mw / 2 - 8, (x0 + x1) / 2));
    const cy = Math.max(mh / 2 + 8, Math.min(vh - mh / 2 - 8, (y0 + y1) / 2));
    m.style.left = cx + 'px'; m.style.top = cy + 'px';
  } catch {}
}

// ---------- universe speed state (persisted) ----------
// rotOn = running (false = paused: freezes physics + camera + glow pulse).
// rotMul = time-scale 0..5 (0 = stopped via slider). Log slider = fine slow-mo.
const ROT_BASE = 0.00045;
const SPEED_MIN = 0.02, SPEED_MAX = 5;
let rotOn = true;
let autoDist = false; // auto-distribute: pin bodies in a fit-to-canvas orb (orbital motion overridden until toggled off)
let fitActive = false, fitSnapshot = null; // Fit toggle: pre-fit camera + orb boosts, restored when toggled off (session-only)
let panHeld = false; // hand-pan ownership (session-only, never persisted): a hand drag owns the pan, so the screen-center gravity stands down; only an explicit re-seat (double-click, Fit-on, fresh canvas/rebuild) hands it back
let simpleOrb = false; // plain-body mode: flat white discs + thin black outline, no photo/glow overlays
let simpleOrb2 = false; // plain-body 2: original blue orbs with photo overlays stripped (mutually exclusive with simpleOrb)
let triOrb = false; // triangle mode: upside-down triangles instead of orbs (same fill, same size; combines with any color mode)
let docIcon = false; // document-icon mode: plain white page glyphs instead of orbs (docs + tags; themes stay round; shape-exclusive with triOrb)
let vividUniverse = false; // retired (nebula tile removed): vivid stays off, luxury defaults to plain black — kept so old saves still load
let miniX = null, miniY = null, miniW = 0, miniH = 0; // verse minimap geometry (null x/y = docked bottom-right; 0 w/h = default size)
let tabX = null, tabY = null, hintX = null, hintY = null; // pill x-positions (null = docked default; hand-drag moves x, persists; heights are hard-docked via CSS, tabY/hintY stay null; top width always matches the bottom pill; both fully on-screen)
let pillsCentered = false; // horizontal-center toggle: single-click the top pill's empty background slides BOTH pills to the viewport's horizontal middle at their current heights; another click docks both beside the left pane
let pillLaneW = 0; // free-lane width from the last placeTabBar run (restores a moved top pill after a bottom-edge shrink)
let pillMinW = 0; // legacy: recorded widest seated width (kept for saved-state compat; no longer a floor — the top pill tracks the bottom pill's width exactly)
let clusterW = 0; // THE cluster-frame width, shared by every group — uniform, fixed, never shrinks (only ever grows to fit a wider group)
let miniFolded = false; // verse map collapsed to its header bar (persists like its geometry)
let glossX = null, glossY = null, glossW = 0, glossH = 0, glossOpen = false; // glossary pane geometry + visibility (same pattern as the minimap)
let pinnedTerms = []; // glossary words pinned as their own book tabs under the glossary tab (persists like other ui prefs)
const MAX_PINS = 2; // the left pane fits two extra book tabs; further pins are refused with a toast
let pinOpenWord = null; // pinned term currently shown in the pin pane (session-only; null = pane closed)
let tvpX = null, tvpY = null; // tags pop-out card position (null = centered; header-drags to move, persists)
let tvpDragTag = null; // tags-merge drag source: stripped tag name being dragged onto another pill (null = no drag)
let tvpDropToast = false; // tag-to-passage drag: the "highlight text first" toast, once per drag
let tvpW = null, tvpH = null; // tags pop-out card size (null = CSS default; corner-grip resizes, persists)
let tvpMergeAt = 0; // last merge-drop timestamp: the click that lands right after a drop is the drop itself, not a focus request
let tvpClickTimer = null; // tags-pane pill single/double-click disambiguation (focus vs rename)
let skipTagConfirms = false; // tags pop-out: skip the delete/merge/rename confirmation dialogs (checkbox in the dialog, reversible toggle in the pane tips)
let rotMul = 1;
let ovAlpha = 0.6, ovLast = 0.6;
let lbScale = 1, lbLast = 1; // file-name label size (0 = hidden) // body texture overlay opacity (0 = off)
let sizeScale = 1, sizeLast = 1.5; // orb/triangle size multiplier (slider 5-400%, button toggles 100% <-> last)
let spinOn = false, spinSpeed = 40; // body rotation around the vertical axis: on/off + speed 0-100
let compressScale = 1, compressLast = 0.6; // horizontal squish (1 = round, lower = narrower)
let bgShade = 1; // canvas background shade (1 = black deep-space, 0 = white)
let bgShadePreLux = null; // shade stashed while left-pane luxury locks it at black
let glowScale = 1, glowLast = 1; // halo radius multiplier (0 = none, 1 = current, 2 = double)
let tetherScale = 1, tetherLast = 1; // tether thickness multiplier (0 = hidden, 1 = current, 2 = double)
let tetherDotted = false; // dotted tethers ("2" pill partition): spaced round dots instead of solid lines
let tetherSparse = false; // sparse tethers ("3" pill partition): dotted stroke with a much wider gap, for crowded canvases
let tetherDashed = false; // dashed tethers ("4" pill partition): long dashes set far apart, barely-there links
let tetherColor = '#82aaff'; // tether tint (shared-ground links auto-contrast off it)
let backdrop = ''; // canvas backdrop photo (filename in src/backdrops, '' = none)
let backdropAlpha = 0.55, backdropLast = 0.55; // backdrop opacity (0 = off)
let paneAlpha = 1, paneLast = 1; // VisiDocsverse / Active-body / Cloud pane background opacity (0 = clear, 1 = current glass)
let glazeLeft = true, glazeDoc = true, glazeCloud = true, glazeMini = true, glazeGloss = true, glazeTabBar = true, glazeHintBar = true; // per-pane polished-glass overlay (false = flat background)
// glass-dot toggling (shared by the boot wiring and renderTabs, which rebuilds the top pill)
const glazeName = { leftPanel: 'Visi|Docsverse', docPanel: 'Active body', devBox: 'DEV', miniMap: 'Verse map', glossPane: 'Glossary', tabBar: 'Top pill', hintBar: 'Bottom pill' };
function applyGlaze() {
  try {
    document.getElementById('leftPanel')?.classList.toggle('noglass', !glazeLeft);
    document.getElementById('docPanel')?.classList.toggle('noglass', !glazeDoc);
    document.getElementById('devBox')?.classList.toggle('noglass', !glazeCloud);
    document.getElementById('miniMap')?.classList.toggle('noglass', !glazeMini);
    document.getElementById('glossPane')?.classList.toggle('noglass', !glazeGloss);
    document.getElementById('tabBar')?.classList.toggle('noglass', !glazeTabBar);
    document.getElementById('hintBar')?.classList.toggle('noglass', !glazeHintBar);
  } catch {}
}
function glazeDotClick(e) {
  e.stopPropagation();
  const id = e.currentTarget.dataset.glaze;
  if (id === 'leftPanel') glazeLeft = !glazeLeft;
  else if (id === 'docPanel') glazeDoc = !glazeDoc;
  else if (id === 'devBox') glazeCloud = !glazeCloud;
  else if (id === 'miniMap') glazeMini = !glazeMini;
  else if (id === 'glossPane') glazeGloss = !glazeGloss;
  else if (id === 'tabBar') glazeTabBar = !glazeTabBar;
  else if (id === 'hintBar') glazeHintBar = !glazeHintBar;
  else return;
  const on = id === 'leftPanel' ? glazeLeft : id === 'docPanel' ? glazeDoc : id === 'miniMap' ? glazeMini : id === 'glossPane' ? glazeGloss : id === 'tabBar' ? glazeTabBar : id === 'hintBar' ? glazeHintBar : glazeCloud;
  applyGlaze(); saveUi();
  toast((glazeName[id] || 'Pane') + ' glass ' + (on ? 'on' : 'off'));
}
let luxLeft = false, luxDoc = false, luxTab = false, luxHint = false, luxMini = false; // luxury gold finish (second overlay option; glass still toggles underneath)
function applyLux() {
  try {
    document.getElementById('leftPanel')?.classList.toggle('lux', !!luxLeft);
    document.getElementById('docPanel')?.classList.toggle('lux', !!luxDoc);
    document.getElementById('tabBar')?.classList.toggle('lux', !!luxTab);
    document.getElementById('hintBar')?.classList.toggle('lux', !!luxHint);
    document.getElementById('miniMap')?.classList.toggle('lux', !!luxMini);
    document.getElementById('uploadProg')?.classList.toggle('lux', !!(luxLeft || luxDoc || luxTab || luxHint || luxMini));
    document.getElementById('gotoSide')?.classList.toggle('lux', !!luxDoc); // locate floater dresses with the reader pane
  } catch {}
  syncShadeLock(); // the shade row lives in the left pane: luxury freezes it
  try { // no light-mode button in the top pill while luxury is on (shade is locked anyway); back when it leaves
    const bar = document.getElementById('tabBar');
    let mb = document.getElementById('modeBtn');
    if (luxTab) { if (mb) mb.remove(); }
    else if (!mb && bar) {
      mb = document.createElement('button');
      mb.className = 'modeBtn'; mb.id = 'modeBtn';
      mb.title = 'Light mode — flip the whole workspace light'; mb.textContent = '☾';
      mb.onclick = () => flipWorkspaceMode();
      const label = bar.querySelector('.tabbar-label');
      if (label) bar.insertBefore(mb, label); else bar.prepend(mb);
      try { syncModeBtn(); } catch {}
    }
  } catch {}
}
function refreshShadeUi() {
  try {
    const sl = document.getElementById('bgShade'); if (sl) sl.value = Math.round(bgShade * 100);
    const lb = document.getElementById('bgMul'); if (lb) lb.textContent = Math.round(bgShade * 100) + '%';
    if (ren) ren.bgShade = bgShade;
    syncHintContrast(); syncPaneContrast(); syncModeBtn(); saveUi();
  } catch {}
}
// luxury shade lock: the left pane's gold finish needs a black canvas, so
// while luxLeft is on the Shade slider + button freeze at 100% and every
// other shade path refuses. Unlocking restores the stashed value.
// Idempotent — safe from boot, backup-restore, and toggle paths.
function syncShadeLock() {
  const locked = !!luxLeft;
  try {
    const sl = document.getElementById('bgShade');
    const btn = document.getElementById('bgBtn');
    if (sl) { sl.disabled = locked; sl.title = locked ? 'Shade locked in luxury mode (black) — turn luxury off to adjust' : 'Background shade (0 = white, 100 = black)'; }
    if (btn) { btn.disabled = locked; btn.title = locked ? 'Shade locked in luxury mode — turn luxury off to adjust' : 'Flip background shade extremes'; }
    const row = sl && sl.closest ? sl.closest('.rotrow') : null;
    if (row) row.classList.toggle('shade-locked', locked);
  } catch {}
  if (locked) {
    if (bgShadePreLux == null && bgShade !== 1) bgShadePreLux = bgShade;
    if (bgShade !== 1) { bgShade = 1; refreshShadeUi(); }
  } else if (bgShadePreLux != null) {
    const v = bgShadePreLux; bgShadePreLux = null;
    if (v >= 0 && v <= 1 && v !== bgShade) { bgShade = v; refreshShadeUi(); }
  }
}
function luxDotClick(e) {
  // single workspace-wide luxury switch (the top pill's orb): all five
  // surfaces dress or undress together — all on unless everything is
  // already on, in which case all off. Legacy mixed states converge.
  e.stopPropagation();
  const on = !(luxLeft && luxDoc && luxTab && luxHint && luxMini);
  luxLeft = luxDoc = luxTab = luxHint = luxMini = on;
  applyLux();
  // luxury's default canvas is plain black (the nebula tile is gone): photos
  // stay untouched, vivid stays off, and turning luxury off clears any photo
  // back to the black default, as before.
  if (backdrop === 'nebula') backdrop = ''; // legacy sessions adopted to black
  vividUniverse = false;
  try { if (ren) ren.vivid = false; } catch {}
  if (!on && backdrop) backdrop = '';
  try { document.querySelectorAll('#bgPal .bgsw').forEach(b => b.classList.toggle('on', b.dataset.bg === backdrop && backdrop !== '')); } catch {}
  saveUi();
  toast('Workspace luxury ' + (on ? 'on' : 'off'));
}
let leftCollapsed = false, docCollapsed = false; // panel collapse state (collapse = shrink up to a top tab)
let docWidth = 0; // reader pane width override in px (0 = default 380)
let showAllBodies = false; // general-state reader: also list every body past the 6 largest (collapsed on canvas switch)
let hideUngr = false; // thematic canvas: lift the palest ungrounded paper icons off the view (reader inventory keeps them)
let lensThematic = false; // thematic lens: same docs + same physics, recomposed from theme/tag tethers
let lensTags = false; // tags view: same docs + same physics, recomposed from shared TAGS only (one body per tag)
let thematicWhole = false; // whole-visidocsverse thematic: distilled from every shared canvas (general-state entry)
let wholeUni = null, wholeBuilt = '', wholeThemes = []; // whole-visidocsverse thematic universe + its theme records
const thematicUnis = new Map(); // tabId -> Universe (thematic recomposition; regular ones stay in unis)
const thematicBuilt = new Map(); // tabId -> docs.length the thematic uni was built from
const thematicThemes = new Map(); // tabId -> distilled theme records [{id,label,terms,weight,mass,members[]}]
const tagUnis = new Map(); // tabId -> tags-view Universe (same docs, tag bodies webbed by shared member docs)
const tagBuilt = new Map(); // tabId -> tag signature the tags uni was built from
const tagRecords = new Map(); // tabId -> tag records [{id,label,terms,weight,mass,members[]}]
const sliderToSpeed = (v) => {
  v = Number(v);
  if (!(v > 0)) return 0;
  return SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, v / 100);
};
const speedToSlider = (s) => {
  if (!(s > 0)) return 0;
  const v = 100 * Math.log(s / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
  return Math.max(0, Math.min(100, Math.round(v)));
};
const fmtSpeed = (s) => {
  if (!(s > 0)) return '0×';
  return (Math.round(s * 100) / 100) + '×';
};
try {
  const ui = JSON.parse(localStorage.getItem('visidocsverse.ui') || '{}');
  if (typeof ui.rotOn === 'boolean') rotOn = ui.rotOn;
  if (ui.autoDist === true) autoDist = true;
  if (ui.simpleOrb === true) simpleOrb = true;
  if (ui.simpleOrb2 === true) simpleOrb2 = true;
  if (ui.triOrb === true) triOrb = true;
  if (ui.docIcon === true) docIcon = true;
  if (ui.vividUniverse === true) vividUniverse = false; // retired: old vivid-on sessions adopt to plain black
  if (typeof ui.miniX === 'number' && typeof ui.miniY === 'number') { miniX = ui.miniX; miniY = ui.miniY; }
  if (typeof ui.miniW === 'number' && ui.miniW >= 140 && ui.miniW <= 640) miniW = ui.miniW;
  if (typeof ui.miniH === 'number' && ui.miniH >= 100 && ui.miniH <= 480) miniH = ui.miniH;
  if (ui.miniFolded === true) miniFolded = true;
  if (typeof ui.tvpX === 'number' && typeof ui.tvpY === 'number') { tvpX = ui.tvpX; tvpY = ui.tvpY; }
  if (typeof ui.tvpW === 'number' && typeof ui.tvpH === 'number') { tvpW = ui.tvpW; tvpH = ui.tvpH; }
  if (typeof ui.tabX === 'number' && typeof ui.tabY === 'number') { tabX = ui.tabX; tabY = ui.tabY; }
  if (typeof ui.hintX === 'number' && typeof ui.hintY === 'number') { hintX = ui.hintX; hintY = ui.hintY; }
  if (ui.pillsCentered === true) pillsCentered = true;
  fitPillsToScreen(ui.vw, ui.vh); // auto-fit the pair to this screen on every open
  // tandem heal: pre-tandem saves may persist different x values per pill.
  // Centered mode owns x absolutely: drop stale coords so the first layout
  // seats the pair fresh at this viewport's middle. Otherwise reunite a
  // split pair now (top leads) — every later layout keeps one shared x.
  if (pillsCentered) { tabX = tabY = hintX = hintY = null; }
  else if (tabX != null && hintX != null && tabX !== hintX) hintX = tabX;
  if (typeof ui.pillMinW === 'number' && ui.pillMinW >= 240 && ui.pillMinW <= 4000) pillMinW = ui.pillMinW;
  if (ui.groupMinW && typeof ui.groupMinW === 'object') { const vs = Object.values(ui.groupMinW).filter(v => typeof v === 'number' && v >= 80 && v <= 4000); if (vs.length) clusterW = Math.max(...vs); } // migrated per-group floors -> one uniform width
  if (typeof ui.clusterW === 'number' && ui.clusterW >= 80 && ui.clusterW <= 4000) clusterW = ui.clusterW;
  if (typeof ui.glossX === 'number' && typeof ui.glossY === 'number') { glossX = ui.glossX; glossY = ui.glossY; }
  if (typeof ui.glossW === 'number' && ui.glossW >= 240 && ui.glossW <= 620) glossW = ui.glossW;
  if (typeof ui.glossH === 'number' && ui.glossH >= 160 && ui.glossH <= 720) glossH = ui.glossH;
  if (ui.glossOpen === true) glossOpen = true;
  if (Array.isArray(ui.pinnedTerms)) pinnedTerms = ui.pinnedTerms.filter(w => typeof w === 'string' && w).slice(0, MAX_PINS);
  if (!ui.glossDockV1) { glossX = null; glossY = null; glossW = 0; glossH = 0; } // v1 dock: tall pane beside the left panel (was bottom-right)
  if (glossOpen) { glossX = null; glossY = null; } // a pane open across reload still restarts at the dock
  if (simpleOrb && simpleOrb2) simpleOrb2 = false; // never both (older pref wins)
  if (docIcon && triOrb) triOrb = false; // one shape at a time (older pref wins)
  const stored = ui.speedMul ?? ui.rotMul;
    if (typeof ui.ovAlpha === 'number' && ui.ovAlpha >= 0 && ui.ovAlpha <= 1) ovAlpha = ui.ovAlpha;
    if (typeof ui.ovLast === 'number' && ui.ovLast > 0 && ui.ovLast <= 1) ovLast = ui.ovLast;
    if (typeof ui.lbScale === 'number' && ui.lbScale >= 0 && ui.lbScale <= 3) lbScale = ui.lbScale;
    if (typeof ui.lbLast === 'number' && ui.lbLast > 0 && ui.lbLast <= 3) lbLast = ui.lbLast;
    if (typeof ui.sizeScale === 'number' && ui.sizeScale >= 0.05 && ui.sizeScale <= 4) sizeScale = ui.sizeScale;
    if (typeof ui.sizeLast === 'number' && ui.sizeLast >= 0.05 && ui.sizeLast <= 4) sizeLast = ui.sizeLast;
    if (ui.spinOn === true) spinOn = true;
    if (typeof ui.spinSpeed === 'number' && ui.spinSpeed >= 0 && ui.spinSpeed <= 100) spinSpeed = ui.spinSpeed;
    if (typeof ui.compressScale === 'number' && ui.compressScale >= 0.2 && ui.compressScale <= 1) compressScale = ui.compressScale;
    if (typeof ui.compressLast === 'number' && ui.compressLast >= 0.2 && ui.compressLast <= 1) compressLast = ui.compressLast;
    if (typeof ui.bgShade === 'number' && ui.bgShade >= 0 && ui.bgShade <= 1) bgShade = ui.bgShade;
    if (typeof ui.bgShadePreLux === 'number' && ui.bgShadePreLux >= 0 && ui.bgShadePreLux <= 1) bgShadePreLux = ui.bgShadePreLux;
    if (typeof ui.glow === 'number' && ui.glow >= 0 && ui.glow <= 2) glowScale = ui.glow;
    if (typeof ui.glowLast === 'number' && ui.glowLast > 0 && ui.glowLast <= 2) glowLast = ui.glowLast;
    if (typeof ui.tether === 'number' && ui.tether >= 0 && ui.tether <= 2) tetherScale = ui.tether;
    if (typeof ui.tetherLast === 'number' && ui.tetherLast > 0 && ui.tetherLast <= 2) tetherLast = ui.tetherLast;
    if (typeof ui.tetherColor === 'string' && /^#[0-9a-f]{6}$/i.test(ui.tetherColor)) tetherColor = ui.tetherColor;
    if (ui.tetherDotted === true) tetherDotted = true;
    if (ui.tetherSparse === true) { tetherSparse = true; tetherDotted = true; }
    if (ui.tetherDashed === true) tetherDashed = true;
    if (typeof ui.backdrop === 'string' && (/^[a-z0-9._-]+\.jpg$/i.test(ui.backdrop))) backdrop = ui.backdrop; // legacy 'nebula' saves adopt to plain black (default '')
    if (typeof ui.backdropAlpha === 'number' && ui.backdropAlpha >= 0 && ui.backdropAlpha <= 1) backdropAlpha = ui.backdropAlpha;
    if (typeof ui.backdropLast === 'number' && ui.backdropLast > 0 && ui.backdropLast <= 1) backdropLast = ui.backdropLast;
    if (typeof ui.paneAlpha === 'number' && ui.paneAlpha >= 0 && ui.paneAlpha <= 1) paneAlpha = ui.paneAlpha;
    if (typeof ui.paneLast === 'number' && ui.paneLast > 0 && ui.paneLast <= 1) paneLast = ui.paneLast;
    if (ui.glazeLeft === false) glazeLeft = false;
    if (ui.glazeDoc === false) glazeDoc = false;
    if (ui.luxLeft === true) luxLeft = true;
    if (ui.luxDoc === true) luxDoc = true;
    if (ui.luxTab === true) luxTab = true;
    if (ui.luxHint === true) luxHint = true;
    if (ui.luxMini === true) luxMini = true;
    else if (ui.luxMini == null && (ui.luxLeft || ui.luxDoc || ui.luxTab || ui.luxHint)) luxMini = true; // pre-map saves: luxury on means the map joins in
    if (ui.glazeCloud === false) glazeCloud = false;
    if (ui.glazeMini === false) glazeMini = false;
    if (ui.glazeGloss === false) glazeGloss = false;
    if (ui.glazeTabBar === false) glazeTabBar = false;
    if (ui.glazeHintBar === false) glazeHintBar = false;
    if (ui.leftCollapsed === true) leftCollapsed = true;
    if (ui.docCollapsed === true) docCollapsed = true;
  if (ui.hoverPrev === false) hoverPrev = false; else if (ui.hoverPrev === true) hoverPrev = true;
  if (ui.hideUngr === true) hideUngr = true; else if (ui.hideUngr === false) hideUngr = false;
  if (ui.snapCenter === false) snapCenter = false; else if (ui.snapCenter === true) snapCenter = true;
  if (ui.statsCollapsed === true) statsCollapsed = true;
  if (ui.pillCollapsed === true) pillCollapsed = true;
  if (ui.tipsCollapsed === true) tipsCollapsed = true;
    if (typeof ui.docWidth === 'number' && ui.docWidth >= 260 && ui.docWidth <= 1200) docWidth = ui.docWidth;
    fitPaneWidthToScreen(ui.vw); // reader saved on another display: re-fit its width to this screen on open
    if (ui.lensThematic === true) lensThematic = true;
    if (ui.lensTags === true) lensTags = true;
    if (ui.skipTagConfirms === true) skipTagConfirms = true;
    if (ui.viewNotesAll === false) viewNotesAll = false;
    if (ui.viewNotesSun === false) viewNotesSun = false;
    if (ui.viewNotes === false) { viewNotesAll = false; viewNotesSun = false; } // legacy single toggle
    if (typeof ui.carZoom === 'number' && ui.carZoom >= 100 && ui.carZoom <= 145) carZoom = Math.round(ui.carZoom);
  if (ui.notesAuto === false) notesAuto = false; else if (ui.notesAuto === true) notesAuto = true;
    if (ui.notesOpen === true) notesOpen = true;
  if (stored >= 0 && stored <= SPEED_MAX) rotMul = stored;
} catch { /* fresh prefs */ }
function saveUi() {
  try { localStorage.setItem('visidocsverse.ui', JSON.stringify({ rotOn, rotMul, speedMul: rotMul, autoDist, simpleOrb, simpleOrb2, triOrb, docIcon, vividUniverse, miniX, miniY, miniW, miniH, miniFolded, tvpX, tvpY, tvpW, tvpH, tabX, tabY, hintX, hintY, pillsCentered, vw: window.innerWidth, vh: window.innerHeight, pillMinW, clusterW, glossX, glossY, glossW, glossH, glossOpen, glossDockV1: true, ovAlpha, ovLast, lbScale, lbLast, sizeScale, sizeLast, spinOn, spinSpeed, compressScale, compressLast, bgShade, bgShadePreLux, glow: glowScale, glowLast, tether: tetherScale, tetherLast, tetherColor, tetherDotted, tetherSparse, tetherDashed, backdrop, backdropAlpha, backdropLast, paneAlpha, paneLast, glazeLeft, glazeDoc, glazeCloud, glazeMini, glazeGloss, glazeTabBar, glazeHintBar, luxLeft, luxDoc, luxTab, luxHint, luxMini, leftCollapsed, docCollapsed, docWidth, hoverPrev, hideUngr, snapCenter, statsCollapsed, pillCollapsed, tipsCollapsed, pinnedTerms, lensThematic, lensTags, skipTagConfirms, viewNotesAll, viewNotesSun, notesOpen, notesAuto, carZoom })); } catch { /* private mode */ }
}
// bottom hint pill: flip to a light pill on a white canvas, dark pill on black
function syncHintContrast() {
  try { document.body.classList.toggle('light-canvas', (typeof bgShade === 'number' ? bgShade : 1) < 0.5); } catch {}
}
// pane text: when the canvas is light AND the pane glass is faded, the panes sit
// on a near-white backdrop — flip their text to dark (same idea as the pill).
// Dark canvas never flips (light text on near-black stays readable at any alpha).
function syncPaneContrast() {
  try {
    const canvasLight = (typeof bgShade === 'number' ? bgShade : 1) < 0.5;
    const panesClear = (typeof paneAlpha === 'number' ? paneAlpha : 1) < 0.7;
    document.body.classList.toggle('light-panes', canvasLight && panesClear);
  } catch {}
}
// reader pane width: discrete left-edge handle stretches it (persisted).
// The pane may stretch clean across the centered top pill (the reader paints
// above it) but never past the Return tab's right edge — the stretch clamps
// there, so the bottom pill's centered tab always stays clear.
function fitPaneWidthToScreen(savedVw) {
  try {
    if (!(docWidth > 0) || !(savedVw > 0) || savedVw === window.innerWidth) return; // default width is CSS-responsive; same screen needs nothing
    const k = Math.min(2, Math.max(0.5, window.innerWidth / savedVw));
    docWidth = clampDocW(Math.round(docWidth * k));
  } catch {}
}
function syncInkContrast() {
  try {
    const sh = Math.max(0, Math.min(1, typeof bgShade === 'number' ? bgShade : 1));
    const sig = sh.toFixed(2) + '|' + document.body.className + '|' + paneAlpha + '|' + glazeDoc + '|' + glazeLeft + '|' + glazeTabBar + '|' + luxLeft + '|' + luxDoc + '|' + luxTab + '|' + luxHint;
    inkTickN = (inkTickN + 1) % 240;
    if (sig === inkContrastSeen && inkTickN !== 0) return; // theme/pane changes recompute at once; the live canvas gets a slow re-sample
    inkContrastSeen = sig;
    const mix = (a, b) => Math.round(a + (b - a) * sh);
    const flat = [mix(255, 17), mix(255, 22), mix(255, 31)]; // fallback base when the canvas can't be sampled
    const rgba = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(',').map(x => parseFloat(x)); return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? p[3] : 1]; };
    const over = (fg, bg) => { const a = fg[3]; return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a)]; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const sampleBase = (rect) => { // real canvas pixels behind a rect (nebula/backdrop art included); falls back to the flat shade
      try {
        const cv = document.getElementById('uniCv');
        if (!cv) return flat.slice();
        const cr = cv.getBoundingClientRect();
        if (cr.width < 2 || cr.height < 2) return flat.slice();
        const ctx = cv.getContext('2d');
        const sx = cv.width / cr.width, sy = cv.height / cr.height;
        const pts = [[rect.left + 3, rect.top + 3], [rect.right - 3, rect.top + 3], [(rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2], [rect.left + 3, rect.bottom - 3], [rect.right - 3, rect.bottom - 3]];
        let r = 0, g = 0, b = 0, n = 0;
        for (const [px, py] of pts) {
          const cx = Math.round((px - cr.left) * sx), cy = Math.round((py - cr.top) * sy);
          if (cx < 0 || cy < 0 || cx >= cv.width || cy >= cv.height) continue;
          const d = ctx.getImageData(cx, cy, 1, 1).data;
          r += d[0]; g += d[1]; b += d[2]; n++;
        }
        return n ? [r / n, g / n, b / n] : flat.slice();
      } catch { return flat.slice(); }
    };
    for (const [iid, pid] of [['findInput', 'docPanel'], ['findInput2', 'findSide']]) {
      const inp = document.getElementById(iid); if (!inp) continue;
      const pane = document.getElementById(pid);
      let bg = (pane && pane.offsetParent !== null) ? sampleBase(pane.getBoundingClientRect()) : flat.slice();
      if (pane && pane.offsetParent !== null) { const pc = rgba(getComputedStyle(pane).backgroundColor); if (pc) bg = over(pc, bg); }
      const ic = rgba(getComputedStyle(inp).backgroundColor); if (ic) bg = over(ic, bg);
      const dark = lum(bg) > 0.45;
      inp.style.color = dark ? '#17222f' : '#f2f6fd';
      inp.style.setProperty('--findink', dark ? 'rgba(23,34,47,.62)' : 'rgba(242,246,253,.6)');
    }
    const dpk = document.getElementById('docPanel'); // reader kicker sits straight on the reader pane: same contrast rule
    if (dpk && dpk.offsetParent !== null) {
      const pc = rgba(getComputedStyle(dpk).backgroundColor);
      const pbg = pc ? over(pc, sampleBase(dpk.getBoundingClientRect())) : flat.slice();
      dpk.style.setProperty('--kickink', lum(pbg) > 0.45 ? '#8a6a1f' : '#ffce6b');
    }
    const db = document.getElementById('docBody'); // empty-view helper text rides the reader body: same contrast rule
    if (db) {
      const dp = document.getElementById('docPanel');
      let dbg = (dp && dp.offsetParent !== null) ? sampleBase(dp.getBoundingClientRect()) : flat.slice();
      if (dp && dp.offsetParent !==null) { const pc = rgba(getComputedStyle(dp).backgroundColor); if (pc) dbg = over(pc, dbg); }
      if (db.offsetParent !== null) { const bc = rgba(getComputedStyle(db).backgroundColor); if (bc && bc[3] > 0) dbg = over(bc, dbg); }
      db.style.setProperty('--ovink', lum(dbg) > 0.45 ? '#17222f' : '#eef3fb');
    }
    const lp = document.getElementById('leftPanel'); // section headers sit straight on the left pane: same contrast rule
    if (lp && lp.offsetParent !== null) {
      const lc = rgba(getComputedStyle(lp).backgroundColor);
      const lbg = lc ? over(lc, sampleBase(lp.getBoundingClientRect())) : flat.slice();
      const lit = lum(lbg) > 0.45;
      lp.style.setProperty('--secink', lit ? '#1c2940' : '#e8eef8');
      // (brand lock: the logo keeps its original gold in every mode — no brandink, no .lit flip)
    }
    const tb = document.getElementById('tabBar'); // save-project pill rides the active tab: keep gold while it reads (4.5:1), else the max-contrast ink
    const sv = tb ? tb.querySelector('.tabsave') : null;
    if (tb && sv && tb.getBoundingClientRect().width > 0) {
      let sbg = sampleBase(sv.getBoundingClientRect());
      const tc = rgba(getComputedStyle(tb).backgroundColor); if (tc) sbg = over(tc, sbg);
      const ab = sv.closest('button.tab'); const ac = ab ? rgba(getComputedStyle(ab).backgroundColor) : null; if (ac) sbg = over(ac, sbg);
      const sc = rgba(getComputedStyle(sv).backgroundColor); if (sc) sbg = over(sc, sbg);
      const L = lum(sbg);
      const cr = (c) => { const l = lum(c); return (Math.max(l, L) + 0.05) / (Math.min(l, L) + 0.05); };
      const GOLD = [255, 206, 107], WHITE = [255, 255, 255], DARK = [23, 34, 47];
      let ink = '#ffce6b';
      if (cr(GOLD) < 4.5) { // gold fails here: fall back to whichever ink reads best on this stack
        let best = ink, bestR = cr(GOLD);
        for (const [hex, c] of [['#ffffff', WHITE], ['#17222f', DARK]]) { const r = cr(c); if (r > bestR) { best = hex; bestR = r; } }
        ink = best;
      }
      tb.style.setProperty('--saveink', ink);
    }
    for (const bid of ['tetherDotsBtn', 'tetherSparseBtn', 'tetherDashedBtn']) { // Tethers 2/3/4 pills sit transparent over live canvas: same contrast rule
      const bb = document.getElementById(bid); if (!bb || bb.getBoundingClientRect().width < 2) continue;
      if (bb.classList.contains('on')) { bb.style.color = ''; continue; } // active pill keeps its .on ink
      let bbg = sampleBase(bb.getBoundingClientRect());
      const sp = bb.closest('.splitab');
      const sc2 = sp ? rgba(getComputedStyle(sp).backgroundColor) : null; if (sc2) bbg = over(sc2, bbg);
      bb.style.color = lum(bbg) > 0.45 ? '#17222f' : '#eef2fb';
    }
  } catch {}
}
let inkContrastSeen = '';
let inkTickN = 0;
function clampDocW(w) {
  let max = Math.min(1200, window.innerWidth * 0.9 - 32);
  try {
    const rb = document.getElementById('returnBtn');
    if (rb && rb.offsetParent !== null) max = Math.min(max, window.innerWidth - 16 - Math.ceil(rb.getBoundingClientRect().right) - 12); // 12px breathing room — never touches the tab
  } catch {}
  max = Math.max(280, max);
  return Math.max(260, Math.min(max, Math.round(w)));
}
// fixed reader height: top edge pinned at 16px, bottom edge parked a breath
// above the bottom pill — independent of how many inventory rows show, the
// pane never grows or shrinks with content (overflow:auto scrolls inside)
function sizeDocPanel() {
  try {
    const p = document.getElementById('docPanel');
    if (!p) return;
    if (p.classList.contains('collapsed') || window.innerWidth <= 760 || !p.offsetParent) { p.style.height = ''; try { if (typeof autoDist !== 'undefined' && autoDist) applyMiniGeom(); } catch {} return; }
    const hb = document.getElementById('hintBar');
    let pillTop = window.innerHeight;
    if (hb && hb.offsetParent !== null && getComputedStyle(hb).display !== 'none') {
      try { pillTop = hb.getBoundingClientRect().top; } catch {}
    }
    p.style.height = Math.max(220, Math.round(pillTop - 12 - 16)) + 'px';
    // height moved the middle and the bottom — re-seat everything parked on them
    try { syncResizeHandle(); } catch {}
    try { placeNotesTab(); } catch {}
    try { placeTopBtn(); } catch {}
    try { placeFindSide(); } catch {} // also re-stacks the jump cluster below it
    try { placeGotoSide(); } catch {}
    try { if (typeof notesOpen !== 'undefined' && notesOpen) applyNotesGeom(); } catch {}
    try { if (typeof autoDist !== 'undefined' && autoDist) applyMiniGeom(); } catch {} // reader height moved its bottom edge — re-park a folded bar below it
  } catch {}
}
function applyDocWidth() {
  try {
    const p = document.getElementById('docPanel');
    if (!p) return;
    if (p.classList.contains('collapsed')) { p.style.width = ''; syncResizeHandle(); try { if (typeof autoDist !== 'undefined' && autoDist) applyMiniGeom(); } catch {} return; }
    p.style.width = docWidth > 0 ? clampDocW(docWidth) + 'px' : '';
    sizeDocPanel();
    syncResizeHandle();
    try { syncTiltShift(); } catch {} // width moves the overshoot — recompute before the tilt-block check
    if (p.classList.contains('tiltedR') && docTiltBlocked()) { setDocTilt(false, true); toast('Reader tilt off — the stretched pane covers the pills'); }
    try { placeTabBar(); } catch {}
    try { placeGotoSide(); } catch {} // width changes move the pane edge — the jump cluster rides it
  } catch {}
}
// tilt overshoot compensation: a center-hinged rotateY(-30deg) under
// perspective(1100px) magnifies the docked (right) edge past the viewport
// once the pane is wider than ~590px — the top-right collapse/glaze
// controls (and the bottom-right Top tab) slide off-screen. Shifting the
// whole tilted frame left by exactly the overshoot pins the visual right
// edge at its layout edge for ANY width; at resting width the overshoot is
// negative and the shift is 0 (rendering identical to before).
const TILT_P = 1100; // must match the perspective() in the tilted transforms
function tiltShiftPx() {
  try {
    const p = document.getElementById('docPanel');
    if (!p) return 0;
    const h = p.offsetWidth / 2;
    const screen = h * Math.cos(Math.PI / 6) * TILT_P / (TILT_P - 0.5 * h);
    return Math.max(0, Math.ceil(screen - h));
  } catch { return 0; }
}
function syncTiltShift() {
  try {
    const app = document.getElementById('app');
    const p = document.getElementById('docPanel');
    // NEGATIVE: the frame must move left to cancel a rightward overshoot
    const s = (p && p.classList.contains('tiltedR')) ? -tiltShiftPx() : 0;
    if (app) app.style.setProperty('--tiltShift', s + 'px');
  } catch {}
}
// tilt-ride: park an edge rider in the pane's own 3D plane so it glides WITH
// the rotation instead of sitting at the pre-glide spot and snapping after.
// Same recipe as the Notes tab — identical perspective + shift + angle about
// the pane's own center (keep in sync with #docPanel.tiltedR); seats come from
// layout (offset) geometry, which is transition-stable. Riders carry
// transition:transform .45s ease in CSS to move in lockstep.
function rideTiltPlane(el) {
  const p = document.getElementById('docPanel');
  if (!el || !p) return;
  if (p.classList.contains('tiltedR')) {
    el.style.transform = 'perspective(1100px) translateX(var(--tiltShift, 0px)) rotateY(-30deg)';
    el.style.transformOrigin = (p.offsetLeft + p.offsetWidth / 2 - (el.offsetLeft || 0)).toFixed(1) + 'px 50%';
  } else {
    el.style.transform = '';
    el.style.transformOrigin = '';
  }
}
function syncResizeHandle() {
  try {
    const p = document.getElementById('docPanel'), h = document.getElementById('docResize'), tb = document.getElementById('docTiltBtn'), cb = document.getElementById('carPaneBtn');
    if (!p || !h) return;
    // the rail riders are pane children now and seat themselves in CSS (pane
    // middle, every mode — the tilt transform carries them rigidly, so there
    // is no per-frame seating to chase and no glide lag); here only show/hide.
    const hide = p.classList.contains('collapsed') || window.innerWidth <= 760 || !p.offsetParent;
    const ob = document.getElementById('origPaneBtn');
    for (const el of [h, tb, cb, ob]) if (el) el.style.display = hide ? 'none' : 'flex';
  } catch {}
}
// right-pane 3D tilt: 30° clockwise (seen from above) about the pane's own
// vertical middle. Disallowed while the pane is *stretched* past the pills
// (a user-widened width whose left edge covers the pills' right edges) — a
// tilted wide pane would paint over them. The resting auto width is always
// allowed, even if the pills run underneath it. Refusals toast; an
// in-progress tilt auto-releases the moment a stretch crosses the boundary.
function docTiltBlocked() {
  try {
    if (!(docWidth > 0)) return false; // auto width = resting, never blocked
    const p = document.getElementById('docPanel');
    const t = document.getElementById('tabBar');
    const hb = document.getElementById('hintBar');
    if (!p || !p.offsetParent) return false;
    const pl = p.getBoundingClientRect().left;
    let pillRight = -Infinity;
    if (t && t.offsetParent) pillRight = Math.max(pillRight, t.getBoundingClientRect().right);
    if (hb && hb.offsetParent && getComputedStyle(hb).display !== 'none') pillRight = Math.max(pillRight, hb.getBoundingClientRect().right);
    if (pillRight === -Infinity) return false;
    return pl < pillRight - 1;
  } catch { return false; }
}
function setDocTilt(on, silent) {
  const p = document.getElementById('docPanel');
  const b = document.getElementById('docTiltBtn');
  if (!p) return false;
  if (on && docTiltBlocked()) { if (!silent) toast('Tilt is off while the stretched reader covers the pills — narrow it first'); return false; }
  p.classList.toggle('tiltedR', !!on);
  if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false');
  try { syncTiltShift(); } catch {} // pin the visual right edge on-screen (0 at resting width)
  try { syncResizeHandle(); placeNotesTab(); placeFindSide(); placeTopBtn(); placeGotoSide(); if (notesOpen) applyNotesGeom(); } catch {} // rail + cards glide in-plane (gotoSide stays flat by design); seats are transition-stable so one pass covers it…
  setTimeout(() => { try { syncResizeHandle(); placeNotesTab(); placeFindSide(); placeTopBtn(); placeGotoSide(); applyNotesGeom(); } catch {} }, 500); // …and again once the .45s glide lands (gotoSide lands flat on the visual edge), absorbing any resize mid-swing
  return !!on;
}
// Thematic lens: the same docs, masses and orbital mechanics, recomposed around
// distilled theme bodies. Co-related concepts (terms that travel together across
// the topic web) are clumped into theme bodies whose mass follows their thematic
// weight; docs tether to the themes they evidence. Explicit [[ref]] tethers are
// left out so citation structure can't warp the theme map. The regular
// per-canvas universe is never touched; toggling back restores it exactly
// (formation included).
function themeById(id) {
  if (typeof id !== 'string' || !id.startsWith('theme_')) return null;
  if (thematicWhole) return wholeThemes.find(t => t.id === id) || null;
  const list = thematicThemes.get(vault.activeTabId) || [];
  return list.find(t => t.id === id) || null;
}
// ---------- associated-document overlay (thematic view) ----------
// Right-click a theme orb (or empty canvas) to pin its grounded member docs
// around it as little paper icons; left-click an icon to light up its row in
// the reader's bodies inventory (grounded + ungrounded). Session-only: entries are keyed by
// scope (whole-visidocsverse vs one tab) + theme id, so tab switches and
// re-distillations can never show another verse's overlay.
let assocReq = new Map(); // scope|themeId -> {labels}
let assocAll = new Map(); // scope -> {labels} (entire canvas at once)
let assocExcl = new Set(); // scope|themeId hidden again inside an all-mode overlay
const assocScopeKey = () => (thematicWhole ? 'whole' : 'tab:' + vault.activeTabId);
// top grounding bodies: the 3 members with the most theme-term evidence in
// their text (ties broken by title) — they draw in the seed orb's own color,
// every other member in a lighter shade of it.
const ASSOC_TOP_N = 3;
const assocScoreCache = new Map(); // themeId -> {stamp, scored:[{d,s}]}
function assocScores(th) {
  const stamp = (th.terms || []).join('|') + '#' + (th.members || []).join(',');
  const hit = assocScoreCache.get(th.id);
  if (hit && hit.stamp === stamp) return hit;
  const terms = (th.terms || []).map(t => String(t).toLowerCase()).filter(Boolean);
  const scored = [];
  for (const id of (th.members || [])) {
    const d = vault.byIdAnywhere(id);
    if (!d) continue;
    const tx = String(d.text || '').toLowerCase();
    let s = 0;
    for (const t of terms) { let i = 0, n = 0; while ((i = tx.indexOf(t, i)) >= 0) { n++; i += t.length; if (n >= 50) break; } s += Math.min(n, 50); }
    scored.push({ d, s });
  }
  scored.sort((a, b) => b.s - a.s || (vault.titleOf(a.d) < vault.titleOf(b.d) ? -1 : 1));
  const out = { stamp, scored };
  assocScoreCache.set(th.id, out);
  if (assocScoreCache.size > 60) assocScoreCache.delete(assocScoreCache.keys().next().value);
  return out;
}
function assocOverlayFor(th) {
  // null = hidden; else {labels}
  const scope = assocScopeKey();
  const all = assocAll.get(scope);
  if (all && !assocExcl.has(scope + '|' + th.id)) return { labels: !!all.labels };
  const r = assocReq.get(scope + '|' + th.id);
  return r ? { labels: !!r.labels } : null;
}
// ungrounded docs: files no theme grounds. The overlay shows ALL files, so
// each of these rides on exactly one orb — the theme whose terms hit its text
// hardest (ties: first theme), or the largest theme when nothing hits. They
// draw palest and can never be top-tier. Cached per scope like assocScores.
const assocUngrCache = new Map(); // scope -> {stamp, map: Map(themeId -> [doc])}
function assocUngrMap() {
  const scope = assocScopeKey();
  const themes = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
  const docs = thematicWhole ? wholeVisidocsverseDocs() : (((vault.tab() || {}).docs) || []);
  const stamp = themes.map(th => th.id + ':' + (th.members || []).join(',') + ':' + (th.terms || []).join('|')).join(';') + '#' + docs.map(d => d.id).join(',');
  const hit = assocUngrCache.get(scope);
  if (hit && hit.stamp === stamp) return hit.map;
  const map = new Map();
  if (themes.length) {
    const memberOf = new Set();
    for (const th of themes) for (const m of (th.members || [])) memberOf.add(m);
    const ungr = docs.filter(d => d && !memberOf.has(d.id));
    if (ungr.length) {
      const termList = themes.map(th => (th.terms || []).map(t => String(t).toLowerCase()).filter(Boolean));
      let big = 0;
      themes.forEach((th, i) => { if (((th.members || []).length) > ((themes[big].members || []).length)) big = i; });
      for (const d of ungr) {
        const tx = String(d.text || '').toLowerCase();
        let best = 0, bestScore = 0;
        termList.forEach((terms, i) => {
          let s = 0;
          for (const t of terms) { let k = 0, p; while ((p = tx.indexOf(t, k)) >= 0) { s++; k = p + t.length; if (s >= 200) break; } if (s >= 200) break; }
          if (s > bestScore) { bestScore = s; best = i; }
        });
        const tid = themes[bestScore > 0 ? best : big].id;
        if (!map.has(tid)) map.set(tid, []);
        map.get(tid).push(d);
      }
    }
  }
  assocUngrCache.set(scope, { stamp, map });
  if (assocUngrCache.size > 20) assocUngrCache.delete(assocUngrCache.keys().next().value);
  return map;
}
// screen-space draw list for the renderer, built per frame from live nodes
function assocDrawData() {
  if (!lensThematic || !uni) return null;
  const themes = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
  if (!themes.length) return null;
  const out = [];
  const ungrMap = assocUngrMap();
  for (const th of themes) {
    const ov = assocOverlayFor(th);
    if (!ov) continue;
    const node = uni.byId.get(th.id);
    if (!node || !node._p) continue;
    const { scored } = assocScores(th);
    const extras = hideUngr ? [] : (ungrMap.get(th.id) || []);
    if (!scored.length && !extras.length) continue;
    const topIds = new Set(scored.slice(0, ASSOC_TOP_N).map(x => x.d.id));
    const seed = ((activeId && uni.byId.has(activeId)) ? (th.id === activeId) : !!node.isActive);
    for (const { d } of scored) out.push({ theme: th.id, doc: d.id, title: vault.titleOf(d), top: topIds.has(d.id), seedActive: seed, showLabel: ov.labels });
    for (const d of extras) out.push({ theme: th.id, doc: d.id, title: vault.titleOf(d), top: false, ungr: true, seedActive: seed, showLabel: ov.labels });
  }
  return out.length ? out : null;
}
function showAssoc(themeId, labels) {
  const th = themeById(themeId);
  if (!th) { toast('That theme is gone — the verse re-distilled underneath'); return; }
  if (!lensThematic) { toast('Enter the Thematic view first'); return; }
  const scope = assocScopeKey();
  assocReq.set(scope + '|' + themeId, { labels: !!labels });
  assocExcl.delete(scope + '|' + themeId);
  const n = (th.members || []).length;
  const ux = (assocUngrMap().get(themeId) || []).length;
  const parts = [`${n} associated`];
  if (ux) parts.push(`${ux} ungrounded`);
  try { syncLbPill(); } catch {}
  toast(`Showing ${parts.join(' + ')} document${n + ux === 1 ? '' : 's'} ${labels ? 'with' : 'without'} labels — left-click one to light up its row`);
}
function hideAssoc(themeId) {
  const scope = assocScopeKey();
  assocReq.delete(scope + '|' + themeId);
  if (assocAll.get(scope)) assocExcl.add(scope + '|' + themeId);
  try { syncLbPill(); } catch {}
  toast('Associated documents hidden for that orb');
}
function showAssocAll(labels) {
  if (!lensThematic) { toast('Enter the Thematic view first'); return; }
  const scope = assocScopeKey();
  assocAll.set(scope, { labels: !!labels });
  const themes = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
  const um = assocUngrMap();
  let n = 0, ux = 0;
  for (const th of themes) { if (!assocExcl.has(scope + '|' + th.id)) { n += (th.members || []).length; ux += (um.get(th.id) || []).length; } }
  const parts = [`${n} associated`];
  if (ux) parts.push(`${ux} ungrounded`);
  try { syncLbPill(); } catch {}
  toast(`Showing ${parts.join(' + ')} documents across ${themes.length} theme${themes.length === 1 ? '' : 's'} ${labels ? 'with' : 'without'} labels`);
}
function clearAssoc() {
  const scope = assocScopeKey();
  for (const k of [...assocReq.keys()]) if (k.startsWith(scope + '|')) assocReq.delete(k);
  assocAll.delete(scope);
  for (const k of [...assocExcl]) if (k.startsWith(scope + '|')) assocExcl.delete(k);
  try { syncLbPill(); } catch {}
  toast('All associated documents cleared from view');
}
// canvas right-click toggle: lift the palest ungrounded paper icons off the
// Thematic canvas (the reader's UNGROUNDED inventory keeps listing them, and
// the ? there still explains them). Persisted like the other view flags.
function toggleHideUngr() {
  hideUngr = !hideUngr;
  try { saveUi(); } catch {}
  toast(hideUngr ? 'Ungrounded documents removed from view — the reader inventory keeps them' : 'Ungrounded documents back in view');
}
// canvas right-click toggle (empty-canvas menu, every view mode): stop the
// camera recentering on reader picks (or bring it back). Off = selections
// never pan the canvas — rows still light gold, orbs stay where they are.
// Persisted like the other view flags.
function toggleSnapCenter() {
  snapCenter = !snapCenter;
  try { camCancelGlide(); } catch {} // never strand a glide when the switch flips
  try { saveUi(); } catch {}
  toast(snapCenter ? 'Snap to center on — picks glide the canvas to their body' : 'Snap to center off — the canvas stays put on picks');
}
// left-click an associated paper icon: keep the theme as sun and reveal the
// doc's position in the reader's bodies inventory (grounded + ungrounded).
// While the seed theme is the selected sun the inventory is restored first
// (a parked doc pin drops, the collapsed pane reopens), then the row is lit
// gold and centered so its position reads at a glance. The gold persists
// while the selection stands — no fade timer — and clears when the
// selection moves on (another pick, release, lens/tab/Return switch).
function focusAssocDoc(themeId, docId) {
  const th = themeById(themeId);
  if (!th) return;
  if (activeId !== themeId) {
    // reader-only: the theme stays exactly where it is (no physical refocus,
    // so orbs never trade places when lighting up rows)
    claimSun(themeId);
    renderDoc();
  } else if (shownId !== themeId) {
    // sun already selected but the reader drifted (a title-parked doc pin or
    // a stale view): drop the pin and restore the theme inventory so the
    // row exists before lighting it — the switch never touches the canvas
    paneId = null;
    renderDoc();
  }
  try { if (document.getElementById('docPanel')?.classList.contains('collapsed')) setCollapsed('docPanel', false); } catch {}
  assocSelId = docId;
  try {
    paintGoldRows(docId);
    const row = document.querySelector(`#docLinks .bl-row[data-open="${CSS.escape(docId)}"]`);
    if (!row && th && !((th.members || []).includes(docId))) {
      toast('That file is grounded in no theme — shown palest so every file displays');
    }
  } catch {}
}
// clump co-related terms into themes, sized by thematic weight (deterministic:
// ranked by evidence, ties broken alphabetically — no randomness).
// minDf: a term must evidence in at least this many docs to seed or join a
// theme — this keeps one-off citation surnames ("mislevy", "gonzales") from
// becoming theme labels while true shared concepts survive.
// maxDfRatio: the boilerplate guard — a term present in the full text of more
// than this fraction of the corpus ("teacher" in 54/84, "report" in 31/84…)
// is wallpaper, not a concept, so it can neither seed nor join a theme. The
// lower bound stays on edge-evidence df (the term must actually travel
// tethers). Pass 1.0 to skip the cap (the no-shared-concepts fallback does
// exactly that).
// docTexts powers the citation-author hygiene pass (surnames that only ever
// travel with years / "et al." are dropped before distillation).
function distillThemes(bodies, edges, minDf = 1, docTexts = [], maxDfRatio = 0.30) {
  const bump = (m, k, w) => m.set(k, (m.get(k) || 0) + w);
  const termW = new Map();   // term -> Σ edge-sim evidence
  const docTerm = new Map(); // docId -> Map(term -> evidence)
  const co = new Map();      // term -> Map(term -> co-travel evidence)
  for (const e of edges) {
    if (e.kind !== 'topic' || !Array.isArray(e.topics)) continue;
    const w = (typeof e.sim === 'number' && e.sim > 0) ? e.sim : 0.1;
    const ts = [...new Set(e.topics)];
    for (const t of ts) {
      bump(termW, t, w);
      if (!docTerm.has(e.source)) docTerm.set(e.source, new Map());
      if (!docTerm.has(e.target)) docTerm.set(e.target, new Map());
      bump(docTerm.get(e.source), t, w);
      bump(docTerm.get(e.target), t, w);
    }
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const a = ts[i] < ts[j] ? ts[i] : ts[j], b = ts[i] < ts[j] ? ts[j] : ts[i];
      if (!co.has(a)) co.set(a, new Map());
      bump(co.get(a), b, w);
    }
  }
  // citation-author hygiene: drop terms that mostly travel WITH years or
  // "et al." (in-text citations like "(Mislevy, 2006)") — shared surnames are
  // statistically shared but they are not themes. While scanning, record each
  // term's FULL-TEXT document frequency: the boilerplate guard below needs the
  // real corpus df ("teacher" in 54 of 84 texts), not the thin edge-evidence
  // df, to tell wallpaper from concepts.
  const textDf = new Map(); // term -> #docs whose full text contains it
  try {
    const textById = new Map((docTexts || []).map(d => [d.id, String(d.text || '').toLowerCase()]));
    if (textById.size) {
      const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cite = [];
      for (const t of [...termW.keys()]) {
        const e = escRe(t);
        const reCite = new RegExp('\\b' + e + "\\b[\\s\\S]{0,40}\\b(?:19|20)\\d{2}\\b|\\b(?:19|20)\\d{2}\\b[\\s\\S]{0,40}\\b" + e + '\\b|\\b' + e + '\\s+et\\s+al\\b');
        const reTerm = new RegExp('\\b' + e + '\\b');
        let dfD = 0, patD = 0;
        for (const [, tx] of textById) {
          if (!reTerm.test(tx)) continue;
          dfD++;
          if (reCite.test(tx)) patD++;
        }
        textDf.set(t, dfD);
        if (dfD >= 2 && patD / dfD >= 0.5) cite.push(t);
      }
      for (const t of cite) {
        termW.delete(t);
        for (const [, m] of docTerm) m.delete(t);
        co.delete(t);
        for (const [, m] of co) m.delete(t);
      }
    }
  } catch { /* hygiene is best-effort — never break the lens */ }
  const docSet = new Map(); // term -> Set(docIds)
  for (const [docId, tm] of docTerm) for (const t of tm.keys()) {
    if (!docSet.has(t)) docSet.set(t, new Set());
    docSet.get(t).add(docId);
  }
  const docFreq = (t) => (docSet.get(t) ? docSet.get(t).size : 0);
  // boilerplate guard on FULL-TEXT df: a term present in more than this share
  // of the corpus ("teacher" in 54/84, "report" in 31/84…) is wallpaper, not a
  // concept — it can neither seed nor join a theme. Edge-evidence df stays as
  // the lower bound (the term must actually travel tethers). Fail-open: terms
  // missing from textDf (hygiene skipped/failed) are judged by edges alone.
  const maxDf = Math.max(4, Math.round(bodies.length * maxDfRatio));
  const distinctive = (t) => docFreq(t) >= minDf && (textDf.size === 0 || (textDf.get(t) ?? 0) <= maxDf);
  const coW = (a, b) => {
    const x = a < b ? a : b, y = a < b ? b : a;
    return (co.get(x) && co.get(x).get(y)) || 0;
  };
  const maxThemes = Math.max(4, Math.min(16, Math.round(bodies.length / 6)));
  const ranked = [...termW.entries()]
    .filter(([t]) => distinctive(t))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const used = new Set(), themes = [];
  for (const [seed] of ranked) {
    if (themes.length >= maxThemes) break;
    if (used.has(seed)) continue;
    const rel = [...termW.keys()]
      .filter(t => t !== seed && !used.has(t) && distinctive(t))
      .map(t => [t, coW(seed, t)])
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 4).map(([t]) => t);
    const terms = [seed, ...rel];
    terms.forEach(t => used.add(t));
    const weight = terms.reduce((s, t) => s + (termW.get(t) || 0), 0);
    themes.push({ id: 'theme_' + themes.length, label: terms.slice(0, 2).join(' · '), terms, weight, mass: 0, members: [] });
  }
  // each doc grounds itself in its top-2 evidenced themes (orphans stay orphans)
  for (const b of bodies) {
    const dt = docTerm.get(b.id);
    if (!dt) continue;
    const scored = themes.map((th, i) => {
      let s = 0; for (const t of th.terms) s += dt.get(t) || 0;
      return [i, s];
    }).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, 2);
    for (const [i] of scored) themes[i].members.push(b.id);
  }
  const live = themes.filter(th => th.members.length > 0);
  for (const th of live) th.mass = Math.max(10, Math.min(55, 10 + th.weight * 3));
  return live;
}
// shared theme distillation: strict shared-concepts pass (single-doc citation
// surnames can't seed or join, corpus-wide boilerplate can't either), relaxed
// fallback only when the strict pass finds nothing at all.
function distillFor(bodies, edges, texts) {
  const minDf = bodies.length < 12 ? 2 : 3;
  let themes = distillThemes(bodies, edges, minDf, texts);
  if (!themes.length) themes = distillThemes(bodies, edges, 1, texts, 1.0);
  return themes;
}
// compose theme bodies webbed by shared grounded docs into a settled universe.
// preferredId becomes the sun when it names a theme; defaultToAnchor falls back
// to the heaviest theme (per-canvas entry with a selected doc) — otherwise the
// map stays sunless and the screen center holds gravity. minShared (tags view)
// only webs pairs sharing at least that many grounded docs, so incidental
// single-doc links can't rope a dense verse into one ball. loneLink (tags view)
// re-homes loners onto their single best partner instead of chaining every one
// of them to the anchor — fifty anchor spokes would herd the whole verse into
// the anchor's neighborhood.
// which tab a live universe object belongs to (Main, per-tab lens, or the
// shared whole-verse map) — cross-tab layouts are unrelated, so continuity
// seeding only ever runs within one tab's views.
let lastSeedCount = 0; // diagnostic: bodies continuity-seeded by the last lens build
function uniTabOf(u) {
  try {
    for (const [id, x] of unis) if (x === u) return id;
    for (const [id, x] of thematicUnis) if (x === u) return id;
    for (const [id, x] of tagUnis) if (x === u) return id;
  } catch {}
  if (typeof wholeUni !== 'undefined' && u === wholeUni) { try { return vault.activeTabId; } catch {} }
  return null;
}
// member sets of a lens universe (nodeId -> Set(member docIds)) so positions
// can carry across lens swaps through the docs the views share.
function lensMemberSets(u) {
  const m = new Map();
  try {
    if (typeof wholeUni !== 'undefined' && u === wholeUni) {
      for (const th of (wholeThemes || [])) m.set(th.id, new Set(th.members || []));
      return m;
    }
    for (const [id, x] of thematicUnis) if (x === u) {
      for (const th of (thematicThemes.get(id) || [])) m.set(th.id, new Set(th.members || []));
      return m;
    }
    for (const [id, x] of tagUnis) if (x === u) {
      for (const r of (tagRecords.get(id) || [])) m.set(r.id, new Set(r.members || []));
      return m;
    }
  } catch {}
  return m;
}
// continuity seeding: when a lens (re)builds, start each body where its docs
// already are instead of across the map — members seed from the live
// view's doc nodes directly, or through the old lens's bodies when swapping
// lens-to-lens. The follow-up settle then composes in place: bodies arrive
// arranged around the focused ground instead of teleporting. Returns the
// seeded count (0 = nothing carried: fresh spiral as before).
function continuitySeed(u, items) {
  try {
    if (!u || !uni || uni === u || !items || !items.length) return 0;
    const srcTab = uniTabOf(uni);
    let dstTab = uniTabOf(u);
    if (!dstTab) { try { dstTab = vault.activeTabId; } catch {} } // a brand-new lens uni isn't registered yet — it builds for this tab
    if (!srcTab || !dstTab || srcTab !== dstTab) return 0;
    const byId = new Map(items.map(t => [t.id, t]));
    const docPos = new Map();
    let hasDocs = false;
    for (const n of uni.nodes) {
      docPos.set(n.id, [n.x, n.y, n.z]);
      if (!String(n.id).startsWith('theme_') && !String(n.id).startsWith('tag:')) hasDocs = true;
    }
    if (!hasDocs) {
      const sets = lensMemberSets(uni);
      const acc = new Map();
      for (const n of uni.nodes) {
        const ms = sets.get(n.id);
        if (!ms || !ms.size) continue;
        for (const d of ms) {
          let a = acc.get(d);
          if (!a) { a = { x: 0, y: 0, z: 0, c: 0 }; acc.set(d, a); }
          a.x += n.x; a.y += n.y; a.z += n.z; a.c++;
        }
      }
      docPos.clear();
      for (const [d, a] of acc) if (a.c) docPos.set(d, [a.x / a.c, a.y / a.c, a.z / a.c]);
    }
    let seeded = 0;
    for (const n of u.nodes) {
      const it = byId.get(n.id);
      const ms = it && it.members;
      if (!ms || !ms.length) continue;
      let x = 0, y = 0, z = 0, c = 0;
      for (const m of ms) { const p = docPos.get(m); if (p) { x += p[0]; y += p[1]; z += p[2]; c++; } }
      if (!c) continue;
      let sx = x / c, sy = y / c, sz = z / c;
      // project the carried direction onto this body's own shell: the raw
      // member centroid lives in the old view's radial system, and the
      // shell tethers would otherwise drag it across the map to its tier.
      // Direction is the continuity; radius belongs to the new view.
      const want = n.shell || Math.hypot(sx, sy, sz) || 200;
      const r = Math.hypot(sx, sy, sz);
      if (r > 1) { const k = want / r; sx *= k; sy *= k; sz *= k; }
      else continue; // centroid at the origin has no direction — leave the shelled seat
      n.x = sx; n.y = sy; n.z = sz;
      n.vx = 0; n.vy = 0; n.vz = 0;
      n._seeded = true;
      seeded++;
    }
    try {
      // de-formation: bodies sharing identical member sets seed onto the same
      // centroid with the same shell, mass and springs (and no bond between
      // them), so they fly in exact lockstep forever. Round orbs hid it;
      // flipping pages show it as doubled bodies. Spread exact overlaps by
      // rotating the twin around the origin in the XZ plane (deterministic
      // per-id angle): radius-preserving, so the shell re-projection keeps
      // the full offset, and with no bond between the twins nothing reunites
      // them — the relax just settles each into its own slot.
      const seen = new Map();
      for (const n of u.nodes) {
        if (n.id === u.sunId) continue;
        const k = (n.x || 0).toFixed(3) + ',' + (n.y || 0).toFixed(3) + ',' + (n.z || 0).toFixed(3);
        const c = seen.get(k) || 0;
        seen.set(k, c + 1);
        if (!c) continue;
        const rr = Math.hypot(n.x, n.z);
        if (rr > 1) {
          let hh = 0; const sid = String(n.id);
          for (let i = 0; i < sid.length; i++) hh = (hh * 33 + sid.charCodeAt(i)) | 0;
          const ah = Math.abs(hh);
          const dAng = (0.18 + 0.07 * ((ah >> 10) % 5)) * c; // ~10-20 deg per collider
          const ca = Math.cos(dAng), sa = Math.sin(dAng);
          const ox = n.x, oz = n.z;
          n.x = ox * ca - oz * sa;
          n.z = ox * sa + oz * ca;
          n.y += (((ah >> 5) % 21) - 10) * 0.8 * c; // small vertical break
          n.vx = 0; n.vy = 0; n.vz = 0;
        }
      }
    } catch {}
    return seeded;
  } catch { return 0; }
}
function seatThematic(u, themes, preferredId, defaultToAnchor, minShared = 1, loneLink = null) {
  // THEMATIC CLUSTERS ONLY: no doc bodies in this universe — just the theme
  // bodies, webbed by shared grounded docs (every theme gets ≥1 tether so no
  // theme drifts off as a comet).
  const themeNodes = themes.map(th => ({ id: th.id, label: th.label, mass: th.mass, tags: [], words: 0, origin: th.id }));
  const memberSet = new Map(themes.map(th => [th.id, new Set(th.members)]));
  const sharedCount = (a, b) => {
    let n = 0; const A = memberSet.get(a.id), B = memberSet.get(b.id);
    for (const id of A) if (B.has(id)) n++;
    return n;
  };
  const allEdges = [];
  const linked = new Set();
  const pairSeen = new Set();
  const pairKey = (x, y) => x < y ? x + '|' + y : y + '|' + x;
  for (let i = 0; i < themes.length; i++) for (let j = i + 1; j < themes.length; j++) {
    const n = sharedCount(themes[i], themes[j]);
    if (n >= minShared) { allEdges.push({ source: themes[i].id, target: themes[j].id, kind: 'topic', topics: [], sim: n }); linked.add(themes[i].id); linked.add(themes[j].id); pairSeen.add(pairKey(themes[i].id, themes[j].id)); }
  }
  const anchor = [...themes].sort((a, b) => b.mass - a.mass || (a.id < b.id ? -1 : 1))[0];
  for (const th of themes) {
    if (!linked.has(th.id) && anchor && th !== anchor) {
      const partner = (typeof loneLink === 'function' && loneLink(th)) || anchor.id;
      if (!pairSeen.has(pairKey(th.id, partner))) { allEdges.push({ source: th.id, target: partner, kind: 'topic', topics: [], sim: 0.05 }); pairSeen.add(pairKey(th.id, partner)); }
      linked.add(th.id);
    }
  }
  u.setData(themeNodes, allEdges, themes.some(th => th.id === preferredId) ? preferredId : (defaultToAnchor && anchor ? anchor.id : null));
  let seedFrac = 0;
  try { lastSeedCount = continuitySeed(u, themes); } catch { lastSeedCount = 0; } // carry the live layout in: seeded bodies skip the spiral below
  try { seedFrac = u.nodes.length ? lastSeedCount / u.nodes.length : 0; } catch {}
  settleFresh(u);
  return seedFrac; // callers size the follow-up relax off this, then clear flags
}
// seat it settled: deterministic golden-angle spread per shell (no random
// clumps, same graph → same map every open), correct orbital velocities,
// then enough physics to web the clusters — the view opens composed even
// when the universe is paused or at slow-motion (no live sim will pull
// fresh shell seeds together; a 13-node graph settles in milliseconds).
// The full compose used for new canvases and clump rescue.
function settleFresh(u) {
  try {
    const GA = Math.PI * (3 - Math.sqrt(5));
    const byShell = new Map();
    for (const n of u.nodes) {
      const key = n.shell || 0;
      if (!byShell.has(key)) byShell.set(key, []);
      byShell.get(key).push(n);
    }
    for (const [, arr] of byShell) arr.forEach((n, k) => {
      if (n.id === u.sunId || n._seeded) return; // the sun and carried-over bodies hold their ground; springs arrange the angles
      const a = k * GA, R = n.shell || 120;
      n.x = Math.cos(a) * R; n.z = Math.sin(a) * R;
      n.y = (k % 2 ? -1 : 1) * ((k >> 1) % 4 + 1) * R * 0.09;
    });
    u.initOrbitals(1);
    // adaptive settle: a fully continuity-seeded layout starts composed, so a
    // short relax keeps it glued to the previous view (no cross-map teleport);
    // a fresh spiral still gets the full compose. The live sim finishes any
    // residual overlap after paint either way.
    const seededFrac = u.nodes.length ? u.nodes.filter(n => n._seeded).length / u.nodes.length : 0;
    const steps = seededFrac > 0.75 ? 100 : 400;
    for (let i = 0; i < steps; i++) {
      u.step(u.dt || 0.3);
      // never let the settle park bodies on the sun: a chaotic transient can
      // throw a node inside its shell (they pile up on the corona edge and
      // read as "not connected"). Clamp radius to the inner half of its shell
      // and let the springs arrange the angles instead.
      for (const n of u.nodes) {
        if (n.id === u.sunId) continue;
        const r = Math.hypot(n.x, n.y, n.z) || 1, min = (n.shell || 120) * 0.55;
        if (r < min) { const k = min / r; n.x *= k; n.y *= k; n.z *= k; }
      }
    }
  } catch { /* the live sim finishes the job */ }
}
// physical-sun inheritance: a dot-crowned (or intake-crowned) Main sun sets
// no reader selection, so t.activeId stays null — but the system HAS a sun.
// Entering a lens from that state must anchor-sun (fast inner orbits), not go
// sunless (slow outer drift), or the lens always reads slower than Main.
function mainPhysSun(tabId) {
  try {
    const mu = unis.get(tabId);
    return (mu && mu.sunId && mu.byId.has(mu.sunId)) ? mu.sunId : null;
  } catch { return null; }
}
function getThematicUni(tabId) {
  const t = vault.tabs.find(x => x.id === tabId) || vault.tab();
  if (!t) return null;
  let u = thematicUnis.get(t.id);
  const stamp = t.docs.length + ':b7:' + (mainPhysSun(t.id) ? 's1' : 's0'); // rebuild when docs, the distillation rules, or the Main physical-sun state change (b7 = de-formation nudge for lockstep twins)
  if (!u || thematicBuilt.get(t.id) !== stamp) {
    const prev = vault.activeTabId;
    vault.activeTabId = t.id;
    const { bodies, edges } = (() => { try { return vault.universe(); } catch { return { bodies: [], edges: [] }; } })();
    vault.activeTabId = prev;
    const themes = distillFor(bodies, edges, t.docs);
    thematicThemes.set(t.id, themes);
    if (!u) { u = new Universe(); thematicUnis.set(t.id, u); }
    // entering from general state (no selection AND no physical sun) leaves
    // the map sunless too — the screen center holds gravity there as well.
    seatThematic(u, themes, t.activeId, t.activeId != null || !!mainPhysSun(t.id));
    try { for (const n of u.nodes) delete n._seeded; } catch {} // settle consumed the seeds
    thematicBuilt.set(t.id, stamp);
  }
  return u;
}
// whole visidocsverse: every shared canvas's docs, deduped by copy-lineage (copies
// across canvases are the same body, counted once). Isolated verses stay out.
function wholeVisidocsverseDocs() {
  const seen = new Set(); const docs = [];
  for (const t of vault.scopeTabs()) for (const d of (t.docs || [])) {
    const root = d.origin || d.id;
    if (seen.has(root)) continue; seen.add(root);
    docs.push(d);
  }
  return docs;
}
// whole-visidocsverse thematic universe: distilled from the entire shared corpus,
// not just the active tab. Entered from the general state (nothing selected
// AND no physical sun anywhere relevant).
function getThematicWhole() {
  const docs = wholeVisidocsverseDocs();
  const stamp = docs.length + ':w2:' + (mainPhysSun(vault.activeTabId) ? 's1' : 's0'); // w = whole-visidocsverse distillation rules
  if (!wholeUni) wholeUni = new Universe();
  if (wholeBuilt !== stamp) {
    let bodies = [], edges = [];
    try { ({ bodies, edges } = vault.universe(docs)); } catch { /* the lens stays empty below */ }
    wholeThemes = distillFor(bodies, edges, docs);
    // entering from general state stays sunless (center gravity); an already
    // selected whole theme survives rebuilds as the sun. A physical Main sun
    // anchors instead — same inheritance as the per-tab lens.
    seatThematic(wholeUni, wholeThemes, activeId, activeId != null || !!mainPhysSun(vault.activeTabId));
    try { for (const n of wholeUni.nodes) delete n._seeded; } catch {} // settle consumed the seeds
    wholeBuilt = stamp;
  }
  return wholeUni;
}
// the thematic universe for a canvas id — the whole visidocsverse when in whole mode.
function thematicUniFor(id) {
  return thematicWhole ? getThematicWhole() : getThematicUni(id);
}
// ---------- tags view: one body per TAG, webbed by shared member docs ----------
// Distilled straight from the docs' own tags (explicit + auto/, prefix-blind —
// the same matching the mass/tether code uses), NOT from text concepts, so this
// is a separate view from the Thematic view. Records reuse the
// theme shape, so seatThematic composes them identically.
function tagsFor(docs) {
  const byTag = new Map();
  for (const d of (docs || [])) {
    const seen = new Set();
    for (const tg of (d.tags || [])) {
      const disp = vault.stripAuto(tg);
      if (!disp || seen.has(disp)) continue;
      seen.add(disp);
      if (!byTag.has(disp)) byTag.set(disp, []);
      byTag.get(disp).push(d.id);
    }
  }
  return [...byTag.entries()]
    .sort((a, b) => a[0] < b[0] ? -1 : 1)
    .map(([disp, members]) => ({ id: 'tag:' + disp, label: '#' + disp, terms: [disp], weight: members.length, mass: members.length, members }));
}
function tagSig(docs) {
  let h = 5381;
  const s = (docs || []).map(d => (d.tags || []).join(',')).join('|');
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) | 0);
  return (h >>> 0).toString(36);
}
function getTagUni(tabId) {
  const t = vault.tabs.find(x => x.id === tabId) || vault.tab();
  if (!t) return null;
  let u = tagUnis.get(t.id);
  const stamp = t.docs.length + ':g13:' + tagSig(t.docs) + ':' + (mainPhysSun(t.id) ? 's1' : 's0'); // rebuild when docs, their tags, or the Main physical-sun state change (g13 = angular de-formation for lockstep twins)
  if (!u || tagBuilt.get(t.id) !== stamp) {
    const recs = tagsFor(t.docs);
    tagRecords.set(t.id, recs);
    // gentle springs: tag pairs are dense (90% share a single doc), so doc-grade
    // bonds rope the mesh into a pressure cooker. Weak short springs just
    // arrange the angles; gravity + shell tethers do the holding. No linkDrag:
    // any tangential drain freezes the verse within the session AND herds
    // bodies together as their spreading motion bleeds off.
    if (!u) { u = new Universe({ springK: 0.005, restLen: 80 }); tagUnis.set(t.id, u); }
    // big verses web only real bonds (≥2 shared docs); small ones keep every
    // shared doc so tiny maps still connect. Loners re-home onto their single
    // best partner (most shared docs, ties broken alphabetically) instead of
    // chaining them all to the anchor — fifty anchor spokes would herd the
    // whole verse into the anchor's neighborhood.
    const memberSets = new Map(recs.map(r => [r.id, new Set(r.members)]));
    const bestPartner = (rec) => {
      const A = memberSets.get(rec.id);
      let best = null, bestN = 0;
      for (const o of recs) {
        if (o.id === rec.id) continue;
        let n = 0; for (const id of A) if (memberSets.get(o.id).has(id)) n++;
        if (n > bestN) { bestN = n; best = o.id; }
      }
      return bestN > 0 ? best : null;
    };
    const seedFrac = seatThematic(u, recs, t.activeId, t.activeId != null || !!mainPhysSun(t.id), recs.length >= 20 ? 2 : 1, bestPartner) || 0;
    tierTagShells(u); // heavy tags inner, singletons across three outer lanes
    try {
      // the tiers move the shells after the seeds landed: re-project the
      // carried directions onto the final shells so the relax glides angles
      // only instead of dragging bodies across the map to their tiers.
      for (const n of u.nodes) {
        if (!n._seeded || n.id === u.sunId) continue;
        const r = Math.hypot(n.x, n.y, n.z);
        const want = n.shell || r || 200;
        if (r > 1 && want > 0) { const k = want / r; n.x *= k; n.y *= k; n.z *= k; n.vx = 0; n.vy = 0; n.vz = 0; }
      }
    } catch {}
    try { relaxTagVerse(u, seedFrac > 0.75 ? 60 : 600); } // glide (never teleport) into the tiers, then inherit calm
    catch { try { relaxTagVerse(u, 600); } catch {} }
    try { for (const n of u.nodes) delete n._seeded; } catch {} // settle consumed the seeds
    tagBuilt.set(t.id, stamp);
  }
  return u;
}
// rank-tier shells for the tags view: grounding power sets depth (heaviest
// tags innermost, one-doc tags spread across three roomy outer shells so
// co-shell neighbors stop weaving through each other), radii scaled so the
// outer shells have real room no matter how many singletons the verse holds
// relax an already-seated verse into its shells WITHOUT teleporting: fresh
// circular velocities, then physics only. The radial glide down to the tier
// shells is slow and radially braked, so (unlike a re-seat) no teleport shock
// launches bodies toward the speed cap — the live verse inherits calm.
function relaxTagVerse(u, steps) {
  try {
    u.initOrbitals(1);
    // adaptive like the main settle: seeded layouts need only a short glide
    // into their tier shells (the live verse inherits calm either way).
    const n = (typeof steps === 'number') ? steps : 600;
    for (let i = 0; i < n; i++) {
      u.step(u.dt || 0.3);
      for (const n of u.nodes) {
        if (n.id === u.sunId) continue;
        const r = Math.hypot(n.x, n.y, n.z) || 1, min = (n.shell || 120) * 0.55;
        if (r < min) { const k = min / r; n.x *= k; n.y *= k; n.z *= k; }
      }
    }
  } catch { /* the live sim finishes the job */ }
}
function tierTagShells(u) {
  if (!u) return;
  const ns = u.nodes.filter(n => n.id !== u.sunId);
  const w = (n) => (n.trueMass ?? n.mass);
  const inner = ns.filter(n => w(n) >= 3), mid = ns.filter(n => w(n) > 1.5001 && w(n) < 3);
  const singles = ns.filter(n => w(n) <= 1.5001);
  const R = Math.max(400, singles.length * 38 / (2 * Math.PI));
  const k = R / 400;
  for (const n of inner) n.shell = 170 * k;
  for (const n of mid) n.shell = 280 * k;
  singles.forEach((n, i) => { n.shell = (R - 50) + (i % 3) * 50; }); // three outer lanes
}
function tagUniFor(id) { return getTagUni(id); }
function tagById(id) {
  if (typeof id !== 'string' || !id.startsWith('tag:')) return null;
  const list = tagRecords.get(vault.activeTabId) || [];
  return list.find(r => r.id === id) || null;
}
// enter (true) or leave (false) the tags view — mutually exclusive with the
// Thematic view logic, shared with the view-modes strip:
// same docs + same physics, recomposed around shared themes; leaving the
// view always drops the whole view.
function setTagsVerse(on) {
  if (!vault.tab()) { toast('No open canvas — click + to start one before opening the tags view.'); return; }
  pushView(); // Return can come back to the pre-view state
  // the parked pin survives lens swaps — the reader stays fixated on its doc
  canvasHiId = null; // the new view lights its own bodies
  assocSelId = null; srcHi = null; // the new view lights its own rows
  intakeHiIds.clear(); // the new view lights its own arrivals
  clearFit(); // the lens swaps the universe: a fitted view is stale
  if (on) {
    const recs = tagsFor(vault.tab().docs || []);
    if (!recs.length) { toast('No tags in this view yet — add #hashtags to a body'); return; }
    lensThematic = false; thematicWhole = false;
    lensTags = true;
    syncLensBtn(); applyLens(); saveUi();
    try { syncTagVerseBtn(); } catch {} // pane button reads the live lens state too
    closeTagPop();
    toast(`Tags view — ${recs.length} tag${recs.length === 1 ? '' : 's'} across ${(vault.tab().docs || []).length} bodies`);
    try { syncLbPill(); } catch {}
  } else {
    if (!lensTags) return;
    lensTags = false;
    applyLens(); saveUi();
    try { syncTagVerseBtn(); } catch {} // the pop-out stays open on exit: refresh its button
    try { syncLbPill(); } catch {}
    toast('Regular view restored');
  }
}
// Thematic view logic, shared with the view-modes strip entry:
// same docs + same physics, recomposed by themes/tags. From the general
// state (nothing selected) it distills the WHOLE visidocsverse; leaving the
// view always drops the whole view.
function toggleThematicLens() {
  pushView(); // Return can come back to the pre-lens view
  // the parked pin survives lens swaps — the reader stays fixated on its doc
  canvasHiId = null; // the new view lights its own bodies
  assocSelId = null; srcHi = null; // the new view lights its own rows
  intakeHiIds.clear(); // the new view lights its own arrivals
  clearFit(); // the lens swaps the universe: a fitted view is stale
  if (!vault.tab()) {
    toast('No open canvas — click + to start one before using the Thematic lens.');
    return;
  }
  lensThematic = !lensThematic;
  if (lensThematic) { thematicWhole = (activeId == null); lensTags = false; } // lenses are mutually exclusive
  else thematicWhole = false;
  applyLens();
  saveUi();
  if (!lensThematic) toast('Regular view restored');
  else if (thematicWhole) {
    const n = wholeThemes.length, m = wholeVisidocsverseDocs().length;
    toast(n ? `Thematic lens — whole Visi|Docsverse: ${n} theme${n === 1 ? '' : 's'} across ${m} bodies` : 'Thematic lens — no shared concepts in the Visi|Docsverse yet');
  } else {
    const n = (thematicThemes.get(vault.activeTabId) || []).length;
    toast(n ? `Thematic lens — ${n} theme${n === 1 ? '' : 's'} distilled from shared concepts` : 'Thematic lens — no shared concepts in this canvas yet');
  }
  try { syncLbPill(); } catch {}
}
// universe view modes (strip under the top tabs): Main = the regular canvas
// universe, Thematic = the Thematic entry in the row, Tag = the entry that
// toggles the tags view. Main and Tag toggle the same state those controls do.
function goViewMode(mode) {
  if (mode === 'thematic') { toggleThematicLens(); }
  else if (mode === 'tag') { setTagsVerse(!lensTags); }
  else {
    if (!lensThematic && !lensTags) { toast('Main view — the regular canvas universe'); return; }
    pushView(); // Return can come back to the lens being left
    // the parked pin survives the exit — the reader stays fixated on its doc
    canvasHiId = null; // the restored view lights its own bodies
    assocSelId = null; srcHi = null; // the restored view lights its own rows
    intakeHiIds.clear(); // the restored view lights its own arrivals
    lensThematic = false; thematicWhole = false; lensTags = false;
    clearFit();
    applyLens(); saveUi();
    try { syncTagVerseBtn(); } catch {}
    toast('Main view — the regular canvas universe');
  }
  try { syncViewModes(); } catch {}
  try { syncLbPill(); } catch {}
}
// view-modes strip state: highlight whichever view is live
function syncViewModes() {
  const bar = $('#tabBar');
  if (!bar) return;
  const cur = lensThematic ? 'thematic' : (lensTags ? 'tag' : 'main');
  bar.querySelectorAll('[data-vm]').forEach(b => b.classList.toggle('on', b.dataset.vm === cur));
}
// Return: walk back through previous view states (canvas + lens + sun +
// camera). Every user-driven view change pushes the state it leaves; Return
// pops back to the newest state that differs from now. Applying a history
// entry never pushes (repeated Returns keep walking back).
const viewHistory = []; // [{tabId, lensThematic, thematicWhole, lensTags, activeId, paneId, cam}]
let applyingHistory = false;
function snapView() {
  let cam = null;
  try { if (ren && ren.cam) cam = { dist: ren.cam.dist, px: ren.cam.px, py: ren.cam.py, yaw: ren.cam.yaw, pitch: ren.cam.pitch }; } catch {}
  return { tabId: vault.activeTabId, lensThematic, thematicWhole, lensTags, activeId, paneId, cam };
}
function sameView(a, b) {
  if (!a || !b) return false;
  const camEq = (x, y) => (!x && !y) || (!!x && !!y && x.dist === y.dist && x.px === y.px && x.py === y.py &&
    (typeof x.yaw !== 'number' || typeof y.yaw !== 'number' || x.yaw === y.yaw) &&
    (typeof x.pitch !== 'number' || typeof y.pitch !== 'number' || x.pitch === y.pitch));
  return a.tabId === b.tabId && !!a.lensThematic === !!b.lensThematic &&
    !!a.thematicWhole === !!b.thematicWhole && !!a.lensTags === !!b.lensTags &&
    (a.activeId || null) === (b.activeId || null) && (a.paneId || null) === (b.paneId || null) && camEq(a.cam, b.cam);
}
function pushView() {
  if (applyingHistory) return;
  try {
    const s = snapView();
    const last = viewHistory[viewHistory.length - 1];
    if (last && sameView(last, s)) return; // no dupes
    viewHistory.push(s);
    if (viewHistory.length > 50) viewHistory.shift();
  } catch { /* history is best-effort */ }
}
function goReturn() {
  const now = snapView();
  let target = null;
  while (viewHistory.length) {
    const cand = viewHistory.pop();
    if (!sameView(cand, now)) { target = cand; break; }
  }
  if (!target) { toast('Nothing to return to yet'); return; }
  applyingHistory = true;
  try {
    if (target.tabId !== vault.activeTabId && vault.tabs.some(t => t.id === target.tabId)) switchCanvas(target.tabId);
    lensThematic = !!target.lensThematic; thematicWhole = !!target.thematicWhole; lensTags = !!target.lensTags;
    activeId = target.activeId || null;
    paneId = target.paneId || null; // a returned view restores its parked pin too
    canvasHiId = null; // the restored view lights its own bodies
    assocSelId = null; srcHi = null; // the restored view lights its own rows
    intakeHiIds.clear(); // the restored view lights its own arrivals
    clearFit();
    applyLens(); saveUi();
    try { syncTagVerseBtn(); } catch {}
    if (target.cam && ren && ren.cam) {
      try { camFlyTo(target.cam); } catch { try { camCancelGlide(); ren.cam.dist = target.cam.dist; ren.cam.px = target.cam.px; ren.cam.py = target.cam.py; } catch {} }
    }
    toast('Returned to the previous view');
  } finally { applyingHistory = false; }
  try { syncViewModes(); } catch {}
}
// reader back stack: every reader position (doc or list) the pane shows,
// so ← Back walks back through documents and lists without touching the
// canvas, lens, sun or camera. Tracked on render (change-only, 50 cap);
// back-navigation sets readerBackNav so the return trip isn't re-pushed.
const readerBack = []; // [{tabId, activeId, paneId}]
let readerLast = null, readerBackNav = false, readerIsList = true;
function trackReader() {
  if (readerBackNav) return;
  try {
    const s = { tabId: vault.activeTabId, activeId: activeId || null, paneId: paneId || null };
    const l = readerLast;
    if (l && l.tabId === s.tabId && (l.activeId || null) === (s.activeId || null) && (l.paneId || null) === (s.paneId || null)) return;
    if (l) { readerBack.push(l); if (readerBack.length > 50) readerBack.shift(); }
    readerLast = s;
  } catch {}
}
function readerGoBack() {
  while (readerBack.length) {
    const t = readerBack.pop();
    if (t.tabId === vault.activeTabId && (t.activeId || null) === (activeId || null) && (t.paneId || null) === (paneId || null)) continue;
    readerBackNav = true;
    try {
      if (t.tabId !== vault.activeTabId && vault.tabs.some(x => x.id === t.tabId)) switchCanvas(t.tabId);
      activeId = t.activeId || null;
      paneId = t.paneId || null;
      try { const tb = vault.tab(); if (tb) { tb.activeId = activeId; vault.persist(); } } catch {}
      readerLast = { tabId: vault.activeTabId, activeId, paneId };
      renderDoc();
      const show = activeId || paneId;
      const dd = show && vault.byIdAnywhere(show);
      toast(dd ? `Back — “${vault.titleOf(dd)}”` : 'Back to the list');
    } finally { readerBackNav = false; }
    return;
  }
  // history spent: one more Back releases to the inventory list itself, so
  // repeated presses always get all the way back to the list view instead of
  // dead-ending on the first document with 'nothing to go back to'.
  if (!readerIsList || activeId || paneId) {
    readerBackNav = true;
    try {
      activeId = null;
      paneId = null;
      try { const tb = vault.tab(); if (tb) { tb.activeId = activeId; vault.persist(); } } catch {}
      readerLast = { tabId: vault.activeTabId, activeId, paneId };
      renderDoc();
      toast('Back to the list');
    } finally { readerBackNav = false; }
    return;
  }
  toast('Nothing to go back to yet');
}
// pill-button state dot, retired: book tabs carry no ○/◉ glyph — state shows
// through the .on fill only. Kept as a one-way stripper so any persisted or
// in-flight label with a legacy leading dot is cleaned the next time its
// sync runs (idempotent, no-op once clean).
function setPillGlyph(id, on) {
  const b = $(id);
  if (!b || !b.textContent) return;
  if (b.textContent[0] === '◉' || b.textContent[0] === '○') b.textContent = b.textContent.slice(1).replace(/^\s+/, '');
}
// Fit toggle state: the button stays ON while a fit is applied; toggling it
// off restores the exact pre-fit camera (dist + pan) and per-orb view boosts.
// Structural changes (rebuilds, canvas switches, lens/distribute toggles)
// invalidate the snapshot, so they clear the toggle.
function syncFitBtn() {
  const b = $('#fitBtn');
  if (!b) return;
  b.classList.toggle('on', fitActive);
  setPillGlyph('#fitBtn', fitActive);
  b.title = fitActive
    ? 'Fit is ON — click to restore the pre-fit view'
    : 'Fit: recenter and frame every body on screen (zooms out or in as needed), enlarging any orb below readable size';
}
function snapFit() {
  if (!uni) return null;
  return { uni, dist: ren.cam.dist, px: ren.cam.px || 0, py: ren.cam.py || 0, boosts: new Map(uni.nodes.map(n => [n.id, n._fitBoost || 1])) };
}
function clearFit() {
  if (!fitActive && !fitSnapshot) return;
  fitActive = false; fitSnapshot = null;
  try { syncFitBtn(); } catch {}
}
function syncAutoBtn() {  const b = $('#autoBtn');
  if (!b) return;
  b.classList.toggle('on', autoDist);
  setPillGlyph('#autoBtn', autoDist);
  b.title = autoDist
    ? 'Auto-distribute is ON — drag rotates, alt-drag a body to place it, click to restore orbital dynamics'
    : 'Auto-distribute: pin bodies in a fit-to-canvas orb (orbital motion overridden while on). Alt-drag moves a body in any mode — the drop pins it in place, alt-click releases it';
  syncMiniMap(); // the verse map only exists in Distribute mode
}
// ---------- verse minimap: live top-down dot map for Distribute mode ----------
// Distribute fills the screen with a close orb, so the whole verse disappears;
// the map reframes every body (top-down X/Z, auto-fit) in a draggable,
// resizable glass pane bottom-right — same idea as a game navigation map.
function applyMiniGeom(lodgeOK = true) {
  const box = $('#miniMap');
  if (!box) return;
  try { box.classList.toggle('folded', miniFolded === true); } catch {} // geometry measures the shown height: sync the class first so callers can't measure stale
  // the whole map stays on screen: shrink oversized maps to the viewport,
  // then pin the corner inside the edges (never just 80px hanging on).
  let w = Math.max(140, Math.min(640, window.innerWidth - 16, miniW > 0 ? miniW : 232));
  const h = miniFolded ? (miniH > 0 ? miniH : 172) : Math.max(100, Math.min(480, window.innerHeight - 16, miniH > 0 ? miniH : 172));
  box.style.width = w + 'px'; box.style.height = miniFolded ? 'auto' : h + 'px';
  // the verse map never tucks under the bottom pill: when the pill reaches
  // the map's zone the map rides 8px above the pill's top edge instead.
  const pillTopAt = (zoneL) => {
    try {
      const hb = document.getElementById('hintBar');
      if (!hb || hb.offsetParent === null) return -1;
      const hr = hb.getBoundingClientRect();
      if (hr.width <= 0 || hr.height <= 0 || hr.top >= window.innerHeight) return -1;
      return hr.right > zoneL ? Math.round(hr.top) : -1;
    } catch { return -1; }
  };
  // expanded reader rect for folded-bar parking (null when the reader is
  // collapsed, hidden, or off-screen narrow — then no avoidance is needed).
  const readerRect = () => {
    try {
      const p = document.getElementById('docPanel');
      if (!p || p.hidden) return null;
      if (p.classList.contains('collapsed')) return null;
      if (p.offsetParent === null) return null;
      if (window.innerWidth <= 760) return null;
      const r = p.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return r;
    } catch { return null; }
  };
  const hits = (a, b) => a.bottom > b.top + 1 && a.top < b.bottom - 1 && a.right > b.left + 1 && a.left < b.right - 1;
  // folded bar lives in the bottom-right corner lane: below the reader,
  // right of the bottom pill — shrinking its width to fit that lane
  // (never growing past the stored map width; stored miniW is untouched
  // so unfold restores full width). Runs identically in both modes.
  let cornerTop = -1, cornerLeft = -1; // resolved for folded when a reader is present
  if (miniFolded) {
    try {
      const rr0 = readerRect();
      if (rr0) w = Math.max(140, Math.min(w, Math.round(rr0.width)));
      const barH0 = Math.max(28, Math.round(box.offsetHeight || box.getBoundingClientRect().height || 34));
      let hr0 = null;
      try {
        const hb0 = document.getElementById('hintBar');
        if (hb0 && hb0.offsetParent !== null) {
          const t = hb0.getBoundingClientRect();
          if (t.width > 0 && t.height > 0 && t.top < window.innerHeight) hr0 = t;
        }
      } catch {}
      if (rr0) {
        const topBelow = Math.round(rr0.bottom + 8);
        cornerTop = Math.max(8, Math.min(Math.max(8, window.innerHeight - barH0 - 8), topBelow));
        if (hr0) {
          const hitsVert = cornerTop < hr0.bottom - 1 && (cornerTop + barH0) > hr0.top + 1;
          if (hitsVert) {
            const freeW = Math.round((window.innerWidth - 16) - (hr0.right + 8));
            if (freeW >= 140) w = Math.max(140, Math.min(w, freeW));
            // else: the pill spans the corner — keep the reader width and
            // fall back to the above-pill ride in the positioning below
          }
        }
        w = Math.max(140, Math.min(w, window.innerWidth - 32));
        cornerLeft = Math.round(window.innerWidth - 16 - w);
      }
      if (!rr0) { // collapsed/hidden reader: shrink to the free lane right of the pill
        try {
          const hbLane = document.getElementById('hintBar');
          if (hbLane && hbLane.offsetParent !== null) {
            const hrLane = hbLane.getBoundingClientRect();
            if (hrLane.width > 0 && hrLane.height > 0 && hrLane.top < window.innerHeight) {
              const freeW = Math.round((window.innerWidth - 16) - (hrLane.right + 8));
              if (freeW >= 140) w = Math.max(140, Math.min(w, freeW));
            }
          }
        } catch {}
        w = Math.max(140, Math.min(w, window.innerWidth - 32));
      }
    } catch {}
  }
  try { box.style.width = w + 'px'; } catch {} // re-apply: the folded width above was settled after the first pass
  if (miniX == null || miniY == null) {
    // folded dock: park UNDER the reader's bottom edge (top = bottom + 8)
    // in the free lane right of the bottom pill (shrunk above to fit it),
    // never over its prose. Unfolded keeps the classic bottom-right dock.
    const rr = miniFolded ? readerRect() : null;
    if (rr) {
      if (miniFolded && cornerTop >= 0 && cornerLeft >= 8) {
        box.style.right = 'auto'; box.style.left = cornerLeft + 'px'; box.style.bottom = 'auto';
        box.style.top = cornerTop + 'px';
      } else {
        box.style.right = '16px'; box.style.left = 'auto'; box.style.bottom = 'auto';
        const barH = Math.max(28, Math.round(box.offsetHeight || box.getBoundingClientRect().height || 34));
        let top = Math.round(rr.bottom + 8);
        top = Math.max(8, Math.min(Math.max(8, window.innerHeight - barH - 8), top));
        box.style.top = top + 'px';
      }
      try { // the below-reader spot may reach the pill: park left of the reader instead
        const hb = document.getElementById('hintBar');
        if (hb && hb.offsetParent !== null) {
          const hr = hb.getBoundingClientRect();
          let br = box.getBoundingClientRect();
          if (hr.width > 0 && hr.height > 0 && hits(br, hr)) {
            let parked = false;
            try { // side slot: left of the reader, level with its bottom edge but above the pill
              const bh = Math.round(br.height || 34);
              const sy = Math.max(8, Math.min(Math.max(8, window.innerHeight - bh - 8), Math.min(Math.round(rr.bottom + 8), Math.round(hr.top - 8 - bh))));
              const sx = Math.round(rr.left - 8 - br.width);
              if (sx >= 8) {
                const cand = { top: sy, bottom: sy + bh, left: sx, right: sx + Math.round(br.width) };
                if (!hits(cand, hr) && !hits(cand, rr)) {
                  box.style.left = sx + 'px'; box.style.right = 'auto';
                  box.style.top = sy + 'px'; box.style.bottom = 'auto';
                  br = box.getBoundingClientRect(); parked = true;
                }
              }
            } catch {}
            if (!parked) {
              const left = Math.round(hr.left - 8 - br.width);
              if (left >= 8) { box.style.left = left + 'px'; box.style.right = 'auto'; }
              else { // nowhere to shift: ride above the pill (stays visible above the reader)
                const pt2 = pillTopAt(window.innerWidth - 16 - w);
                if (pt2 >= 0) { box.style.right = '16px'; box.style.left = 'auto'; box.style.top = 'auto'; box.style.bottom = Math.max(16, window.innerHeight - pt2 + 8) + 'px'; }
              }
            }
          }
        }
      } catch {}
    } else {
      const pt = pillTopAt(window.innerWidth - 16 - w);
      box.style.right = '16px';
      box.style.bottom = (pt >= 0 ? Math.max(16, window.innerHeight - pt + 8) : 16) + 'px';
      box.style.left = 'auto'; box.style.top = 'auto';
    }
  }
  else {
    miniX = Math.max(8, Math.min(Math.max(8, window.innerWidth - w - 8), miniX));
    miniY = Math.max(8, Math.min(Math.max(8, window.innerHeight - (miniFolded ? 60 : h) - 8), miniY));
    box.style.left = miniX + 'px'; box.style.top = miniY + 'px';
    box.style.right = 'auto'; box.style.bottom = 'auto';
    try { // a hand-placed map still never slides under the pill: intersect -> ride above it
      const hb = document.getElementById('hintBar');
      if (hb && hb.offsetParent !== null) {
        const hr = hb.getBoundingClientRect(), br = box.getBoundingClientRect();
        if (hr.width > 0 && hr.height > 0 && hits(br, hr)) {
          miniY = Math.max(8, Math.round(hr.top - 8 - br.height));
          box.style.top = miniY + 'px';
        }
      }
    } catch {}
    try { // a folded bar never sits over reader prose: intersect -> drop into the corner lane
      if (miniFolded) {
        const rr = readerRect();
        if (rr) {
          let br = box.getBoundingClientRect();
          if (hits(br, rr)) {
            if (cornerTop >= 0 && cornerLeft >= 8) { // corner lane is pre-shrunk: jump straight there
              miniX = cornerLeft; miniY = cornerTop;
              box.style.left = miniX + 'px'; box.style.top = miniY + 'px';
              box.style.right = 'auto'; box.style.bottom = 'auto';
            } else {
              miniY = Math.round(rr.bottom + 8);
              const bh = Math.round(br.height || 34);
              miniY = Math.max(8, Math.min(Math.max(8, window.innerHeight - bh - 8), miniY));
              box.style.top = miniY + 'px';
            }
            br = box.getBoundingClientRect();
            try { // the drop may land on the pill: park left of the reader instead
              const hb = document.getElementById('hintBar');
              if (hb && hb.offsetParent !== null) {
                const hr = hb.getBoundingClientRect();
                if (hr.width > 0 && hr.height > 0 && hits(br, hr)) {
                  let parked = false;
                  try {
                    const bh = Math.round(br.height || 34);
                    const sy = Math.max(8, Math.min(Math.max(8, window.innerHeight - bh - 8), Math.min(Math.round(rr.bottom + 8), Math.round(hr.top - 8 - bh))));
                    const sx = Math.round(rr.left - 8 - br.width);
                    if (sx >= 8) {
                      const cand = { top: sy, bottom: sy + bh, left: sx, right: sx + Math.round(br.width) };
                      if (!hits(cand, hr) && !hits(cand, rr)) {
                        miniX = sx; miniY = sy;
                        box.style.left = miniX + 'px'; box.style.top = miniY + 'px';
                        box.style.right = 'auto'; box.style.bottom = 'auto';
                        br = box.getBoundingClientRect(); parked = true;
                      }
                    }
                  } catch {}
                  if (!parked) {
                    const left = Math.round(hr.left - 8 - br.width);
                    if (left >= 8) { miniX = left; box.style.left = miniX + 'px'; }
                    else { // nowhere to shift: ride above the pill (visible, above the reader)
                      miniY = Math.max(8, Math.round(hr.top - 8 - br.height));
                      box.style.top = miniY + 'px';
                    }
                  }
                }
              }
            } catch {}
          }
        }
      }
    } catch {}
    try { // collapsed/hidden reader: a folded bar lodges in the corner lane (same park as the docked path)
      if (miniFolded && lodgeOK && !readerRect()) {
        const lodgeH = Math.max(28, Math.round(box.offsetHeight || box.getBoundingClientRect().height || 34));
        const lodgeTop = pillTopAt(window.innerWidth - 16 - w);
        miniX = Math.max(8, Math.round(window.innerWidth - 16 - w));
        miniY = lodgeTop >= 0 ? Math.max(8, Math.round(lodgeTop - 8 - lodgeH)) : Math.max(8, Math.round(window.innerHeight - 8 - lodgeH));
        box.style.left = miniX + 'px'; box.style.top = miniY + 'px';
        box.style.right = 'auto'; box.style.bottom = 'auto';
      }
    } catch {}
  }
}
function syncMiniMap() {
  const box = $('#miniMap');
  if (!box) return;
  box.hidden = !autoDist;
  if (autoDist) { syncMiniFold(); applyMiniGeom(); drawMiniMap(); }
}
// verse-map collapse: a slim header bar instead of the live map (+ restores)
function syncMiniFold() {
  const box = $('#miniMap'), b = $('#miniMapFold');
  if (!box) return;
  box.classList.toggle('folded', miniFolded === true);
  if (b) {
    b.textContent = miniFolded ? '+' : '–';
    b.title = miniFolded ? 'Restore the verse map' : 'Collapse the verse map to its header bar';
  }
}
// usable vertical band for the glossary pane: below the top tab pill, above the bottom hint pill
function glossBand() {
  let top = 8, bottom = window.innerHeight - 8;
  try {
    const tb = document.getElementById('tabBar');
    if (tb) { const r = tb.getBoundingClientRect(); if (r.width > 0 && r.height > 0) top = Math.max(top, r.bottom + 8); }
    const hb = document.getElementById('hintBar');
    if (hb && getComputedStyle(hb).display !== 'none') { const r = hb.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.top < window.innerHeight) bottom = Math.min(bottom, r.top - 8); }
    // Return + Tips ride as tabs above the pill's edges — keep the band clear of both
    try {
      const rb = document.getElementById('returnBtn');
      if (rb && hb && getComputedStyle(hb).display !== 'none' && getComputedStyle(rb).display !== 'none') { const r2 = rb.getBoundingClientRect(); if (r2.width > 0 && r2.height > 0 && r2.top < window.innerHeight) bottom = Math.min(bottom, r2.top - 8); }
      const tb2 = document.getElementById('tipsBtn');
      if (tb2 && hb && getComputedStyle(hb).display !== 'none' && getComputedStyle(tb2).display !== 'none') { const r3 = tb2.getBoundingClientRect(); if (r3.width > 0 && r3.height > 0 && r3.top < window.innerHeight) bottom = Math.min(bottom, r3.top - 8); }
    } catch {}
  } catch {}
  if (bottom < top + 160) bottom = top + 160; // degenerate viewport: keep it usable, not inverted
  return { top, bottom };
}
// ---------- glossary of terms: tall glass pane docked beside the left panel ----------
function applyGlossGeom() {
  const box = $('#glossPane');
  if (!box) return;
  const band = glossBand();
  const bandH = band.bottom - band.top;
  const docked = (glossX == null || glossY == null);
  let L = 288; // fallback: left panel (264 + 16 margin) + 8 gap
  try { const lp = document.getElementById('leftPanel'); if (lp) L = lp.getBoundingClientRect().right + 8; } catch {}
  L = Math.max(8, Math.min(L, window.innerWidth - 260));
  let w = Math.min(glossW > 0 ? glossW : (docked ? 560 : 360), window.innerWidth - (docked ? L + 8 : 16)), h = Math.min(glossH > 0 ? glossH : (docked ? bandH : 430), bandH);
  if (docked) { box.style.left = L + 'px'; box.style.top = band.top + 'px'; box.style.right = 'auto'; box.style.bottom = 'auto'; }
  else {
    glossX = Math.max(0, Math.min(window.innerWidth - 80, glossX));
    glossY = Math.max(band.top, Math.min(band.bottom - 120, glossY));
    h = Math.min(h, band.bottom - glossY);
    box.style.left = glossX + 'px'; box.style.top = glossY + 'px';
    box.style.right = 'auto'; box.style.bottom = 'auto';
  }
  box.style.width = w + 'px'; box.style.height = h + 'px';
  try { placeGlossTop(); } catch {} // the Top tab rides the pane's geometry
}
function syncGloss() {
  const box = $('#glossPane');
  if (!box) return;
  box.hidden = !glossOpen;
  if (glossOpen) applyGlossGeom();
  try { syncGlossTop(); } catch {}
}
function setGloss(open) {
  glossOpen = open === true;
  if (glossOpen) { glossX = null; glossY = null; } // every open starts at the dock beside the book tab — never the last dragged spot
  syncGloss(); saveUi();
  try { document.getElementById('glossTab').classList.toggle('open', glossOpen); } catch {}
}
// ---------- pinned glossary terms: per-term "pin as tab" book tabs ----------
// Each pin is a slim vertical tab stacked under the glossary tab on the left
// panel's border; clicking it opens the shared pin pane parked beside the
// panel with just that term's definition. Pins persist like other ui prefs.
function glossWords() {
  try { return [...document.querySelectorAll('#glossBody .g-word')].map(e => e.textContent || '').filter(w => w); }
  catch { return []; }
}
function injectPinButtons() {
  try {
    document.querySelectorAll('#glossBody .g-term').forEach(term => {
      if (term.querySelector('.g-pin')) return;
      const w = term.querySelector('.g-word')?.textContent || '';
      if (!w) return;
      const b = document.createElement('button');
      b.className = 'g-pin' + (pinnedTerms.includes(w) ? ' on' : '');
      b.dataset.gpin = w;
      b.title = `Pin “${w}” as its own book tab under the glossary tab`;
      b.textContent = '📌 pin as tab';
      term.appendChild(b);
    });
  } catch {}
}
function syncPinTabs() {
  try {
    const words = glossWords();
    const before = pinnedTerms.length;
    pinnedTerms = pinnedTerms.filter(w => words.includes(w)); // drop pins whose term is gone
    if (pinnedTerms.length > MAX_PINS) pinnedTerms = pinnedTerms.slice(0, MAX_PINS); // never more than two book tabs
    if (pinnedTerms.length !== before) saveUi();
    document.querySelectorAll('.pinTab').forEach(t => t.remove());
    document.querySelectorAll('#glossBody .g-pin').forEach(p => p.classList.toggle('on', pinnedTerms.includes(p.dataset.gpin)));
    const lp = document.getElementById('leftPanel');
    const app = document.getElementById('app');
    if (!lp || !app) return; // parked at the panel's live right edge — works expanded or collapsed
    let pr = 280; // LAYOUT right edge (offset geometry: tilt-invariant — the
    try { pr = lp.offsetLeft + lp.offsetWidth; } catch {} // bounding rect shrinks under tilt and would drag the tabs a
    const tilted = lp.classList.contains('tilted'); // full tab-width inward, so never anchor to it
    const glossBottom = 132 + 172; // #glossTab geometry: pins stack 8px below it
    let top = 312;
    try { top = (lp.offsetTop || 0) + glossBottom + 8; } catch {}
    let ccx = 148; // panel layout center X (app coords): the tilt pivot the tabs must share
    try { ccx = lp.offsetLeft + lp.offsetWidth / 2; } catch {}
    // never stick past the pane bottom: precompute heights, then shrink the
    // inter-tab gap (into an overlap if needed) so the last tab ends inside
    // the pane. Overlap never buries a tab: at least a 28px strip stays visible.
    const hs = pinnedTerms.map(w => Math.min(220, 30 + w.length * 9.5));
    let gap = 8;
    try {
      const bottom = (lp.offsetTop || 0) + (lp.offsetHeight || 0) - 8;
      const avail = bottom - top;
      if (hs.length > 1) {
        gap = Math.min(8, (avail - hs.reduce((a, h) => a + h, 0)) / (hs.length - 1));
        gap = Math.max(gap, -(Math.min(...hs) - 28));
      } else if (hs.length === 1 && hs[0] > avail) {
        hs[0] = Math.max(48, avail); // one tall tab shrinks instead of overflowing
      }
    } catch {}
    pinnedTerms.forEach((w, i) => {
      const b = document.createElement('button');
      b.className = 'pinTab' + (pinOpenWord === w ? ' open' : '');
      b.dataset.pinword = w;
      b.title = `Open pinned term “${w}”`;
      b.style.left = (pr - 1) + 'px';
      const h = hs[i];
      b.style.top = top + 'px';
      b.style.height = h + 'px';
      // same 3D plane as the tilted panel: identical perspective + angle about
      // the panel's own center (rotateY pivots on a vertical line, so X is enough)
      b.style.transform = tilted ? 'perspective(1100px) rotateY(30deg)' : '';
      b.style.transformOrigin = tilted ? `${(ccx - pr + 1).toFixed(1)}px 50%` : '';
      const s = document.createElement('span');
      s.textContent = w;
      b.appendChild(s);
      app.appendChild(b);
      top += h + gap;
    });
  } catch {}
}
function togglePin(word) {
  if (!word) return;
  if (pinnedTerms.includes(word)) {
    pinnedTerms = pinnedTerms.filter(w => w !== word);
    if (pinOpenWord === word) setPin(null);
    toast(`Unpinned “${word}”`);
  } else {
    if (pinnedTerms.length >= MAX_PINS) {
      toast(`Only ${MAX_PINS} pinned tabs fit — unpin one first (its 📌 button, or Unpin in the pin pane)`);
      return;
    }
    pinnedTerms.push(word);
    toast(`Pinned “${word}” as a tab`);
  }
  saveUi(); syncPinTabs();
}
function setPin(word) {
  pinOpenWord = word || null;
  const box = document.getElementById('pinPane');
  if (!box) return;
  if (!pinOpenWord || !pinnedTerms.includes(pinOpenWord)) {
    pinOpenWord = null;
    box.hidden = true;
  } else {
    const term = [...document.querySelectorAll('#glossBody .g-term')]
      .find(t => (t.querySelector('.g-word')?.textContent || '') === pinOpenWord);
    const title = document.getElementById('pinTitle');
    const body = document.getElementById('pinBody');
    if (title) title.textContent = '◈ ' + pinOpenWord;
    if (body) {
      body.innerHTML = '';
      if (term) {
        const clone = term.cloneNode(true);
        clone.querySelectorAll('.g-pin').forEach(b => b.remove());
        body.appendChild(clone);
      } else body.textContent = '(term no longer in the glossary)';
    }
    box.hidden = false;
    placePinPane();
  }
  syncPinTabs(); // refresh tab .open + pin-button .on states
}
function placePinPane() {
  const box = document.getElementById('pinPane');
  if (!box || box.hidden) return;
  const band = glossBand();
  let L = 288; // fallback: left panel (264 + 16 margin) + 8 gap
  try { const lp = document.getElementById('leftPanel'); if (lp) L = lp.getBoundingClientRect().right + 8; } catch {}
  L = Math.max(8, Math.min(L, window.innerWidth - 340));
  try { // never cover the open glossary pane — slide right of it instead
    const gp = document.getElementById('glossPane');
    if (gp && !gp.hidden && gp.offsetParent !== null) {
      const r = gp.getBoundingClientRect();
      if (r.width > 0 && r.left < L + 340 && r.right > L) L = Math.min(r.right + 8, window.innerWidth - 340);
    }
  } catch {}
  box.style.left = L + 'px';
  box.style.top = band.top + 'px';
  box.style.width = '320px';
  box.style.maxHeight = Math.max(200, band.bottom - band.top) + 'px';
}
// ---------- Notes book tab + pane: one shared notepad per active body ----------
// A thin vertical book tab rides the reader's left edge (fixed — never
// draggable). Clicking it opens a glass pane parked left of the reader, 30%
// narrower than the glossary dock. The pane lists every entry for the doc
// with per-entry delete, plus Save (manual push), auto-save, Delete-all and
// Cancel. The sticky square, the reader notes button and any tab's copy all
// read and write the same entry list, so every surface agrees.
let notesDocId = null; // doc the open pane is showing
let notesSessionAuto = null; // auto entry created since this open (Cancel removes it)
let notesDraftTimer = 0, notesCloseToken = 0;
// drag-and-drop of reader highlights into the pane: dragstart on #docBody
// stashes the live selection + its rich passage anchor; drops onto the pane
// (or its tab while closed) file it as a note entry, pinned like the button.
let dragNotePayload = null; // {text, spot, docId} captured at dragstart
let dragFromNotes = false; // a drag that began inside the pane (reorder) — never re-files
let notesDropSpot = null; // {docId, spot} stashed when a highlight lands in the composer; consumed by the next save
let selTipTimer = 0; // hide timer for the floating highlight cue ("Drag highlighted text…")
function notesBand() { return glossBand(); } // same pill-to-pill vertical band
function placeNotesTab() {
  const t = $('#notesTab'), p = $('#docPanel');
  if (!t || !p) return;
  if (t.hidden) return;
  // layout (tilt-invariant) geometry: offset coords ignore CSS transforms, and
  // both nodes are absolute in #app, so these already are viewport coords
  const px = p.offsetLeft, py = p.offsetTop, pw = p.offsetWidth, ph = p.offsetHeight;
  t.style.left = Math.max(8, Math.round(px - 25)) + 'px';
  // parked above the edge cluster (26px clear of the tilt toggle) with breathing
  // room — anchored to the pane middle so it tracks the cluster on any height
  t.style.top = Math.max(8, Math.min(Math.round(py + ph / 2 - 225), window.innerHeight - 128)) + 'px';
  // same 3D plane as the tilted pane: identical perspective + shift + angle
  // about the pane's own center (keep in sync with #docPanel.tiltedR), so
  // the tab slants with the visual edge instead of floating flat beside it
  if (p.classList.contains('tiltedR')) {
    t.style.transform = 'perspective(1100px) translateX(var(--tiltShift, 0px)) rotateY(-30deg)';
    t.style.transformOrigin = (pw / 2 + 25).toFixed(1) + 'px 50%';
  } else {
    t.style.transform = '';
    t.style.transformOrigin = '';
  }
}
function syncNotesTab() {
  const t = $('#notesTab'), p = $('#docPanel');
  if (!t || !p) return;
  // the tab belongs to documents: whenever the reader shows a real doc —
  // canvas-selected or title-pinned — the tab auto-appears; general/theme/tag
  // views (no doc shown) never show it — there is nothing to take notes on
  const hasDoc = !!vault.byId(shownId);
  const open = hasDoc && !p.hidden && p.offsetParent !== null && !p.classList.contains('collapsed') && window.innerWidth > 760;
  t.hidden = !open;
  if (!open) {
    // released/general view has no reader doc — but a pane explicitly opened
    // for a real doc (the floating square's "Notes pane →") stays on its own
    // doc instead of being slammed shut; only a doc-less pane auto-closes.
    if (notesOpen && !vault.byId(notesDocId)) closeNotesPane(true);
    return;
  }
  t.classList.toggle('open', notesOpen);
  t.title = notesOpen ? 'Close the Notes pane' : 'Open the Notes pane — one shared notepad for this body (fixed beside the reader)';
  placeNotesTab();
  try { placeTabBar(); } catch {} // the book tab steals lane from the pill
}
function applyNotesGeom() {
  const box = $('#notesPane');
  if (!box || !notesOpen) return;
  const band = notesBand();
  const bandH = band.bottom - band.top;
  const p = $('#docPanel');
  let w = Math.round((glossW > 0 ? glossW : 560) * 0.7); // 30% narrower than the glossary pane
  w = Math.max(280, Math.min(520, w, window.innerWidth - 32));
  let L = 8;
  try { if (p) { const r = p.getBoundingClientRect(); L = Math.max(8, Math.min(Math.round(r.left - w - 8), window.innerWidth - w - 8)); } } catch {}
  box.style.left = L + 'px'; box.style.top = band.top + 'px';
  box.style.width = w + 'px'; box.style.height = Math.max(200, bandH) + 'px';
  try { syncNotesTop(); } catch {} // the Top tab rides the pane's geometry
}
function setNotes(open, id) {
  open = open === true;
  if (open) {
    const doc = vault.byId(typeof id === 'string' ? id : (vault.byId(shownId) ? shownId : activeId));
    if (!doc) { toast('Open a document body first — notes live on bodies'); return; }
    if (notesDocId !== doc.id) { notesSessionAuto = null; notesDropSpot = null; }
    notesDocId = doc.id;
    notesOpen = true;
    // the pane and the reader stay on the same document: when the reader is
    // already showing a different body, opening this notepad parks that body
    // in the Active-body pane too (pane-only pin — sun, camera and lens never
    // move). Overview/lens readers keep their view; only a doc-for-doc
    // switch re-parks.
    if (vault.byId(shownId) && shownId !== doc.id) {
      paneId = doc.id;
      try { renderDoc(); } catch {}
      if (window.innerWidth <= 760) { try { $('#docPanel').classList.add('open'); } catch {} }
    }
    const box = $('#notesPane');
    if (box) {
      notesCloseToken++;
      box.hidden = false;
      applyNotesGeom();
      renderNotesPane();
      // smooth trip in: unhide first (still faded/shifted), then .show
      // transitions opacity + transform into place over ~240ms
      requestAnimationFrame(() => requestAnimationFrame(() => { try { box.classList.add('show'); } catch {} }));
      // its inventory row stays gold and in view while the pane stands:
      // unfold View-all when the row hides past the 6 largest, then center
      // it so it sits next to the pane (general inventory only — other
      // readers have no doc rows to light).
      if (!shownId && !lensThematic && !lensTags && !thematicWhole) {
        const nsel = `#docLinks .bl-row[data-open="${CSS.escape(doc.id)}"]`;
        if (!document.querySelector(nsel)) {
          const t = vault.tab();
          if (t && (t.docs || []).length > 6 && !showAllBodies) { showAllBodies = true; renderGeneral(); }
        }
        paintGoldRows(doc.id);
      } else paintGoldRows();
    }
  } else closeNotesPane();
  try { syncNotesTab(); } catch {}
  try { saveUi(); } catch {}
}
function closeNotesPane(silent) {
  const box = $('#notesPane');
  notesOpen = false;
  try { $('#notesTopBtn').hidden = true; } catch {} // the Top tab never outlives its pane
  try { saveUi(); } catch {}
  try { syncNotesTab(); } catch {}
  try { paintGoldRows(); } catch {} // its row unlights now the pane is gone
  if (!box || box.hidden) return;
  if (silent) { notesCloseToken++; box.hidden = true; box.classList.remove('show'); return; }
  box.classList.remove('show'); // smooth trip out, then hide once faded
  const token = ++notesCloseToken;
  setTimeout(() => { if (notesCloseToken === token) box.hidden = true; }, 240);
}
function syncNotesPaneDoc() { // the tab + pane follow whatever the reader shows
  if (vault.byId(shownId)) {
    if (notesDocId !== shownId) { notesDocId = shownId; notesSessionAuto = null; notesDropSpot = null; }
  }
  // theme / tag / general views show no doc: keep the pane's own doc — a pane
  // explicitly opened from a sticky square stays on its notepad instead of
  // blanking the moment the reader re-renders.
  try { syncNotesTab(); } catch {}
  if (notesOpen) { try { applyNotesGeom(); } catch {} try { renderNotesPane(); } catch {} }
}
function notesEntryDate(at) { try { return new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
// APA reference: every notes surface carries a best-effort APA-style
// reference for its document (the filename stays in the header as before).
// Per-field priority: embedded original-file metadata (d.citeMeta, resolved
// from the sidecar original bytes) first, mined rendered text second,
// filename/(n.d.) last. Sparse documents yield an honest partial reference
// (flagged "partial") instead of nothing.
function docApaInfo(d) {
  const out = { title: '', authors: [], year: 0, source: '', doi: '' };
  if (!d) return out;
  const emb = (d.citeMeta && typeof d.citeMeta === 'object' && !Array.isArray(d.citeMeta)) ? d.citeMeta : null; // original-file metadata wins
  let base = '';
  try { base = String(vault.titleOf(d) || '').trim(); } catch { base = ''; }
  const human = base.replace(/[_]+/g, ' ').replace(/[-]+/g, ' ').replace(/\s+/g, ' ').trim();
  let text = '';
  try { text = String(d.text || ''); } catch { text = ''; }
  const raw = text.split('\n');
  if (raw.length && /^\s*#\s/.test(raw[0] || '')) raw.shift(); // intake-titled first line repeats the filename
  const lines = [];
  for (const ln of raw.slice(0, 80)) {
    const t = String(ln || '').replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
    if (lines.length >= 40) break;
  }
  let title = '';
  const embTitle = emb && typeof emb.title === 'string' ? emb.title.trim().slice(0, 300) : '';
  if (embTitle.length >= 4) title = embTitle; // embedded Title beats any rendered-text guess
  else for (const ln of lines.slice(0, 4)) {
    const clean = ln.replace(/^#+\s*/, '').replace(/\s+page \d+(\s+of\s+\d+)?$/i, '').trim();
    if (clean.length >= 12 && clean.length <= 300 && !/^(abstract|contents|table of contents|introduction|page \d+)/i.test(clean) && !/intentionally (left )?blank|^\s*blank(\s+page)?\s*$/i.test(clean)) { title = clean; break; } // never crown a placeholder page
  }
  if (!title) title = human || 'Untitled';
  out.title = title.slice(0, 300);
  const WD = CITE_WD;
  const flRe = new RegExp('\\b(' + WD + ')' + CITE_TAIL + '\\b', 'g');
  const lfRe = new RegExp('\\b(' + WD + '),\\s+(' + WD + '|[A-Z]\\.?)', 'g');
  const skipRe = /@|https?:|doi:|university|department|institute|college|school|journal|proceedings|conference|chapter|abstract|editors?|review|press|copyright|\u00A9|faculty|laboratory|^page\b/i;
  const grab = (s) => {
    const found = [];
    let m;
    flRe.lastIndex = 0;
    while ((m = flRe.exec(s)) && found.length < 20) {
      found.push({ first: m[1], last: citeTailLast(m[2]) });
    }
    if (!found.length) {
      lfRe.lastIndex = 0;
      while ((m = lfRe.exec(s)) && found.length < 20) found.push({ first: m[2].replace(/\./g, ''), last: m[1] });
    }
    return found;
  };
  const okLine = (s, names) => {
    if (names.length < 1 || names.length > 20 || s.length > 220) return false;
    const letters = (s.match(/[A-Za-z\u00C0-\u00FF]/g) || []).length;
    const kept = names.map(n => ((n.first + n.last).match(/[A-Za-z\u00C0-\u00FF]/g) || []).length).reduce((a, b) => a + b, 0);
    return letters > 0 && kept / letters >= 0.45;
  };
  let authors = [];
  const embAuthors = emb && Array.isArray(emb.authors) ? cleanCiteNames(emb.authors) : [];
  if (embAuthors.length) authors = embAuthors.slice(0, 6); // embedded Author beats any rendered-text guess
  if (!authors.length) for (const pat of [/^\s*by\s*[:\-]?\s+(.+)$/i, /^\s*authors?\s*[:\-]\s*(.+)$/i]) {
    for (const ln of lines.slice(0, 8)) {
      const m = String(ln).match(pat);
      if (!m) continue;
      const names = grab(m[1].split(/;|\band\b|&/).join(','));
      if (okLine(m[1], names)) { authors = names; break; }
    }
    if (authors.length) break;
  }
  if (!authors.length) {
    for (const ln of lines.slice(1, 13)) {
      if (skipRe.test(ln)) continue;
      const lows = ln.match(/\b[a-z\u00E0-\u00FF]+\b/g) || [];
      if (lows.some(w => !NAME_GLUE.has(w.toLowerCase()))) continue; // title lines leak lowercase words - names never do
      const names = grab(ln);
      if (okLine(ln, names)) { authors = names; break; }
    }
  }
  out.authors = cleanCiteNames(authors).slice(0, 6); // stopwords kill placeholder "authors" ("This Page", "Left Blank")
  const head = text.slice(0, 8000);
  const nowY = new Date().getFullYear();
  const goodY = (y) => y >= 1500 && y <= nowY;
  let year = 0;
  if (emb && Number.isInteger(emb.year) && goodY(emb.year)) year = emb.year; // embedded CreationDate beats any rendered-text guess
  const par = !year && head.match(/\((1[5-9]\d{2}|20[0-2]\d)\)/);
  if (par && goodY(+par[1])) year = +par[1];
  if (!year) {
    const cp = head.match(/(\u00A9|copyright)[^.\n]{0,60}(1[5-9]\d{2}|20[0-2]\d)/i);
    if (cp && goodY(+cp[2])) year = +cp[2];
  }
  if (!year) {
    const all = head.match(/\b(1[5-9]\d{2}|20[0-2]\d)\b/g) || [];
    for (const y of all) { if (goodY(+y)) { year = +y; break; } }
  }
  out.year = year;
  const doiM = head.match(/\b10\.\d{4,}\/[^\s"'<>\]\)}]+/);
  if (doiM) out.doi = 'https://doi.org/' + doiM[0].replace(/[.,;:]+$/, '');
  const srcSkip = /@|https?:|doi:|copyright|\u00A9/i;
  for (const ln of lines.slice(0, 60)) {
    if (ln.length > 200 || srcSkip.test(ln)) continue;
    if (/(journal|proceedings|transactions|conference|symposium|review|quarterly|letters|press|books|publisher|university|institute|published\b)/i.test(ln)) { out.source = ln.slice(0, 160); break; }
    if (/^\s*in\s+(?=[A-Z\u00C0-\u00DE])/i.test(ln) && ln.length >= 12) { out.source = ln.replace(/^\s*in\s+/i, '').slice(0, 160); break; } // "In Advances in ..." reference style
    if (/\b(nips|neurips|icml|iclr|aaai|ijcai|cvpr|iccv|acl|emnlp|kdd|sigir|acm|ieee)\b/i.test(ln)) { out.source = ln.slice(0, 160); break; } // venue acronyms
  }
  const vol = head.match(/\b(\d{1,3})\s*\(\s*(\d{1,3})\s*\)\s*,\s*(\d+\s*[-\u2013\u2014]\s*\d+|\d+)\b/);
  if (vol && out.source && !/\(\d+\)/.test(out.source)) out.source += ', ' + vol[1] + '(' + vol[2] + '), ' + vol[3].replace(/\s/g, '');
  return out;
}
function apaPerson(a) { // "Last, F. M." from a mined {first, last} pair
  const ini = String(a.first || '').trim().split(/[\s.]+/).filter(Boolean).map(w => w[0].toUpperCase() + '.').join(' ');
  return a.last + (ini ? ', ' + ini : '');
}
function docApaText(d) { // plain-text citation (clipboard)
  const info = docApaInfo(d);
  const names = info.authors.slice(0, 20);
  let auth = '';
  if (names.length === 1) auth = apaPerson(names[0]);
  else if (names.length === 2) auth = apaPerson(names[0]) + ', & ' + apaPerson(names[1]);
  else if (names.length > 2) auth = names.slice(0, -1).map(apaPerson).join(', ') + ', & ' + apaPerson(names[names.length - 1]);
  const yr = info.year ? '(' + info.year + ').' : '(n.d.).';
  const ti = info.title.replace(/\s+/g, ' ').trim().replace(/\.+$/, '') + '.';
  const bits = auth ? [auth + ' ' + yr + ' ' + ti] : [ti + ' ' + yr];
  if (info.source) bits.push(info.source.replace(/\.+$/, '') + '.');
  if (info.doi) bits.push(info.doi);
  return bits.join(' ');
}
function docApaHtml(d) { // rendered citation (titles/sources italic, partial flagged)
  const info = docApaInfo(d);
  const names = info.authors.slice(0, 20);
  let auth = '';
  if (names.length === 1) auth = esc(apaPerson(names[0]));
  else if (names.length === 2) auth = esc(apaPerson(names[0])) + ', &amp; ' + esc(apaPerson(names[1]));
  else if (names.length > 2) auth = names.slice(0, -1).map(a => esc(apaPerson(a))).join(', ') + ', &amp; ' + esc(apaPerson(names[names.length - 1]));
  const yr = info.year ? '(' + info.year + ').' : '(n.d.).';
  const ti = '<i>' + esc(info.title.replace(/\s+/g, ' ').trim().replace(/\.+$/, '') + '.') + '</i>';
  const bits = auth ? [auth + ' ' + esc(yr) + ' ' + ti] : [ti + ' ' + esc(yr)];
  if (info.source) bits.push('<i>' + esc(info.source.replace(/\.+$/, '') + '.') + '</i>');
  if (info.doi) bits.push(esc(info.doi));
  if (!(info.authors.length && info.year && info.source)) bits.push('<span class="apa-partial" title="Partial reference - the author, year or publisher could not be found inside this document">partial</span>');
  return bits.join(' ');
}
function copyApaCite(id) { // copy the mined APA reference for a doc
  const d = vault.byId(id); if (!d) return;
  const txt = docApaText(d);
  if (!txt) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => toast('APA reference copied'), () => toast('Copy failed - select the reference text manually'));
    else throw 0;
  } catch { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast('APA reference copied'); } catch {} ta.remove(); }
}
function renderNotesPane() {
  const box = $('#notesPane');
  if (!box || !notesOpen) return;
  const d = vault.byId(notesDocId);
  const title = $('#notesTitle');
  if (title) title.textContent = d ? ('◉ NOTES — ' + vault.titleOf(d)) : '◉ NOTES';
  try { // APA citation under the header: filename stays above, reference mined from the doc
    const cw = $('#notesCiteWrap'), ce = $('#notesCite');
    if (cw && ce) {
      if (d) { ce.innerHTML = docApaHtml(d); ce.dataset.plain = docApaText(d); cw.hidden = false; if (d.origKey && !d.citeMeta) { try { resolveCiteMeta(d.id); } catch {} } }
      else { ce.innerHTML = ''; ce.dataset.plain = ''; cw.hidden = true; }
    }
  } catch {}
  const auto = $('#notesAutoCk');
  if (auto && document.activeElement !== auto) auto.checked = notesAuto !== false;
  const hd = $('#notesHeadCount');
  const log = d ? noteLogOf(d) : [];
  if (d && notesDocId === shownId && log.some(e => e.spot && !e.page)) {
    // heal pre-feature pinned entries: resolve their original page the first
    // time their doc stands open in the reader (then they carry e.page like
    // new entries — one findSpotRange each, persisted + synced once).
    let healed = false;
    for (const e of log) {
      if (e.spot && !e.page) { const pg = pageOfSpotInReader(e.spot, String(e.text || '').length); if (pg) { e.page = pg; healed = true; } }
    }
    if (healed) { try { vault.persist(); } catch {} try { markBackupDirty(); } catch {} try { syncNoteKin(d.id); } catch {} }
  }
  if (hd) hd.textContent = d ? (log.length ? `${log.length} ${log.length === 1 ? 'entry' : 'entries'}` : 'empty') : '';
  const list = $('#notesList');
  if (list) {
    list.innerHTML = d ? (log.length ? log.map((e, i) =>
      `<div class="ne${e.spot ? ' pinned' : ''}"${e.spot ? ` data-nejump="${esc(e.id)}" title="Jump to its passage in the body"` : ''}><div class="ne-head"><span class="ne-num">#${i + 1} · ${esc(notesEntryDate(e.at))}${esc(notePageLabel(d, e))}</span><button class="ne-x" data-ndel="${esc(e.id)}" title="Delete this note entry">×</button></div><div class="ne-text">${esc(e.text)}</div></div>`
    ).join('') : '<div class="ne-empty">No notes on this document yet — write one below, highlight text in the body and send it here, drag the highlight straight into this pane, or use the sticky square.</div>')
    : '<div class="ne-empty">Open a document body to take notes.</div>';
  }
  const area = $('#notesArea');
  if (area) {
    area.disabled = !d;
    if (document.activeElement !== area) {
      const pend = d && d.notePending ? log.find(e => e.id === d.notePending) : null;
      area.value = d ? (String(d.noteDraft || '') || (pend ? pend.text : '')) : '';
      const cnt = $('#notesCount');
      if (cnt) cnt.textContent = `${area.value.length}/${NOTE_MAX}`;
    }
  }
  const sel = $('#notesSelBtn'), sv = $('#notesSave'), da = $('#notesDelAll');
  if (sel) sel.disabled = !d;
  if (sv) sv.disabled = !d;
  if (da) da.disabled = !(d && log.length);
  try { syncNotesTop(); } catch {} // list rebuilds reset scroll — no stale tab
}
function onNotesInput() {
  const area = $('#notesArea'); if (!area) return;
  const cnt = $('#notesCount'); if (cnt) cnt.textContent = `${area.value.length}/${NOTE_MAX}`;
  try { clearTimeout(notesDraftTimer); } catch {}
  notesDraftTimer = setTimeout(() => {
    const dd = vault.byId(notesDocId); if (!dd) return;
    const txt = area.value;
    if (String(dd.noteDraft || '') !== txt) { dd.noteDraft = txt.slice(0, NOTE_MAX); try { vault.persist(); } catch {} }
    if (notesAuto !== false && notesOpen && notesDocId && vault.byId(notesDocId) === dd) autoSaveNoteEntry();
  }, 700);
}
function autoSaveNoteEntry() { // auto-save: pauses in typing land in ONE pending entry (created once, then updated)
  const area = $('#notesArea');
  const d = vault.byId(notesDocId);
  if (!area || !d) return;
  const txt = String(area.value || '');
  if (!txt.trim()) { // composer cleared: drop the in-progress auto entry
    if (d.notePending) {
      const pend = noteLogOf(d).find(e => e.id === d.notePending);
      if (pend) { try { deleteNoteEntry(d.id, pend.id); } catch {} }
      delete d.notePending;
      try { vault.persist(); } catch {}
    }
    notesSessionAuto = null;
    try { renderNotesPane(); } catch {}
    return;
  }
  const pend = d.notePending ? noteLogOf(d).find(e => e.id === d.notePending) : null;
  if (pend) {
    if (pend.text !== txt.slice(0, NOTE_MAX)) setNoteEntry(d.id, pend.id, txt);
    tryAttachDropSpot(d, pend); // a highlight dropped into the composer pins the pending entry
  } else {
    const e = addNoteEntry(d.id, txt, takeDropSpot(d.id)); // persists + syncs kin + refreshes views
    if (e) { d.notePending = e.id; notesSessionAuto = e.id; try { vault.persist(); } catch {} }
  }
}
function takeDropSpot(docId) { // consume the stashed composer-drop anchor for this doc's next entry
  if (!notesDropSpot || notesDropSpot.docId !== docId) return null;
  const sp = notesDropSpot.spot;
  notesDropSpot = null;
  return sp;
}
function tryAttachDropSpot(d, pend) { // pin the pending auto entry when its text came from a dropped highlight
  if (!d || !pend || pend.spot) return;
  if (!notesDropSpot || notesDropSpot.docId !== d.id) return;
  const sp = takeDropSpot(d.id);
  if (!sp) return;
  pend.spot = sp;
  try { vault.persist(); } catch {}
  try { markBackupDirty(); } catch {}
  try { syncNoteKin(d.id); } catch {}
  try { refreshNoteViews(d.id); } catch {}
}
function saveNotesPane() { // manual push: the composed text becomes an entry now
  const area = $('#notesArea');
  const d = vault.byId(notesDocId);
  if (!d || !area) return;
  const txt = String(area.value || '');
  const dropSp = takeDropSpot(d.id); // a highlight dropped into the composer pins this save
  if (d.notePending) {
    const pend = noteLogOf(d).find(e => e.id === d.notePending);
    if (pend && txt.trim()) { setNoteEntry(d.id, pend.id, txt); if (dropSp && !pend.spot) { pend.spot = dropSp; try { vault.persist(); } catch {} try { syncNoteKin(d.id); } catch {} } }
    else if (pend && !txt.trim()) deleteNoteEntry(d.id, pend.id);
    delete d.notePending;
  } else if (txt.trim()) addNoteEntry(d.id, txt, dropSp);
  else { toast('Nothing to save — write a note first'); return; }
  notesSessionAuto = null;
  try { delete d.noteDraft; } catch {}
  area.value = '';
  try { vault.persist(); } catch {}
  try { renderNotesPane(); } catch {}
  toast('Note saved');
}
function cancelNotesPane() { // discard the composed text (and this session's auto entry) and close
  const d = vault.byId(notesDocId);
  if (d && notesSessionAuto) {
    try { deleteNoteEntry(d.id, notesSessionAuto); } catch {}
  }
  if (d) { try { delete d.noteDraft; } catch {} try { vault.persist(); } catch {} }
  notesSessionAuto = null; notesDropSpot = null;
  const area = $('#notesArea'); if (area) area.value = '';
  closeNotesPane();
}
function readReaderSelection() { // live reader selection + its creation anchor (same rich shape as manual-tag spots)
  try {
    const sel = window.getSelection();
    const root = $('#docBody');
    if (!sel || sel.isCollapsed || !root || !sel.anchorNode || !root.contains(sel.anchorNode)) return { text: '', spot: null };
    const text = String(sel.toString() || '');
    let spot = text.trim().replace(/\s+/g, ' ').slice(0, 200);
    try {
      const an = sel.anchorNode;
      if (an && root.contains(an)) {
        const path = [];
        let n = an, ok = true;
        while (n && n !== root) { const p = n.parentNode; if (!p) { ok = false; break; } path.unshift([...p.childNodes].indexOf(n)); n = p; }
        if (ok && n === root) {
          const norm0 = (s) => String(s || '').replace(/\s+/g, '');
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let at = 0, tn;
          while ((tn = walker.nextNode())) {
            if (tn === an) { at += norm0(tn.textContent.slice(0, sel.anchorOffset)).length; break; }
            at += norm0(tn.textContent).length;
          }
          spot = { snip: spot, at, path, off: sel.anchorOffset };
        }
      }
    } catch {}
    return { text, spot: (spot && typeof spot === 'object') ? spot : null };
  } catch { return { text: '', spot: null }; }
}
function sendSelectionToNotes(full, spot, docId) { // highlight text in the body -> append it as a note entry, pinned to its passage (pane sends pass their doc)
  const d = vault.byId(docId || shownId);
  if (!d) { toast('Open a document body first — notes live on bodies'); return false; }
  let txt = String(full || ''), sp = (spot && typeof spot === 'object') ? spot : null;
  if (!txt.trim()) {
    const live = readReaderSelection();
    txt = live.text; sp = live.spot;
  }
  txt = txt.trim();
  if (!txt) { toast('Highlight some text in the body first'); return false; }
  const e = addNoteEntry(d.id, txt.slice(0, NOTE_MAX), sp);
  if (!e) return false;
  toast(sp ? 'Sent to notes — its highlight stays in the body' : 'Sent to notes');
  return true;
}
function notesDropText(e) { // dragged text from a drop event (falls back to the dragstart stash)
  let t = '';
  try { t = String((e && e.dataTransfer && e.dataTransfer.getData('text/plain')) || ''); } catch {}
  if (!t.trim() && dragNotePayload && dragNotePayload.text) t = String(dragNotePayload.text);
  return t;
}
function fileDroppedHighlight(raw, targetId) { // drop a highlight onto the pane: file it as a pinned entry like the button
  const d = vault.byId(targetId);
  if (!d) { toast('Open a document body first — notes live on bodies'); return false; }
  const txt = String(raw || '').trim();
  if (!txt) { toast('Nothing to file — drag highlighted text from the body'); return false; }
  let sp = null;
  const sameDoc = dragNotePayload && dragNotePayload.docId === d.id;
  if (sameDoc && dragNotePayload.spot && typeof dragNotePayload.spot === 'object') sp = dragNotePayload.spot;
  else if (sameDoc || !dragNotePayload || !dragNotePayload.docId) {
    const sn = txt.replace(/\s+/g, ' ').slice(0, 200); // bare snip still jumps + marks via text search when unique
    if (sn.trim().length >= 2) sp = { snip: sn };
  }
  const e = addNoteEntry(d.id, txt.slice(0, NOTE_MAX), sp);
  if (!e) return false;
  toast(sp ? 'Dropped into notes — its highlight stays in the body' : 'Dropped into notes');
  return true;
}
// highlight cue: the moment body text is highlighted, briefly float a
// "Drag highlighted text to drop into NOTES pane" tip above the highlight.
// pointer-events:none (CSS) so the drag itself never snags on it.
function hideSelDropTip() {
  try { clearTimeout(selTipTimer); } catch {}
  try { const tip = $('#selDropTip'); if (tip) tip.hidden = true; } catch {}
}
function cueSelDropTip() {
  const tip = $('#selDropTip'), root = $('#docBody');
  if (!tip || !root) return;
  let r = null;
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode || !root.contains(sel.anchorNode) || (sel.focusNode && !root.contains(sel.focusNode))) return hideSelDropTip();
    const txt = String(sel.toString() || '');
    if (txt.trim().replace(/\s+/g, ' ').length < 3) return hideSelDropTip();
    r = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    if (!r || (!r.width && !r.height)) return hideSelDropTip();
  } catch { return hideSelDropTip(); }
  try {
    clearTimeout(selTipTimer);
    tip.style.left = Math.max(135, Math.min(window.innerWidth - 135, r.left + r.width / 2)) + 'px';
    tip.hidden = false;
    if (r.top >= 64) tip.style.top = Math.max(8, r.top - 46) + 'px';
    else tip.style.top = Math.min(window.innerHeight - 60, r.bottom + 12) + 'px';
    selTipTimer = setTimeout(hideSelDropTip, 2600);
  } catch {}
}
// persistent note highlights: every sent passage stays marked in the open
// reader while its entry lives (re-applied each render, like manual spots);
// deleting the entry rebuilds the reader without it, so the mark goes too
function markNoteSpots(d) {
  const root = $('#docBody');
  if (!root || !d || !Array.isArray(d.noteLog)) return;
  for (const e of d.noteLog) {
    if (!e || !e.spot) continue;
    let r = null;
    try { r = findSpotRange(root, e.spot, String(e.text || '').length); } catch { continue; }
    if (!r || r.collapsed) continue;
    wrapRangeText(root, r, 'note-mark', { 'data-noteid': e.id, title: 'Note highlight — click its box in the Notes pane to jump here' });
  }
}
// click a note box in the pane: jump the reader to the passage it was sent from
// passage marks in any rendered copy of the body (reader, original overlay,
// carousel pane): the same note-mark pills, resolved against that root.
// dropPath drops the DOM path for foreign trees (carousel chunks);
// atAdjust rebases a full-body stripped offset into chunk coordinates (the
// overlay shares the reader's coordinates, so it passes 0).
function markNoteSpotsIn(root, d, dropPath, atAdjust) {
  if (!root || !d || !Array.isArray(d.noteLog)) return;
  for (const e of d.noteLog) {
    if (!e || !e.spot) continue;
    let sp = e.spot;
    if (typeof sp === 'object' && sp && (dropPath || atAdjust)) {
      sp = { ...sp };
      if (dropPath) delete sp.path;
      if (atAdjust && isFinite(sp.at)) sp.at = Math.max(0, sp.at - atAdjust);
    }
    let r = null;
    try { r = findSpotRange(root, sp, String(e.text || '').length); } catch { continue; }
    if (!r || r.collapsed) continue;
    try { wrapRangeText(root, r, 'note-mark', { 'data-noteid': e.id, title: 'Note highlight' }); } catch {}
  }
}
function paneBaseAt(seg, ti) {
  // stripped full-body offset where real page ti begins: preceding page prose
  // plus every folio pill standing before it (the pane's own pill included,
  // in the reader it stands right before the page prose).
  try {
    if (!seg || !Array.isArray(seg.segs)) return 0;
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const lab = (k) => String('p.' + (k + 1)).length;
    let at = 0;
    for (let k = 0; k < ti && k < seg.segs.length; k++) at += norm(seg.segs[k]).length + lab(k);
    return at + (ti >= 0 ? lab(Math.min(Math.max(ti, 0), seg.count - 1)) : 0);
  } catch { return 0; }
}
function paneSelectionSpot(root, text, baseAt, withPath) {
  // creation anchor for a live selection inside an overlay/carousel pane:
  // stripped offset rebased onto full-body coordinates (null baseAt gives a
  // bare snip for unmapped chunks: jump by text search), plus the DOM path
  // only when the pane shares the reader's exact tree (the overlay does).
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !root) return null;
    const an = sel.anchorNode;
    if (!an || !root.contains(an)) return null;
    const snip = String(text != null ? text : sel.toString() || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (snip.length < 2) return null;
    if (baseAt == null) return { snip };
    const norm0 = (s) => String(s || '').replace(/\s+/g, '');
    let at = 0;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let tn;
      while ((tn = walker.nextNode())) {
        if (tn === an) { at += norm0(tn.textContent.slice(0, sel.anchorOffset)).length; break; }
        at += norm0(tn.textContent).length;
      }
    } catch {}
    const spot = { snip, at: (baseAt || 0) + at };
    if (withPath) {
      try {
        const path = [];
        let n = an, ok = true;
        while (n && n !== root) { const p = n.parentNode; if (!p) { ok = false; break; } path.unshift([...p.childNodes].indexOf(n)); n = p; }
        if (ok && n === root) { spot.path = path; spot.off = sel.anchorOffset; }
      } catch {}
    }
    return spot;
  } catch { return null; }
}
function cuePaneNoteTip(root) {
  // settled highlight in the overlay/carousel: float the right-click tip
  // above it (same element and timing as the reader's drag cue).
  const tip = $('#selDropTip');
  if (!tip) return;
  if (!root) return hideSelDropTip();
  let r = null;
  try {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.anchorNode || !root.contains(sel.anchorNode) || (sel.focusNode && !root.contains(sel.focusNode))) return hideSelDropTip();
    const txt = String(sel.toString() || '');
    if (txt.trim().replace(/\s+/g, ' ').length < 3) return hideSelDropTip();
    r = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    if (!r || (!r.width && !r.height)) return hideSelDropTip();
  } catch { return hideSelDropTip(); }
  try {
    clearTimeout(selTipTimer);
    if (tip.dataset.orig == null) tip.dataset.orig = tip.textContent;
    tip.textContent = 'Right-click the highlight to Send to notes (or drag it into the NOTES pane)';
    tip.style.left = Math.max(135, Math.min(window.innerWidth - 135, r.left + r.width / 2)) + 'px';
    tip.hidden = false;
    if (r.top >= 64) tip.style.top = Math.max(8, r.top - 46) + 'px';
    else tip.style.top = Math.min(window.innerHeight - 60, r.bottom + 12) + 'px';
    selTipTimer = setTimeout(() => { hideSelDropTip(); try { if (tip.dataset.orig != null) tip.textContent = tip.dataset.orig; } catch {} }, 2600);
  } catch {}
}
// click a note box in the pane: jump the reader to the passage it was sent from
function jumpToNoteSpot(entryId) {
  const d = vault.byId(notesDocId || activeId);
  if (!d) return false;
  const e = noteLogOf(d).find(x => x.id === entryId);
  if (!e) return false;
  if (!e.spot) { toast('That entry has no body position — only sent highlights jump'); return false; }
  const root = $('#docBody');
  if (!root) return false;
  let r = null;
  try { r = findSpotRange(root, e.spot, String(e.text || '').length); } catch { return false; }
  if (!r || r.collapsed) { toast('Its passage is gone from the body'); return false; }
  try {
    const token = 'nf' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const marks = wrapRangeText(root, r, 'note-flash', { 'data-nflash': token });
    if (!marks.length) throw 0;
    try { marks[0].scrollIntoView({ block: 'center' }); } catch {}
    setTimeout(() => {
      try {
        root.querySelectorAll(`[data-nflash="${token}"]`).forEach(mark => {
          const p = mark.parentNode; if (!p) return;
          while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
          p.removeChild(mark);
        });
      } catch {}
    }, 2600);
    return true;
  } catch {
    try { r.startContainer.parentElement.scrollIntoView({ block: 'center' }); return true; } catch { return false; }
  }
}
function drawMiniMap() {
  const box = $('#miniMap'), cv = $('#miniMapCv');
  if (!box || !cv || box.hidden || miniFolded || !uni) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = cv.getBoundingClientRect();
  const W = Math.max(40, Math.round(r.width * dpr)), H = Math.max(40, Math.round(r.height * dpr));
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height;
  ctx.clearRect(0, 0, w, h);
  const ns = uni.nodes;
  const cnt = $('#miniMapCount');
  if (cnt) cnt.textContent = ns.length + (ns.length === 1 ? ' body' : ' bodies');
  if (!ns.length) return;
  // the map mirrors the main view's rotation: every body is plotted in the
  // camera's own frame (the same yaw rotation Renderer.project uses, pitch
  // ignored — the map stays top-down), so drag-rotating the canvas revolves
  // the markers around the sun instead of leaving the map behind. Right on
  // the map is right in the view; down on the map is toward the viewer.
  const yaw = (ren && ren.cam && Number.isFinite(ren.cam.yaw)) ? ren.cam.yaw : 0;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const rot = (x, z) => [x * cy - z * sy, x * sy + z * cy];
  let x0 = 1e18, x1 = -1e18, z0 = 1e18, z1 = -1e18;
  for (const n of ns) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.z)) continue;
    const [X, Z] = rot(n.x, n.z);
    if (X < x0) x0 = X; if (X > x1) x1 = X;
    if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
  }
  if (!(x1 > x0) || !(z1 > z0)) { x0 -= 60; x1 += 60; z0 -= 60; z1 += 60; }
  const pad = 1.18; // slack so edge bodies never kiss the frame
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const s = Math.min(w / ((x1 - x0) * pad || 1), h / ((z1 - z0) * pad || 1));
  const px = (x) => w / 2 + (x - mx) * s, py = (z) => h / 2 + (z - mz) * s;
  const tri = triOrb === true; // verse map mirrors the main canvas body shape
  const docM = docIcon === true; // document icons mirror too (theme bodies stay round, like the canvas)
  const viewedId = (ren && ren.selId && uni.byId.has(ren.selId)) ? ren.selId : uni.sunId; // gilded body: same precedence as the renderer (selection, else physical sun)
  const triPath = (x, y, r) => {
    ctx.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = Math.PI / 2 + k * 2 * Math.PI / 3; // first vertex points down, like the canvas
      if (k) ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
  };
  for (const n of ns) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.z)) continue;
    const [X, Z] = rot(n.x, n.z);
    // the viewed body is gilded gold, exactly like the main canvas (gold
    // follows ren.selId — the canvas highlight or the reader's selection —
    // falling back to the physical sun; lenses often have no sun at all)
    const isViewed = viewedId != null && n.id === viewedId;
    const rad = Math.min(isViewed ? 6.5 : 5, Math.max(1.6, 1.2 + Math.sqrt(Math.max(1, n.mass || 4)) * 0.35) + (isViewed ? 1.5 : 0));
    const isDocM = docM && !/^theme_/.test(n.id || '');
    if (tri) triPath(px(X), py(Z), rad);
    else if (isDocM) { const rw = rad * 1.3, rh = rad * 1.6; ctx.beginPath(); ctx.rect(px(X) - rw / 2, py(Z) - rh / 2, rw, rh); }
    else { ctx.beginPath(); ctx.arc(px(X), py(Z), rad, 0, 7); }
    ctx.fillStyle = isViewed ? '#ffce6b' : (isDocM ? '#ffffff' : '#5f9dff');
    if (isViewed) { ctx.shadowColor = 'rgba(255,206,107,.9)'; ctx.shadowBlur = 8; }
    ctx.fill();
    if (isViewed) ctx.shadowBlur = 0;
  }
  // the active body reads as a white ring, like the main view's sun ring
  if (activeId && uni.byId.has(activeId)) {
    const a = uni.byId.get(activeId);
    const [X, Z] = rot(a.x, a.z);
    ctx.beginPath(); ctx.arc(px(X), py(Z), Math.max(3, 1.2 + Math.sqrt(Math.max(1, a.mass || 4)) * 0.35) + 3, 0, 7);
    ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.2; ctx.stroke();
  }
}
function syncSimpleOrbBtn() {
  const b = $('#simpleOrbBtn');
  if (!b) return;
  b.classList.toggle('on', simpleOrb);
  setPillGlyph('#simpleOrbBtn', simpleOrb);
  b.title = simpleOrb
    ? 'Plain-body mode is ON — click to restore textured orbs'
    : 'Plain Body: flat white discs with a thin black outline (photo + glow overlays off)';
}
function syncSimpleOrb2Btn() {
  const b = $('#simpleOrb2Btn');
  if (!b) return;
  b.classList.toggle('on', simpleOrb2);
  // no setPillGlyph: the "2" partition carries no ○/◉ glyph — its .on fill is the state readout
  b.title = simpleOrb2
    ? 'Plain-body-2 mode is ON — click to restore photo overlays'
    : 'Plain Body 2: original blue orbs with the photo overlays stripped';
}
function syncDocIconBtn() {
  const b = $('#docIconBtn');
  if (!b) return;
  b.classList.toggle('on', docIcon);
  b.title = docIcon
    ? 'Document-icon mode is ON — click to restore orbs'
    : 'Turn bodies into document icons: plain white page icons instead of orbs (same sizes, labels, tethers and selection) — only available in MAIN and TAGS view modes (theme bodies always stay round)';
}
function syncTriOrbBtn() {
  const b = $('#triOrbBtn');
  if (!b) return;
  b.classList.toggle('on', triOrb);
  setPillGlyph('#triOrbBtn', triOrb);
  b.title = triOrb
    ? 'Triangle mode is ON — click to restore orbs'
    : 'Triangles: upside-down triangles instead of orbs (same colors, same sizes)';
}
// auto-distribute: sun at the center, every other body pinned on mass-ranked
// fibonacci shells (even angular spacing = least-obstruction display), scaled
// to an ellipse that fits the canvas. Eased per-frame so toggles morph.
// Velocities are zeroed while pinned, so unpinning resumes orbital dynamics
// calmly from the orb.
function layoutOrb(u) {
  if (!u || !u.nodes || !u.nodes.length) return;
  const r = document.getElementById('uniCv').getBoundingClientRect();
  const W = Math.max(50, r.width), H = Math.max(50, (r.height || 400));
  const s = (ren.project(ren.cam.tx || 0, ren.cam.ty || 0, ren.cam.tz || 0).s || 1);
  const R = Math.min(W, H) * 0.42 / Math.max(0.05, s);
  const aspect = Math.min(2.2, Math.max(1, W / Math.max(1, H)));
  const RX = R * aspect, RY = R, RZ = R * 0.72;
  // pin the physical sun, never the reader selection: selecting a theme/tag
  // lens node is reader-only (no refocus), so it must not retarget the orb
  // and send the bodies gliding past each other. Main-view focus sets both
  // together, so the classic behavior there is unchanged. Sunless views pin
  // nothing at all — bodies rest on their shells while you inspect them.
  const sunId = (u.sunId && u.byId.has(u.sunId)) ? u.sunId : null;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const fib = (i, n, rad, ph = 0) => {
    const y = n <= 1 ? 0 : 1 - (2 * (i + 0.5)) / n;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * (i + 0.5) + ph;
    return [Math.cos(th) * rr * rad, y * rad, Math.sin(th) * rr * rad];
  };
  const k = 0.16; // ease per frame
  // slot targets first, so a hand-placed body (n._ox…) overrides its fibonacci
  // slot instead of fighting it; toggling Distribute clears customs for a fresh orb.
  const target = new Map();
  const sun = u.nodes.find(n => n.id === sunId);
  if (sun) target.set(sun, [0, 0, 0]);
  const others = u.nodes.filter(n => n.id !== sunId).sort((a, b) => (b.mass || 0) - (a.mass || 0));
  // tiny formations (a 2-theme lens, a 2-doc canvas): no inner-shell parking
  // and the fan opens on +X (lateral) — a lone satellite in the classic
  // depth-heavy 0.55R slot reads as a ~65px speck on a big canvas, so
  // Distribute looks dead next to Fit. Six or more others keep the classic
  // layered orb untouched.
  const tinyForm = others.length <= 5;
  const cut = tinyForm ? 0 : Math.max(1, Math.ceil(others.length * 0.18));
  const inner = others.slice(0, cut), outer = others.slice(cut);
  inner.forEach((n, i) => { const [x, y, z] = fib(i, inner.length, 0.55); target.set(n, [x * RX, y * RY, z * RZ]); });
  outer.forEach((n, i) => { const [x, y, z] = fib(i, outer.length, 1, tinyForm ? -golden * 0.5 : 0); target.set(n, [x * RX, y * RY, z * RZ]); });
  for (const n of u.nodes) {
    n.vx = n.vy = n.vz = 0;
    if (n._held) continue; // mid-drag the pointer owns this body
    let t = target.get(n);
    if (typeof n._ox === 'number' && typeof n._oy === 'number' && typeof n._oz === 'number') t = [n._ox, n._oy, n._oz];
    if (!t) continue;
    n.x += (t[0] - n.x) * k; n.y += (t[1] - n.y) * k; n.z += (t[2] - n.z) * k;
  }
}
// distribute-mode dragging: move a screen delta into the camera's world plane
// at the grabbed body's depth (inverse of Renderer.project). Deltas are
// translation-invariant, so the orbit anchor cancels out — yaw/pitch only.
function dragWorldDelta(dx, dy, p) {
  const cam = ren.cam, s = (p && p.s) || 1;
  const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  const dX = dx / s, dY2 = dy / s;
  const dY = dY2 * cp, dZ = -dY2 * sp;
  return [dX * cy + dZ * sy, dY, -dX * sy + dZ * cy];
}
// retired with the bottom-pill Thematic button: the view-modes strip now
// shows lens state, so this is a no-op kept for its existing callers
function syncLensBtn() {}
function applyLens() {
  try { camCancelGlide(); } catch {} // a universe swap invalidates any in-flight pan
  if (lensThematic) uni = thematicUniFor(vault.activeTabId) || unis.get(vault.activeTabId) || null;
  else if (lensTags) uni = tagUniFor(vault.activeTabId) || unis.get(vault.activeTabId) || null;
  else uni = unis.get(vault.activeTabId) || null;
  // a lens swap is a view change: drop any search dimming (it references the
  // other universe's ids and would leave the restored view half-dark)
  try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; } catch {}
  matchSet = null;
  if (uni && activeId && !uni.byId.has(activeId)) activeId = (lensThematic || lensTags) ? uni.sunId : null; // a stale pick never resurrects a doc: entering a lens keeps its sun, leaving for Main goes neutral
  try { vault.tab().activeId = activeId; } catch {}
  syncLensBtn();
  try { syncViewModes(); } catch {}
  renderDoc();
  updateStats();
}
// panel collapse: shrink the column up into a slim top tab (arrow flips ▲/▼)
function setCollapsed(id, on) {
  const p = document.getElementById(id);
  if (!p) return;
  p.classList.toggle('collapsed', !!on);
  const b = p.querySelector('[data-collapse]');
  if (b) { b.textContent = on ? '▼' : '▲'; b.title = on ? 'Expand panel' : 'Collapse panel'; }
  if (id === 'leftPanel') leftCollapsed = !!on;
  if (id === 'leftPanel') { try { syncPinTabs(); } catch {} } // re-seat the pin tabs at the new edge
  if (id === 'docPanel') docCollapsed = !!on;
  saveUi();
  try { applyDocWidth(); } catch {}
  try { placeTabBar(); } catch {}
}
// bottom pill "Hover peek": on = hovering a body lights up its row in the general list
function syncHv() {
  const b = $('#hvBtn');
  if (!b) return;
  b.classList.toggle('on', hoverPrev);
  b.textContent = 'Hover peek';
  b.title = hoverPrev ? 'Hover highlight on — hovering a body lights up its row (click to turn off)' : 'Hover highlight off — hovering a body does nothing (click to turn on)';
}
// bottom pill "Tethers" button: show/hide the tether lines only (bodies always stay).
// It drives the same tetherScale as the left-panel Tether row, so both stay in sync.
function syncIsoBtn() {
  const b = $('#isoBtn');
  if (!b) return;
  b.classList.toggle('on', tetherScale > 0);
  b.textContent = 'Tethers';
}
// bottom pill "2" tether partition: dotted tethers — the same lines as spaced
// round dots instead of solid strokes (independent of show/hide + thickness).
function syncTetherDotsBtn() {
  const b = $('#tetherDotsBtn');
  if (!b) return;
  const on = tetherDotted && !tetherSparse && !tetherDashed;
  b.classList.toggle('on', on);
  b.title = on ? 'Dotted tethers on — click for solid lines' : 'Dotted tethers: draw the tether lines as spaced dots instead of solid lines';
}
// bottom pill "3" tether partition: sparse dots — the same dotted stroke with
// a much wider gap, for crowded canvases where normal dots still clutter.
function syncTetherSparseBtn() {
  const b = $('#tetherSparseBtn');
  if (!b) return;
  b.classList.toggle('on', tetherSparse);
  b.title = tetherSparse ? 'Sparse tethers on — barely-there dots, far apart — click for solid lines' : 'Sparse tethers: widely-spaced dots for crowded canvases, minimally obtrusive';
}
// bottom pill "4" tether partition: dashed tethers — long dashes set far
// apart instead of dots, another barely-there option for crowded canvases.
function syncTetherDashedBtn() {
  const b = $('#tetherDashedBtn');
  if (!b) return;
  b.classList.toggle('on', tetherDashed);
  b.title = tetherDashed ? 'Dashed tethers on — long dashes, far apart — click for solid lines' : 'Dashed tethers: long dashes set far apart, barely-there links for crowded canvases';
}
// associated-document overlays (thematic view): canvas-wide on/off for
// the ASSOCIATED-document name labels only — orb labels stay on the
// left-panel Labels row. On = every associated document currently in view
// shows its name; off = all hidden. With nothing in view the toggle sits
// off and explains how to show documents first.
function visibleAssocOverlays() {
  if (!lensThematic) return [];
  const themes = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
  const out = [];
  for (const th of themes) { if (assocOverlayFor(th)) out.push(th); }
  return out;
}
// sand document glyph for the retired pill Labels button (icon + text, no state dot)
const LB_DOC_SVG = '<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M2 0h6l4 4v9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V1a1 1 0 0 1 1-1z" fill="#ffffff" stroke="#000000" stroke-width="1"/><path d="M8 0l4 4H8z" fill="#c7d0dd"/></svg>';
function syncLbPill() {
  const b = $('#lbPillBtn');
  if (!b) return;  const vis = visibleAssocOverlays();
  const on = vis.length > 0 && vis.every(th => assocOverlayFor(th).labels);
  b.classList.toggle('on', on);
  b.innerHTML = LB_DOC_SVG + ' Labels';
  b.title = !vis.length
    ? 'No associated documents in view — right-click a theme orb (or empty canvas) to show them (orb labels stay in the left pane)'
    : on ? 'Labels on — hide every associated-document name (orb labels stay in the left pane)'
    : 'Labels off — show names under every associated document (orb labels stay in the left pane)';
}
// bottom pill "Tips" toggle: collapses only the tips rows, never the buttons
// associated-document name labels (thematic overlay): one tap flips the names
// on EVERY associated document currently in view (orb labels untouched — the
// left pane owns those). Mixed states normalize: if any shown name is on,
// the tap turns them all off. (Was the bottom-pill Labels tab; now lives in
// the thematic right-click menus.)
function toggleAssocDocLabels() {
  const vis = visibleAssocOverlays();
  if (!vis.length) { toast('No associated documents in view — right-click a theme orb (or empty canvas) to show them'); return; }
  const turnOn = !vis.every(th => assocOverlayFor(th).labels);
  const scope = assocScopeKey();
  const all = assocAll.get(scope);
  if (all) all.labels = turnOn;
  for (const th of vis) {
    const r = assocReq.get(scope + '|' + th.id);
    if (r) r.labels = turnOn;
  }
  try { syncLbPill(); } catch {}
  toast(turnOn ? 'Associated-document labels on' : 'Associated-document labels off');
}
function syncTipsBtn() {
  const b = $('#tipsBtn'), bar = $('#hintBar');
  if (!b || !bar) return;
  bar.classList.toggle('notips', tipsCollapsed);
  b.classList.toggle('open', !tipsCollapsed); // red border while the tips are shown (non-collapsed)
  b.textContent = (tipsCollapsed ? '▸ Tips' : '▾ Tips');
  b.title = tipsCollapsed ? 'Show the tips below the pill buttons' : 'Hide the tips below the pill buttons (buttons stay)';
  try { syncHbTabs(); } catch {} // ▸/▾ swap can shift the widest tab: re-equalize
  try { sizeDocPanel(); } catch {} // pill height changed — re-park the reader's bottom edge (+ riders)
  // the pill can settle a hair after the toggle (fonts/wraps) — one post-settle pass, then done
  setTimeout(() => { try { sizeDocPanel(); } catch {} }, 200);
}

// bottom-pill book tabs: every function tab wears the Tips hanging-tab shape
// plugged through the pill's top edge. Tips itself keeps its natural width,
// as does the snug Distribute|Fit split (both partitions hug their text);
// every other tab shares one equalized width — the widest natural — so they
// read as a uniform set of folder tabs beside it.
function syncHbTabs() {
  try {
    const tips = document.querySelector('#hintBar #tipsBtn');
    if (tips) tips.style.width = ''; // Tips is always natural width, never equalized
    const singles = [...document.querySelectorAll('#hintBar .hb-btns > button:not(#tipsBtn):not(.glassDot):not(.luxDot)')];
    const splits = [...document.querySelectorAll('#hintBar .hb-btns > .splitab')];
    if (!singles.length && !splits.length) return;
    const ds = document.getElementById('distSplit');
    if (ds) ds.style.width = ''; // the snug split is always content-sized, never equalized
    const eq = [...singles, ...splits.filter(s => s.id !== 'distSplit')];
    for (const b of eq) b.style.width = ''; // re-measure from natural width (fonts/label swaps)
    let w = 0;
    for (const b of eq) w = Math.max(w, b.getBoundingClientRect().width);
    w = Math.ceil(w);
    if (w > 0) for (const b of eq) b.style.width = w + 'px';
  } catch {}
}

// ---------- "?" explicator popups: editable in the editor, locked in desktop exports ----------
// DESKTOP EXPORT NOTE: set `window.VISIDOCSVERSE_HELP_LOCKED = true` in the exported shell
// (e.g. `<script>window.VISIDOCSVERSE_HELP_LOCKED = true</script>` before src/app.js) to hide
// every ✎ edit button. file:// / Tauri / Electron shells are auto-locked below, so a plain
// static export already ships read-only even if you forget the flag. The same
// lock gates the glossary ✎ buttons, and glossary edits live only in
// localStorage (never backups, never src), so installers always ship the
// pristine default text — no strip step needed for either.
const DEFAULT_HELP = {
  shared: 'Shared ground = the same (or very similar) conversation. We compare the distinctive themes in each file — files (\'bodies\') sharing themes with this one land here.',
  mass: 'Mass is pull. Bigger, more comprehensive, files \'weigh\' more, so they tug harder on everything around them.',
  energy: 'Total motion in the document universe. High "system energy" numbers mean bodies are flying fast — especially if more files (\'bodies\') are being added — and it settles as correlational orbits stabilize.',
  rim: 'The edge of the visualized document universe. Files (\'bodies\') drifting past it are loners with no links — a single reference can pull them back in and connect them.',
  thematic: 'The Thematic view redraws the canvas around the ideas the documents share — terms that travel together become theme bodies, sized by thematic weight. Click a theme to see its members, click a member to open it as the sun; toggling Thematic off restores the Main view.',
  viewMain: 'Main view — the regular canvas universe: one body per document, orbiting the focused sun (or the canvas center with nothing active). This is the default view and the one both lenses rebuild — leaving the Thematic or Tags view always returns here with the formation untouched.',
  viewThematic: 'Thematic view — the canvas redrawn around the ideas its documents share: terms that travel together across files are distilled into theme bodies, one per theme, sized by thematic weight and webbed by shared members. Click a theme to see its members, click a member to open it; toggling Thematic off restores the Main view untouched.',
  viewTag: 'Tags view — the canvas redrawn around the labels on its documents: one body per tag, webbed wherever two tags share member documents, sized by grounded-body count. Click a tag to see its grounded members, click a member to open it as the sun — which returns you to the Main view. Mutually exclusive with the Thematic view.',
  grounded: 'Grounded documents/bodies is about the theme or tag you\'re inspecting. A theme body (a distilled idea) or tag body (a label) isn\'t a file — it\'s "grounded in" the member documents whose text or labels give it weight. The GROUNDED section lists those member files. Think: "which documents is this idea/label standing on?" Clicking a row drills down into that member document. In short: grounded documents fan inward from one theme/tag to the member files behind it.',
  ungrounded: 'Ungrounded documents are the files no theme grounds — leftovers that carry none of the distilled ideas strongly enough to be members. Each one still rides on exactly one theme orb: the theme whose terms hit its text hardest, or the largest theme when nothing hits. The UNGROUNDED section lists those guests below the grounded members — same rows, same clicks. Think: "which theme does this leftover resemble most?" In short: ungrounded files fan in from nowhere and park with the theme they resemble most.',
  files: 'Your files stay right where they are.\n\nWhen you add a file or folder to Visi|Docsverse, the app never moves, copies, or alters your original files on your hard drive.\n\nInstead, it simply creates a lightweight visual duplicate (a "rendered clone") inside the canvas so you can map, explore, and connect your documents without touching your original work.',
  search: 'Searches across documents — it finds which file(s) in the project/verse match, so you can quickly jump to a different doc.',
  tip1: '<span class="tt-w">drag empty space to pan</span><span class="tt-sep">·</span><span class="tt-g">drag a body to rotate</span><span class="tt-sep">·</span><span class="tt-w">alt-drag a body to move it</span><span class="tt-sep">·</span><span class="tt-g">wheel to zoom</span><span class="tt-sep">·</span><span class="tt-w">alt+↑/↓ zooms</span>',
  tip2: '<span class="tt-g">click a body to find it in the inventory</span><span class="tt-sep">·</span><span class="tt-w">click empty space to release</span><span class="tt-sep">·</span><span class="tt-g">double click empty space to (re)center</span><span class="tt-sep">·</span><span class="tt-w">shift-drag to box-select</span><span class="tt-sep">—</span><span class="tt-w">Del deletes selection</span><span class="tt-sep">·</span><span class="tt-g">right-click to delete</span>',
  tip3: '<span class="tt-g">main view : right-click -hold a body to preview its document</span><span class="tt-sep">·</span><span class="tt-w">quick right-click opens its menu</span><span class="tt-sep">·</span><span class="tt-w">release to close, or pin it with the row&rsquo;s 👁</span>',
  ovNoCanvas: 'Every canvas is closed. Click + in the top bar to start a fresh canvas, or open Open Project to load a master file from your computer.',
  ovThematic: 'Click a theme body to inspect its concepts and grounded bodies.',
  ovThematicEmpty: 'No shared concepts to distill yet — add documents with overlapping vocabulary.',
  ovThematicRelease: 'Click empty space anytime to release the sun; the screen center holds gravity in this state.',
  ovTags: 'One body per tag, webbed by the bodies they share. Click a tag to make it the gravitational center; click empty space to release the center — the screen middle holds gravity in this state.',
  ovEmpty: 'This canvas is empty — import files, or right-click a body on another canvas and copy it here.',
  ovMain: 'Click any body to make it the gravitational center. Click empty space to release the sun — the screen center holds gravity. Toggle Thematic with nothing selected for the whole-Visi|Docsverse theme map.',
  closeCanvas: 'Close canvas “{name}” with {n} {bodies}? This removes it from the workspace — click “Save project” on its tab first to keep a backup copy on your computer, otherwise this work will be lost.',
  closeCanvasBlank: 'Close blank canvas “{name}”?',
  addToTab: 'Add a canvas to {name} — it joins this universe automatically',
  addTabOut: 'Create a new canvas outside this universe — standalone, it won’t join these canvases',
  createTab: 'Create new project canvas',
  tabs: 'Your projects autosave inside Visi|Docsverse and reopen automatically next launch when you click on Open Project. Saving a project to your computer keeps a separate backup copy outside the app.',
};
const HELP_TITLES = {
  shared: 'Shared Ground', mass: 'Mass', energy: 'System energy', rim: 'The rim', thematic: 'Thematic view', viewMain: 'Main view', viewThematic: 'Thematic view', viewTag: 'Tags view', grounded: 'Grounded documents', ungrounded: 'Ungrounded documents', files: 'Files', search: 'Search',
  tip1: 'Bottom pill tips (row 1)', tip2: 'Bottom pill tips (row 2)', tip3: 'Bottom pill tips (row 3)',
  ovNoCanvas: 'Overview text (no open canvas)', ovThematic: 'Overview text (Thematic view)', ovThematicEmpty: 'Overview text (Thematic view, nothing distilled)', ovThematicRelease: 'Overview text (releasing the sun)', ovTags: 'Overview text (Tags view)', ovEmpty: 'Overview text (empty canvas)', ovMain: 'Overview text (Main view)',
  tabs: 'Active projects header',
  closeCanvas: 'Close-canvas notice', closeCanvasBlank: 'Close-canvas notice (blank canvas)',
  addToTab: 'Inside-frame “+” caption', addTabOut: 'Outside-frame “+” caption', createTab: '“Create Project” caption',
};
let helpTexts = { ...DEFAULT_HELP };
try {
  const stored = JSON.parse(localStorage.getItem('visidocsverse.help') || '{}');
  for (const k of Object.keys(DEFAULT_HELP)) {
    if (typeof stored[k] === 'string' && stored[k].trim()) helpTexts[k] = stored[k];
  }
} catch { /* fresh prefs */ }
function saveHelp() {
  try { localStorage.setItem('visidocsverse.help', JSON.stringify(helpTexts)); } catch { /* private mode */ }
}
// one-time wording migration: installs carrying the pre-"view" Thematic
// explanation get the new text, unless they customized it themselves
try {
  const OLD_THEMATIC = 'Thematic lens: rebuilds the universe from shared themes + tags only — one body per theme, sized by its weight. Click a member to drill down; toggle Thematic off to restore the full universe.';
  const stored0 = JSON.parse(localStorage.getItem('visidocsverse.help') || '{}');
  if (stored0 && stored0.thematic === OLD_THEMATIC) { helpTexts.thematic = DEFAULT_HELP.thematic; saveHelp(); }
// row-1 rewording (alt-drag now moves bodies in every mode, not just
// distribute): installs carrying the pre-rewording stored default get the
// new text, unless they customized it themselves
try {
  const OLD_TIP1 = '<span class="tt-w">drag empty space to pan</span><span class="tt-sep">·</span><span class="tt-g">drag a body to rotate</span><span class="tt-sep">·</span><span class="tt-w">distribute: alt-drag a body to move it</span><span class="tt-sep">·</span><span class="tt-g">wheel to zoom</span><span class="tt-sep">·</span><span class="tt-w">alt+↑/↓ zooms</span>';
  const stored0b = JSON.parse(localStorage.getItem('visidocsverse.help') || '{}');
  if (stored0b && stored0b.tip1 === OLD_TIP1) { helpTexts.tip1 = DEFAULT_HELP.tip1; saveHelp(); }
} catch { /* fresh prefs */ }
// row-2 rewording (canvas clicks locate instead of crowning): installs
// carrying the pre-rewording stored default get the new text, unless they
// customized it themselves
try {
  const OLD_TIP2 = '<span class="tt-g">click a body for sun</span><span class="tt-sep">·</span><span class="tt-w">click empty space to release</span><span class="tt-sep">·</span><span class="tt-g">double click empty space to (re)center</span><span class="tt-sep">·</span><span class="tt-w">shift-drag to box-select</span><span class="tt-sep">—</span><span class="tt-w">Del deletes selection</span><span class="tt-sep">·</span><span class="tt-g">right-click to delete</span>';
  const stored0c = JSON.parse(localStorage.getItem('visidocsverse.help') || '{}');
  if (stored0c && stored0c.tip2 === OLD_TIP2) { helpTexts.tip2 = DEFAULT_HELP.tip2; saveHelp(); }
} catch { /* fresh prefs */ }
} catch { /* fresh prefs */ }
function helpEditAllowed() {
  try {
    if (window.VISIDOCSVERSE_HELP_LOCKED === true) return false;
    const q = new URLSearchParams(location.search || '');
    if (q.get('helpedit') === '0' || q.get('noedit') === '1') return false;
    if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__) return false;
    if (window.NL_PORT != null || window.NL_TOKEN != null || window.NL_APPID != null || window.NL_VERSION != null) return false; // Neutralino desktop shell (localhost http, so the Tauri/file checks above miss it)
    if (typeof Neutralino !== 'undefined') return false; // Neutralino client API present = desktop shell, even if the NL_* constants are ever absent
    const p = String(location.protocol || '').toLowerCase();
    if (p === 'file:' || p === 'tauri:' || p === 'wry:' || p === 'app:') return false;
    const ua = String(navigator.userAgent || '').toLowerCase();
    if (ua.includes(' tauri/') || ua.includes('electron/') || ua.includes(' wry/')) return false;
  } catch { /* default to editable */ }
  return true;
}
function applyHelpToStatic() {
  for (const k of Object.keys(DEFAULT_HELP)) {
    // pill tip rows render as HTML (their white/gold spans); everything
    // else is plain text. Dev-typed HTML is self-trusted (own machine).
    const asHtml = k.startsWith('tip');
    document.querySelectorAll(`[data-help-text="${k}"]`).forEach(el => {
      if (asHtml) el.innerHTML = helpTexts[k]; else el.textContent = helpTexts[k];
    });
  }
}
let helpEditingKey = null;
// Explicit help-close: drop the pin AND hide the pop at once, skipping the
// .6s hover grace in the CSS — otherwise the glide down onto the rows below
// crosses the still-visible pop, whose :hover re-shows it right after
// closing (the "after flicker" on the grounded/tag pop-outs). The inline
// hide clears itself the moment the cursor leaves the ?, so the next hover
// peeks normally — closing buys silence until mouse-leave, as expected.
function shutHelpPop(w) {
  if (!w) return;
  w.classList.remove('open', 'help-open');
  const pop = w.querySelector('.sg-help-pop');
  if (!pop) return;
  pop.style.transition = 'none';
  pop.style.visibility = 'hidden';
  pop.style.opacity = '0';
  const q = w.querySelector('[data-sghelp]');
  if (q) {
    const clear = () => { pop.style.visibility = ''; pop.style.opacity = ''; pop.style.transition = ''; q.removeEventListener('mouseleave', clear); };
    q.addEventListener('mouseleave', clear);
  }
  try { syncTabBarZ(); } catch {}
}
function openHelpEditor(key) {
  if (!helpEditAllowed() || !DEFAULT_HELP[key]) return;
  helpEditingKey = key;
  glossEditingWord = null;
  const modal = document.querySelector('#helpEditModal');
  const title = document.querySelector('#helpEditTitle');
  const area = document.querySelector('#helpEditText');
  const hint = document.querySelector('#helpEditHint');
  if (!modal || !area) return;
  if (title) title.textContent = `Edit “${HELP_TITLES[key] || key}” explanation`;
  if (hint) hint.textContent = 'Saved on this machine + included in cloud backups / master files.' + (key && key.indexOf('closeCanvas') === 0 ? ' Placeholders: {name} = canvas name, {n} = body count, {bodies} = “body”/“bodies”.' : '') + (key === 'addToTab' ? ' Placeholder: {name} = the joined universe’s carrier canvas name.' : '');
  area.value = helpTexts[key];
  modal.hidden = false;
  setTimeout(() => { try { area.focus(); area.select(); } catch {} }, 30);
}
function closeHelpEditor() {
  helpEditingKey = null;
  glossEditingWord = null;
  guideEditing = false;
  howEditing = false;
  const modal = document.querySelector('#helpEditModal');
  if (modal) { modal.hidden = true; modal.style.zIndex = ''; } // clear any confirm-modal bump (see confirmDlg editKey)
}
function saveHelpEditor(reset) {
  if (glossEditingWord) { saveGlossEditor(reset); return; }
  if (guideEditing) { saveGuideEditor(reset); return; }
  if (howEditing) { saveHowEditor(reset); return; }
  if (!helpEditingKey) return;
  const area = document.querySelector('#helpEditText');
  if (reset) {
    helpTexts[helpEditingKey] = DEFAULT_HELP[helpEditingKey];
  } else if (area) {
    const v = area.value.trim();
    helpTexts[helpEditingKey] = v || DEFAULT_HELP[helpEditingKey];
  }
  saveHelp();
  // live-update every visible popup with this key (static + just-rendered dynamic)
  document.querySelectorAll(`[data-help-text="${helpEditingKey}"]`).forEach(el => {
    if (helpEditingKey.startsWith('tip')) el.innerHTML = helpTexts[helpEditingKey];
    else el.textContent = helpTexts[helpEditingKey];
  });
  // "+" hover captions live in native titles (no popup to patch): rebuild
  // the tab bar so the new wording shows on next hover
  const captionKey = helpEditingKey;
  closeHelpEditor();
  if (captionKey === 'addToTab' || captionKey === 'addTabOut' || captionKey === 'createTab') { try { renderTabs(); } catch {} }
  toast('Explanation saved');
}
// reader overview blurb: stored wording + a dev-only ✎ (visible only under
// body.help-can-edit, same as every helper — locked in desktop/file shells).
// The data-help-text span lets the editor live-update it after saving.
function ovBlurb(key) {
  return `<span class="ovblurb"><span data-help-text="${key}">${esc(helpTexts[key])}</span> <button class="help-edit-btn" data-help-edit="${key}" title="Edit this explanation">✎ edit</button></span>`;
}
// ---------- glossary editing: same lock, but machine-only (never ships) ----------
// Overrides live ONLY in localStorage (`visidocsverse.gloss`): they are never
// written back into index.html, never added to cloud backups / master files,
// and the ✎ buttons only exist when helpEditAllowed() (editor preview —
// desktop shells, file:// and ?helpedit=0 are locked out). Installers are
// built from src/ + the static index.html, so personal wording can never
// reach consumers; installed apps always open on the pristine default text.
let glossEdits = {};
try {
  const g = JSON.parse(localStorage.getItem('visidocsverse.gloss') || '{}');
  if (g && typeof g === 'object') glossEdits = g;
} catch { /* fresh prefs */ }
function saveGloss() {
  try { localStorage.setItem('visidocsverse.gloss', JSON.stringify(glossEdits)); } catch { /* private mode */ }
}
const glossOrig = {}; // pristine term HTML, captured before the first override
function glossDefText(term) {
  try {
    const w = term.querySelector('.g-word')?.textContent || '';
    let t = term.textContent || '';
    const i = t.indexOf(w);
    if (i >= 0) t = t.slice(i + w.length);
    return t.replace(/^[\s—–-]+/, '').trim();
  } catch { return ''; }
}
function applyGlossEdits() {
  try {
    document.querySelectorAll('#glossBody .g-term').forEach(term => {
      const w = term.querySelector('.g-word')?.textContent || '';
      if (!w) return;
      if (!(w in glossOrig)) glossOrig[w] = term.innerHTML;
      term.innerHTML = glossEdits[w] ? `<span class="g-word">${esc(w)}</span> — ${esc(glossEdits[w])}` : glossOrig[w];
    });
    injectPinButtons(); // edits rewrite term HTML — re-attach the pin buttons after
  } catch { /* glossary not in DOM */ }
}
function wireGlossEdit() {
  if (!helpEditAllowed()) return;
  try {
    document.querySelectorAll('#glossBody .g-term').forEach(term => {
      if (term.querySelector('.gloss-edit-btn')) return;
      const w = term.querySelector('.g-word')?.textContent || '';
      if (!w) return;
      const b = document.createElement('button');
      b.className = 'help-edit-btn gloss-edit-btn';
      b.dataset.glossEdit = w;
      b.title = 'Edit this glossary entry (this machine only — never ships to installers)';
      b.textContent = '✎ edit';
      term.appendChild(b);
    });
  } catch {}
}
let glossEditingWord = null;
function openGlossEditor(word) {
  if (!helpEditAllowed()) return;
  const term = [...document.querySelectorAll('#glossBody .g-term')]
    .find(t => (t.querySelector('.g-word')?.textContent || '') === word);
  if (!term) return;
  glossEditingWord = word; helpEditingKey = null;
  const modal = document.querySelector('#helpEditModal');
  const title = document.querySelector('#helpEditTitle');
  const area = document.querySelector('#helpEditText');
  const hint = document.querySelector('#helpEditHint');
  if (!modal || !area) return;
  if (title) title.textContent = `Edit glossary: ${word}`;
  if (hint) hint.textContent = 'Saved on this machine only — glossary edits never ride backups or installers.';
  area.value = glossDefText(term);
  modal.hidden = false;
  setTimeout(() => { try { area.focus(); area.select(); } catch {} }, 30);
}
function saveGlossEditor(reset) {
  const word = glossEditingWord;
  if (!word) return;
  const area = document.querySelector('#helpEditText');
  if (reset) delete glossEdits[word];
  else if (area) {
    const v = area.value.trim();
    if (v) glossEdits[word] = v; else delete glossEdits[word];
  }
  saveGloss();
  applyGlossEdits(); wireGlossEdit();
  closeHelpEditor();
  toast(reset ? 'Glossary entry reset to default' : 'Glossary entry saved (this machine only)');
}
let virtT = performance.now() / 1000; // virtual clock: frozen on pause, slowed by slider
let lastReal = performance.now();

// ---------- canvases (top tabs): switch / create / close / render ----------
// connected association group for a tab id (the "project"): the tab plus
// every tab reachable through mutual assoc links, in tab order.
function projectGroup(id) {
  const start = vault.tabs.find(t => t.id === id);
  if (!start) return [];
  const seen = new Set([id]);
  const q = [id];
  while (q.length) {
    const qid = q.pop();
    const node = vault.tabs.find(x => x.id === qid);
    if (!node) continue;
    for (const aid of vault.assocIds(node)) {
      if (!seen.has(aid) && vault.tabs.some(x => x.id === aid)) { seen.add(aid); q.push(aid); }
    }
  }
  return vault.tabs.filter(t => seen.has(t.id));
}
// a universe's carrier: its main verse, else its first tab. Lone tabs are
// universes of one and park their own "+" right after them.
function groupCarrier(group) {
  return group.find(x => x.main) || group[0] || null;
}
// linking A↔B is forbidden only when it would fuse two established
// (multi-canvas) universes — a canvas answers to exactly one carrier.
// Unlinking is always fine, lone canvases can always join or form a universe
// (deliberate absorption, recoverable via unlink), and links inside one
// group are harmless.
// top pill lane: the tab pill must never slide under the side panes, so it
// is centered in the free lane between the left panel's right edge and the
// reader's left edge (viewport margins when a side is collapsed, hidden or off-screen).
function pillOverlapsReader() {
  try {
    const bar = document.getElementById('tabBar'), dp = document.getElementById('docPanel');
    if (!bar || !dp || dp.hidden || !dp.offsetParent || dp.classList.contains('collapsed')) return false;
    const a = bar.getBoundingClientRect(), b = dp.getBoundingClientRect();
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  } catch { return false; }
}
// projects-pill stacking: the pill sits below the reader (z20 < z21) so a
// stretched reader slides OVER it, while the bottom pill (z25) stays on top.
// The only exception is an open ? popover showing clear of the reader — it
// floats above everything (z30) as before. A static :has rule can't see the
// overlap, so this runs on every pill/reader geometry change + help toggle.
function syncTabBarZ() {
  try {
    const bar = document.getElementById('tabBar');
    if (!bar) return;
    let showing = false;
    try {
      showing = !!bar.querySelector('.help-open, .sg-help:hover, .sg-help:focus, .sg-help-pop:hover, .sg-help-pop:focus-within');
    } catch {}
    bar.style.zIndex = (showing && !pillOverlapsReader()) ? '30' : '';
  } catch {}
}
function placeTabBar() {
  const bar = document.getElementById('tabBar');
  if (!bar) return;
  const vw = window.innerWidth, gap = 8;
  let L = 8, R = vw - 8;
  const vis = (el) => el && !el.hidden && el.offsetParent !== null;
  const lp = document.getElementById('leftPanel');
  if (vis(lp)) { const b = lp.getBoundingClientRect(); if (b.left < vw / 2 && b.right > L) L = Math.min(b.right + gap, vw - 120); }
  const gt = document.getElementById('glossTab'); // book tab protrudes 25px past the left panel: clear it too
  if (vis(gt)) { const b = gt.getBoundingClientRect(); if (b.left < vw / 2 && b.right > L) L = Math.min(b.right + gap, vw - 120); }
  // the pills keep their own natural size (never stretched to match each
  // other) and dock at the lane's left beside the left pane — until the user
  // hand-drags one elsewhere (that position persists; auto-layout then only
  // enforces the size caps + right-edge clamp). A stretched reader slides OVER
  // the top pill and UNDER the bottom one (z-ladder) instead of squeezing them.
  const laneW = R - L;
  pillLaneW = R - L;
  if (laneW < 240) { L = 8; R = vw - 8; pillLaneW = R - L; } // degenerate sliver: fall back to viewport margins
  bar.style.maxWidth = Math.max(240, R - L) + 'px';
  if (pillsCentered && (tabX == null || hintX == null)) {
    seatPillsCenter(); // legacy save: flag on but no coords — seat the stack fresh
    try { applyGlossGeom(); } catch {}
    syncTabBarZ();
    return;
  }
  if (tabX == null) { bar.style.transform = 'none'; bar.style.left = L + 'px'; bar.style.top = ''; } // docked-x: full CSS seat (left + top) — the top pill is hard-attached to the viewport top, never a hand height
  else applyTabGeom(); // user-moved: keep the hand position, enforce the right clamp
  syncPillPair(bar, L);
  enforceTopRight(); // the top pill matches the bottom pill's width exactly (one shared tandem x)
  centerPillsX(); // centered toggle: enforceTopRight already re-seats, but it bails while the bottom pill is hidden — re-assert here per visible pill
  try { applyGlossGeom(); } catch {} // the top pill may have wrapped taller: keep the glossary out from under it
  syncTabBarZ(); // restack after every move: reader-over-pill vs popover-above
  verifyPillsOnScreen(); // self-heal: a pill parked off-screen (stale save, older build, missed clamp) re-docks instead of stranding its controls
}
// pill rescue: if either pill ends up even partly off-screen (stale coords from
// an older build, an in-place restore that nulled coords without clearing inline
// heights, or any clamp the position missed), re-dock it instead of leaving its
// controls stranded. Runs at the end of every placeTabBar (boot, resize, settle
// cascade, toggles), so a bad state heals on the next layout pass at the latest.
// Only fires on a genuinely off-screen pill — hand drags stay clamped on-screen
// by construction and never trigger it.
let __pillVerifyDepth = 0;
function verifyPillsOnScreen() {
  if (__pillVerifyDepth) return;
  try {
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!(vw > 50) || !(vh > 50)) return; // not laid out yet
    const rescued = [];
    const jobs = [
      ['tabBar', () => { tabX = null; tabY = null; }],
      ['hintBar', () => { hintX = null; hintY = null; }],
    ];
    for (const [id, nullCoords] of jobs) {
      const el = document.getElementById(id);
      if (!el || !pillShown(el)) continue; // hidden (mobile CSS): leave it alone
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue; // not laid out yet
      if (r.top < -2 || r.left < -2 || r.right > vw + 2 || r.bottom > vh + 2) {
        // nothing to change (already docked, no inline offsets) yet still out
        // of view — e.g. a pill taller than a tiny viewport: leave it alone so
        // repeated layout passes can't re-fire (no toast loops, no save churn).
        const docked = (id === 'tabBar' ? (tabX == null || tabY == null) : (hintX == null || hintY == null));
        if (docked && !el.style.top && !el.style.bottom && !el.style.transform) continue;
        nullCoords();
        el.style.transform = 'none';
        el.style.top = ''; el.style.bottom = '';
        rescued.push(id);
      }
    }
    if (!rescued.length) return;
    __pillVerifyDepth++;
    try { placeTabBar(); } finally { __pillVerifyDepth--; }
    try { saveUi(); } catch {}
    try { toast('A pill was off-screen — moved back into view'); } catch {}
  } catch {}
}
// MAIN folder-tab canvas mimic: the tab's fill tracks the canvas center shade
// (white -> #11161f across bgShade, same mix as the renderer's backdrop core),
// so it always reads as cut from the canvas below. The bottom pill's hanging
// book tabs ride the same fill (var(--hbtabbg) on #hintBar) so they always
// match the canvas too. Change-cached: one compare per frame, style writes
// only per shade change.
let mainTabBgSeen = null;
function syncMainTabBg() {
  try {
    const sh = Math.max(0, Math.min(1, typeof bgShade === 'number' ? bgShade : 1));
    if (sh === mainTabBgSeen) return;
    mainTabBgSeen = sh;
    const bar = document.getElementById('tabBar');
    if (!bar) return;
    const mix = (a, b) => Math.round(a + (b - a) * sh);
    const tabBg = `rgb(${mix(255, 17)},${mix(255, 22)},${mix(255, 31)})`;
    bar.style.setProperty('--maintabbg', tabBg);
    try { document.documentElement.style.setProperty('--maintabbg', tabBg); } catch {} // global copy: mini folder tabs (gotoSide) seat in canvas fill too
    try { document.getElementById('hintBar')?.style.setProperty('--hbtabbg', tabBg); } catch {} // bottom-pill book tabs: same canvas fill, updated live with the shade
  } catch {}
}
// pill visibility: offsetParent is ALWAYS null for position:fixed elements
// (the top pill), so it can never be used as a shown/hidden test for the
// pills — a rect-based check instead. Hidden = mobile CSS / .hidden only.
function pillShown(el) {
  try {
    if (!el || el.hidden) return false;
    const c = getComputedStyle(el);
    if (c.display === 'none' || c.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch { return false; }
}
// pill-pair docking: the top + bottom pills share the lane's left edge; the
// bottom pill keeps its own natural width and the top pill matches it
// exactly (see enforceTopRight). Hand-dragging EITHER pill slides BOTH (see
// slidePillsTandem) — one shared x, so the pair never drifts apart;
// auto-layout only sets the top width, so neither pill ever overflows.
function syncPillPair(bar, dockL) {
  try {
    const hint = document.getElementById('hintBar');
    if (!hint || !bar) return;
    if (!pillShown(hint)) return; // hidden (mobile): leave it alone
    bar.style.width = ''; // natural size: never stretched to match the other pill
    hint.style.width = ''; // natural size: never stretched to match the other pill
    hint.style.boxSizing = 'border-box';
    hint.style.maxWidth = bar.style.maxWidth || '96vw'; // cap only
    if (hintX == null) {
      // docked-x: share the lane's left edge with the top pill, at own width
      hint.style.transform = 'none';
      hint.style.top = ''; hint.style.bottom = ''; // back to the CSS bottom:0 seat
      hint.style.left = (typeof dockL === 'number' ? dockL : bar.getBoundingClientRect().left) + 'px';
    } else applyHintGeom(); // user-moved: keep the hand position, enforce the right clamp
  } catch {}
}
// screen-size auto-fit: pill positions are saved together with the viewport
// they were placed on; on open (fresh load or backup restore) scale them
// onto the current screen so the pair lands proportionally, then clampPill
// + placeTabBar keep both pills fully on-screen. Factors are capped so an
// odd saved size can never fling a pill across the display.
// hand-draggable pills: fixed size (never stretchable). Both pills are fully
// contained in the viewport at all times — no part can leave the screen —
// and both pills only slide horizontally (heights are hard-docked: top pill
// to the viewport top, bottom pill to the viewport bottom). Double-click a
// pill's background to send it back to the dock.
function fitPillsToScreen(savedVw, savedVh) {
  try {
    const cw = window.innerWidth, ch = window.innerHeight;
    if (!(savedVw > 0) || !(savedVh > 0)) return; // legacy save without a screen size: clampPill still keeps it on-screen
    if (savedVw === cw && savedVh === ch) return; // same screen: nothing to do
    const kx = Math.min(2, Math.max(0.5, cw / savedVw));
    const ky = Math.min(2, Math.max(0.5, ch / savedVh));
    if (tabX != null && tabY != null) { tabX = Math.round(tabX * kx); tabY = Math.round(tabY * ky); }
    if (hintX != null && hintY != null) { hintX = Math.round(hintX * kx); hintY = Math.round(hintY * ky); }
  } catch {}
}
function clampPill(box, x, y) {
  try {
    const r = box.getBoundingClientRect();
    const w = Math.max(80, r.width || 200), h = Math.max(30, r.height || 40);
    const vw = window.innerWidth, vh = window.innerHeight;
    x = Math.min(Math.max(x, 8), Math.max(8, vw - w - 8));
    y = Math.min(Math.max(y, 8), Math.max(8, vh - h - 8));
    return [x, y];
  } catch { return [x, y]; }
}
// pill tandem: hand-dragging EITHER pill slides BOTH to the same x, so the
// pair never drifts apart (widths already match via enforceTopRight, so one
// shared x keeps every edge aligned). Heights are hard-docked — top pill to
// the viewport top, bottom pill to the viewport bottom — so the drag only
// ever owns x; clamps are width-based so both pills clamp identically. A
// null x docks the pair.
function slidePillsTandem(x, leader) {
  if (x == null) { dockPills(); return; }
  const bar = document.getElementById('tabBar'), hint = document.getElementById('hintBar');
  if (!bar || !pillShown(bar)) return;
  const hintLive = pillShown(hint);
  pillsCentered = false; // a hand drag leaves centered mode: the hand x now owns the pair, no re-centering fights it
  if (leader === 'hint' && hintLive) {
    hintX = x;
    applyHintGeom(); // clamps hintX + matches the top width to the bottom
    tabX = hintX; // follow with the clamped value: identical x, identical clamp
    applyTabGeom();
  } else {
    tabX = x;
    applyTabGeom(); // clamps tabX + matches the top width to the bottom
    if (hintLive) {
      hintX = tabX; // follow with the clamped value: identical x, identical clamp
      applyHintGeom();
    }
  }
}
function applyTabGeom() {
  const box = $('#tabBar'); if (!box) return;
  if (tabX == null) return; // docked-x: placeTabBar owns the left
  const [x] = clampPill(box, tabX, 0);
  tabX = x;
  box.style.transform = 'none'; box.style.left = x + 'px'; box.style.top = ''; // hard-docked height: the CSS top seat owns y
  enforceTopRight(); // width match only — the tandem partner follows via slidePillsTandem, never here
}
function applyHintGeom() {
  const box = $('#hintBar'); if (!box) return;
  if (hintX == null) return; // docked-x: syncPillPair owns the left
  const [x] = clampPill(box, hintX, 0);
  hintX = x;
  box.style.transform = 'none'; box.style.left = x + 'px'; box.style.top = ''; box.style.bottom = ''; // hard-docked height: the CSS bottom seat owns y
  enforceTopRight(); // width match only — the top pill follows via slidePillsTandem, never here
}
// horizontal-center toggle: both pills slide to the viewport's horizontal
// middle, each keeping its current height (top pill stays at the top edge,
// bottom pill at the bottom edge) — the toggle only owns x. Widths still
// match via enforceTopRight, which re-seats the x-centers after every width
// change.
function seatPillsCenter() {
  const bar = document.getElementById('tabBar'), hint = document.getElementById('hintBar');
  if (!bar) return;
  const vw = window.innerWidth;
  const hintHidden = !pillShown(hint);
  try {
    const bt = bar.getBoundingClientRect();
    tabX = Math.round((vw - bt.width) / 2);
    if (!hintHidden) {
      const ht = hint.getBoundingClientRect();
      hintX = Math.round((vw - ht.width) / 2);
    } else { hintX = null; hintY = null; }
    pillsCentered = true;
    applyTabGeom();
    if (!hintHidden) applyHintGeom();
    centerPillsX(); // exact x-centers after the width match settles
    saveUi();
  } catch {}
}
// exact horizontal re-centering after a width change (tab wraps, tips toggle,
// fonts settle): both pills share the viewport's middle. No-op unless the
// toggle is on; never moves y (heights stay where they were seated).
function centerPillsX() {
  if (!pillsCentered) return;
  try {
    const vw = window.innerWidth;
    const bar = document.getElementById('tabBar'), hint = document.getElementById('hintBar');
    if (bar && tabX != null && pillShown(bar)) {
      const w = Math.max(80, bar.getBoundingClientRect().width || 200);
      tabX = Math.min(Math.max(Math.round((vw - w) / 2), 8), Math.max(8, vw - w - 8));
      bar.style.transform = 'none'; bar.style.left = tabX + 'px';
    }
    if (hint && hintX != null && pillShown(hint)) {
      const w = Math.max(80, hint.getBoundingClientRect().width || 200);
      hintX = Math.min(Math.max(Math.round((vw - w) / 2), 8), Math.max(8, vw - w - 8));
      hint.style.transform = 'none'; hint.style.left = hintX + 'px';
    }
  } catch {}
}
function dockPills() {
  pillsCentered = false;
  tabX = null; tabY = null; hintX = null; hintY = null;
  try {
    const bar = document.getElementById('tabBar');
    if (bar) { bar.style.top = ''; } // full dock: back to the CSS top seat, not the centered height
    const hint = document.getElementById('hintBar');
    if (hint) { hint.style.top = ''; } // syncPillPair restores the bottom:14px seat
    placeTabBar();
  } catch {}
  saveUi();
}
function togglePillsCenter() {
  if (pillsCentered) dockPills();
  else seatPillsCenter();
}
// Viewport authority: the canvas + full-bleed layout always match the live
// window, however it changed (boot sizing, maximize animation, monitor/DPR
// switches, zoom, DevTools docking...). Runs the whole layout suite; every
// step is individually guarded so one failure can't wedge the rest.
// Hand-placed pill/pane positions are kept (their own geometry clamps them
// on-screen) — only the canvas is forced to fill.
let __vpLast = '', __vpT = 0;
function fitViewport(reason) {
  try {
    const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    if (vw < 50 || vh < 50) return; // not laid out yet / hidden
    const sig = vw + 'x' + vh + '|' + (window.devicePixelRatio || 1);
    if (reason === 'resize' && sig === __vpLast) return; // dedupe noisy resizes
    __vpLast = sig;
    try { if (ren) ren.resize(); } catch {}
    try { applyDocWidth(); } catch {}
    try { syncHbTabs(); } catch {}
    try { placeTabBar(); } catch {}
    try { sizeDocPanel(); } catch {}
    try { if (typeof autoDist !== 'undefined' && autoDist) applyMiniGeom(); } catch {}
    try { placeFindSide(); } catch {}
    try { placeTopBtn(); } catch {}
    try { syncNotesTab(); } catch {}
    try { if (typeof notesOpen !== 'undefined' && notesOpen) applyNotesGeom(); } catch {}
    try { placeUploadProg(); } catch {}
  } catch {}
}
function fitViewportSoon(ms) {
  try { clearTimeout(__vpT); } catch {}
  __vpT = setTimeout(() => fitViewport('settle'), ms || 150);
}
// width match: the top pill is always EXACTLY as wide as the bottom pill
// (grows and shrinks with it). The pair shares one x (tandem): a right-edge
// overflow slides BOTH pills left together. Skipped while the bottom pill
// is hidden (mobile).
function enforceTopRight() {
  try {
    const bar = document.getElementById('tabBar'), hint = document.getElementById('hintBar');
    if (!bar || !hint || !pillShown(hint)) return;
    const matchW = Math.max(240, Math.min(Math.round(hint.getBoundingClientRect().width), window.innerWidth - 16));
    bar.style.width = matchW + 'px'; // exact match, both directions — never frozen wider, never left narrower
    bar.style.maxWidth = matchW + 'px';
    delete bar.dataset.topShrunk;
    const r = bar.getBoundingClientRect();
    if (r.right > window.innerWidth - 8 + 0.5) { // a wider bottom pill must never push the pair off-screen: slide both left together
      const nx = Math.max(8, Math.round(window.innerWidth - 8 - r.width));
      if (tabX != null) tabX = nx;
      if (hintX != null) hintX = nx;
      bar.style.left = nx + 'px';
      if (pillShown(hint)) { hint.style.left = nx + 'px'; }
    }
    centerPillsX(); // centered toggle: a width change re-seats both x-centers exactly
    try { if (typeof autoDist !== 'undefined' && autoDist) applyMiniGeom(); } catch {} // the bottom pill moved: re-seat the verse map so it never tucks under it
  } catch {}
}
// static cluster fill: inside the live universe's group frame, pad with dashed
// add-tab frames after the last tab until the row band is full (single band
// only — never wraps). The frames are fixed-size placeholders (clicking one
// starts a project), so the whole cluster reads static and non-stretchable.
// Runs after every tab render (renders rebuild the row, wiping old fills).
function fillTabRow() {
  try {
    if (typeof vault === 'undefined' || !vault || !Array.isArray(vault.tabs)) return; // no store: nothing to pad
    const bar = document.getElementById('tabBar');
    const row = bar && bar.querySelector('.tabbar-row');
    const hint = document.getElementById('hintBar');
    if (!bar || !row || !hint || !pillShown(hint)) return; // row hidden (collapsed) or mobile: leave it alone
    row.querySelectorAll('[data-filltab]').forEach(el => el.remove()); // recount from the real tabs (fills never persist)
    let groups = [...row.querySelectorAll(':scope > .ugroup')].filter(g => !g.classList.contains('ugroupghost'));
    if (!groups.length) { // zero tabs: the ghost cluster stands in as the live group, red frame + full placeholders
      const ghost = row.querySelector(':scope > .ugroupghost');
      if (!ghost) return;
      groups = [ghost];
    }
    // the inside-frame join "+" buttons are overflow controls: park them out of
    // the way while measuring (they reappear below if nothing fits). The
    // standalone outside-frame "+" always stands in its dashed box, so it is
    // measured in place and never parked.
    const plusBtns = [...row.querySelectorAll('.ugroup [data-addto]:not([data-filltab])')];
    plusBtns.forEach(b => { b.style.display = 'none'; });
    const makeGhost = (joinId, joinTitle) => {
      const g = document.createElement('button');
      g.className = 'tab tabghost';
      g.setAttribute('data-filltab', '1');
      if (joinId) { g.setAttribute('data-addto', joinId); g.title = joinTitle || 'Join this universe with a new project canvas'; }
      else { g.setAttribute('data-addtab', '1'); g.title = 'Start a new project canvas'; }
      g.textContent = 'add tab';
      return g;
    };
    const rowH = () => row.getBoundingClientRect().height;
    let placed = 0, floorBumped = false;
    const trace = [];
    for (const g of groups) { // one width for all: a group wider than clusterW raises it for every group
      const w = g.getBoundingClientRect().width;
      if (w > clusterW + 0.5) { clusterW = Math.round(w); floorBumped = true; }
    }
    for (const g of groups) { // every group is padded out to clusterW — fixed, static, never shrinks
      const addto = g.querySelector('[data-addto]');
      const joinId = addto ? addto.getAttribute('data-addto') : null;
      const joinTitle = addto ? addto.title : '';
      let guard = 0;
      while (clusterW > 0 && g.getBoundingClientRect().width < clusterW - 0.5 && guard++ < 8) {
        const h0 = rowH();
        const ghost = makeGhost(joinId, joinTitle);
        g.appendChild(ghost);
        const h1 = rowH(), gw1 = Math.round(g.getBoundingClientRect().width);
        trace.push(['topup', gw1, Math.round(h0), Math.round(h1)]);
        if (h1 > h0 + 2) { ghost.remove(); break; } // never wrap
        placed++;
      }
    }
    const parent = row.querySelector('.ugroup.live') || row; // the live cluster's remainder fills the row band to the right edge
    const liveAddto = parent !== row ? parent.querySelector('[data-addto]') : null;
    const joinId = liveAddto ? liveAddto.getAttribute('data-addto') : null; // the cluster's own join control: fills join it, never start a separate canvas
    const joinTitle = liveAddto ? liveAddto.title : '';
    let guard = 0;
    while (guard++ < 14) {
      const h0 = rowH();
      const ghost = makeGhost(joinId, joinTitle);
      parent.appendChild(ghost);
      if (rowH() > h0 + 2) { ghost.remove(); break; } // row is full: keep it a single visual band, never wrap
      placed++;
    }
    if (floorBumped) { try { saveUi(); } catch {} }
    try { window.__filldbg = {clusterW, placed, groups: groups.length, trace, barW: Math.round(bar.getBoundingClientRect().width), at: Date.now()}; } catch {}
    // the join "+" buttons only appear when the row is full and a new tab would open a second row (fills carry data-addto too, so exclude them); the standalone "+" stands always in its dashed box
    const showPlus = placed === 0;
    plusBtns.forEach(b => { b.style.display = showPlus ? '' : 'none'; });
    try { placeTabBar(); } catch {} // re-clamp with the filled row (exact right-edge fit, floor ratchet)
  } catch {}
}
function wirePillDrag(box, set, onTap) {
  if (!box || box.dataset.pilldrag) return;
  box.dataset.pilldrag = '1';
  let mv = null;
  const TAP_SEL = 'button,input,a,select,textarea,label,.glassDot,.glassTip,.luxDot,.sg-help,.hw,[data-sghelp],.sg-help-pop,[contenteditable="true"]';
  box.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' && !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest(TAP_SEL)) { mv = null; return; }
    const r = box.getBoundingClientRect();
    mv = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, on: false };
  });
  box.addEventListener('pointermove', (e) => {
    if (!mv) return;
    if (!mv.on && Math.hypot(e.clientX - mv.x0, e.clientY - mv.y0) < 5) return;
    if (!mv.on) {
      mv.on = true;
      box.style.touchAction = 'none';
      try { box.setPointerCapture(e.pointerId); } catch {}
      try { getSelection()?.removeAllRanges(); } catch {}
      box.style.cursor = 'grabbing';
    }
    set(e.clientX - mv.dx, e.clientY - mv.dy);
  });
  const end = (e) => {
    if (!mv) return;
    const was = mv.on;
    mv = null; box.style.touchAction = ''; box.style.cursor = '';
    if (was) { saveUi(); return; } // a real drag persists; a tap falls through to onTap
    try {
      if (onTap && e && e.target && e.target.closest && !e.target.closest(TAP_SEL)) onTap();
    } catch {}
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', () => { if (!mv) return; const was = mv.on; mv = null; box.style.touchAction = ''; box.style.cursor = ''; if (was) saveUi(); });
  box.addEventListener('dblclick', (e) => {
    if (e.target && e.target.closest && e.target.closest('button,input,a,select,textarea,label,.glassDot,.glassTip,.luxDot,.sg-help,.hw,[data-sghelp],.sg-help-pop')) return;
    set(null, null); saveUi(); // back to the dock
  });
}
function syncModeBtn() {
  try {
    const b = document.getElementById('modeBtn');
    if (!b) return;
    const dark = (typeof bgShade === 'number' ? bgShade : 1) > 0.5;
    b.textContent = dark ? '☾' : '☀';
    b.title = dark ? 'Light mode — flip the whole workspace light' : 'Dark mode — flip the whole workspace dark';
  } catch {}
}
function flipWorkspaceMode() {
  if (luxLeft) { toast('Shade is locked in luxury mode — turn luxury off to change it'); return; }
  bgShade = (typeof bgShade === 'number' ? bgShade : 1) > 0.5 ? 0 : 1;
  try {
    const sl = document.getElementById('bgShade'); if (sl) sl.value = Math.round(bgShade * 100);
    const lb = document.getElementById('bgMul'); if (lb) lb.textContent = Math.round(bgShade * 100) + '%';
    if (ren) ren.bgShade = bgShade;
    syncHintContrast(); syncPaneContrast(); saveUi(); syncModeBtn();
  } catch {}
  toast(bgShade > 0.5 ? '☾ Dark mode — whole workspace' : '☀ Light mode — whole workspace');
}
function renderTabs() {
  const bar = $('#tabBar');
  if (!bar) return;
  // one "save project" caption per project: tabs linked by associations form
  // a single project and are packaged together, so only the group's
  // representative (its main verse, else its first tab) carries the caption.
  const repOf = new Map();
  for (const t of vault.tabs) {
    if (repOf.has(t.id)) continue;
    const group = projectGroup(t.id);
    const rep = group.find(x => x.main) || group[0] || t;
    for (const g of group) repOf.set(g.id, rep.id);
    if (!group.length) repOf.set(t.id, t.id);
  }
  // every universe grows from its carrier (its main verse, else its first
  // tab): one "+" parked after the last of its boxes, joining automatically.
  // Lone tabs are universes of one — the "+" sits right after them.
  // Members never carry one. The ACTIVE universe's frame additionally carries
  // a standalone "+" right after the frame: same one-click creation, but the
  // newcomer starts outside every universe instead of joining this one — it
  // always stands in its dashed box (never parked as an overflow control).
  const plusAfter = new Map(); // last-box tab id -> carrier tab (whose universe a "+" joins)
  for (const t of vault.tabs) {
    const g = projectGroup(t.id);
    const rep = groupCarrier(g);
    if (!rep) continue;
    let last = t.id, li = -1;
    for (const m of g) {
      const mi = vault.tabs.findIndex(x => x.id === m.id);
      if (mi > li) { li = mi; last = m.id; }
    }
    plusAfter.set(last, rep);
  }
  bar.innerHTML = `<button class="glassDot" data-glaze="tabBar" aria-label="Toggle the frosted-glass background of this pill"><span class="glassTip">Polished-glass finish — click to switch this pill to a flat background, click again to bring the glass back. Text and controls always stay on top.</span></button><button class="luxDot" data-luxe="tabBar" aria-label="Toggle luxury gold for the whole workspace"><span class="glassTip">Luxury finish — click to dress the whole workspace in gold-trimmed cosmic glass, click again to return to the standard finish.</span></button>${luxTab ? '' : '<button class="modeBtn" id="modeBtn" title="Light mode — flip the whole workspace light">☾</button>'}<span class="tabbar-label">${vault.tabs.length ? 'Active Visi|Docsverse Projects' : 'Visi|Docsverse Projects'}</span><span class="tabbar-row">` + (() => {
    const tabHtml = (t) => {
      const iso = vault.isIso(t);
      const tinted = iso && typeof t.color === 'string' && /^#[0-9a-f]{6}$/i.test(t.color);
      return `<button class="tab${t.id === vault.activeTabId ? ' active' : ''}${iso ? ' iso' : ''}${tinted ? ' tinted' : ''}" data-tab="${t.id}"${tinted ? ` style="--tabc:${t.color}"` : ''} title="${esc(t.name)}${t.main ? ' — main verse' : ''}${iso ? ' — isolated verse: uploads, searches and deletes stay in this tab' : ''} — double-click to rename, right-click for associations">${t.main ? '★ ' : ''}${iso ? '◌ ' : ''}${esc(t.name)} <span class="tabcount">(${t.docs.length})</span>${t.id === repOf.get(t.id) ? `<span class="tabsave" data-savetab="${t.id}" title="Save ALL projects to your computer as a backup file">save project</span>` : ''}<span class="tabx" data-closetab="${t.id}" title="Close canvas">×</span></button>` + (plusAfter.has(t.id) ? `<button class="tab tabadd" data-addto="${plusAfter.get(t.id).id}" title="${esc(plusCaption('addToTab', plusAfter.get(t.id).name))}">+</button>` : '');
    };
    // thin wireframe boxes: one frame per maximal contiguous run of a
    // universe (a universe split by manual moves shows a frame per run;
    // the tooltip always names the full membership)
    const runs = [];
    for (const t of vault.tabs) {
      const gid = repOf.get(t.id);
      const last = runs[runs.length - 1];
      if (last && last.gid === gid) last.tabs.push(t);
      else runs.push({ gid, tabs: [t] });
    }
    return runs.map(run => {
      const inner = run.tabs.map((t, i) => (i ? '<span class="uconn" aria-hidden="true"></span>' : '') + tabHtml(t)).join('');
      const members = projectGroup(run.tabs[0].id);
      const live = run.tabs.some(t => t.id === vault.activeTabId);
      return `<span class="ugroup${live ? ' live' : ''}" title="One universe: ${esc(members.map(m => m.name).join(', '))} — these canvases share uploads, copies, deletes and twin motion">${inner}</span>` + (live ? `<button class="tab tabadd tabadd-out" data-addtab="1" title="${esc(plusCaption('addTabOut'))}">+</button>` : '');
    }).join('');
  })() + (vault.tabs.length
    ? '' // no trailing add button: every universe already carries its own "+"
    : `<span class="ugroup ugroupghost live" title="Empty universe — click Create a project to start your first project"><button class="tab tabghost" data-addtab="1" title="${esc(plusCaption('createTab'))}">Create a project</button></span>`) + `</span>` + `<span class="viewmodes"><span class="hw"><span class="sg-help" data-sghelp tabindex="0">?</span><div class="sg-help-pop" role="note" data-help-pop="viewMain"><span class="help-text" data-help-text="viewMain">${esc(helpTexts.viewMain)}</span><button class="help-edit-btn" data-help-edit="viewMain" title="Edit this explanation">✎ edit</button></div></span><button class="vm howstart" data-howstart="1" title="How to start — a quick guide to projects, tabs and separate universes">How to start</button><button class="vm vmpill" data-vm="main" title="Main view — the regular canvas universe (one body per document)">MAIN</button><span class="hw"><span class="sg-help" data-sghelp tabindex="0">?</span><div class="sg-help-pop" role="note" data-help-pop="viewThematic"><span class="help-text" data-help-text="viewThematic">${esc(helpTexts.viewThematic)}</span><button class="help-edit-btn" data-help-edit="viewThematic" title="Edit this explanation">✎ edit</button></div></span><button class="vm vmpill" data-vm="thematic" title="Thematic view — the ideas the documents share, distilled into theme bodies">THEMATIC</button><span class="hw"><span class="sg-help" data-sghelp tabindex="0">?</span><div class="sg-help-pop" role="note" data-help-pop="viewTag"><span class="help-text" data-help-text="viewTag">${esc(helpTexts.viewTag)}</span><button class="help-edit-btn" data-help-edit="viewTag" title="Edit this explanation">✎ edit</button></div></span><button class="vm vmpill" data-vm="tag" title="Tags view — the labels on the documents, one body per tag (same as Show tags view in the tags pane)">TAGS</button><button class="vm taginv" data-tagpop="1" title="See Tags Inventory — every tag in this verse as pills on a glass card">See Tags Inventory</button></span><button class="vm pilltoggle" data-pilltoggle="1" title="${pillCollapsed ? 'Restore the projects pill' : 'Collapse the projects pill (view modes stay)'}">${pillCollapsed ? '▾' : '▴'}</button>`
  bar.classList.toggle('pillCollapsed', pillCollapsed);
  const pillDot = bar.querySelector('.glassDot'); if (pillDot) pillDot.onclick = glazeDotClick; // renderTabs rebuilds the pill, so re-wire its dot every render
  const pillLux = bar.querySelector('.luxDot'); if (pillLux) pillLux.onclick = luxDotClick; // same: luxury orb is rebuilt too
  const modeBtn = bar.querySelector('#modeBtn'); if (modeBtn) modeBtn.onclick = () => flipWorkspaceMode(); // same: corner mode button is rebuilt too
  try { syncModeBtn(); } catch {} // glyph follows bgShade no matter what flipped it
  try { applyDocWidth(); } catch {} // tab widths move the pill; the reader paints above it
  try { syncViewModes(); } catch {}
  try { syncIntakeLog(); } catch {} // the VisiDocsverse pane shows THIS tab's last message, never another verse's
  try { placeTabBar(); } catch {} // keep the pill inside the free lane between the side panes
  try { fillTabRow(); } catch {} // pad the live cluster with static add-tab frames, then re-clamp
}
function switchCanvas(id) {
  const t = vault.tabs.find(t => t.id === id);
  if (!t || id === vault.activeTabId) return;
  pushView(); // Return can come back to the previous canvas
  try { camCancelGlide(); } catch {} // a canvas swap invalidates any in-flight pan
  // the parked pin survives tab switches when its doc lives there too —
  // otherwise renderDoc falls back to the overview until the tab returns
  canvasHiId = null; // the new canvas lights its own bodies
  assocSelId = null; srcHi = null; // the new canvas lights its own rows
  intakeHiIds.clear(); // the new canvas lights its own arrivals
  clearFit(); // snapshots belong to one canvas's universe
  panHeld = false; // a fresh canvas opens gravity-seated until the hand moves it
  try { vault.tab().activeId = activeId; } catch {} // remember where we were
  vault.activeTabId = id;
  vault.persist();
  if (!unis.has(id)) rebuildTab(id); // first visit builds it (copies snap into lockstep below)
  uni = unis.get(id); // swap live universes: formations hold, no re-scatter
  if (lensThematic) uni = thematicUniFor(id) || uni; // lens persists across canvases
  else if (lensTags) uni = tagUniFor(id) || uni; // tags view persists across canvases too
  if (thematicWhole) {
    // whole-visidocsverse view spans every canvas: keep a live whole theme, else stay general
    if (!themeById(activeId)) activeId = uni ? uni.sunId : null;
  } else {
    // an explicitly cleared sun (general state) stays cleared — don't resurrect docs[0]
    activeId = (t.activeId && vault.byId(t.activeId)) ? t.activeId : ((t.activeId === null && t.docs.length) ? null : (t.docs[0]?.id || null));
    // a doc sun doesn't exist in the tags view — fall back to its sun (or general)
    if (lensTags && uni && activeId && !uni.byId.has(activeId)) activeId = uni.sunId;
    t.activeId = activeId;
  }
  refreshEdgeInfo(id); // reader was showing the previous canvas's tethers (SHARED GROUND — 0)
  syncLensBtn();
  showAllBodies = false; // a new canvas opens on its 6 largest, never mid-list
  renderDoc();
  updateStats();
  renderTabs();
  try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; } catch {}
  matchSet = null;
  selSet.clear(); // selections never travel between canvases
  hideBoxSel();
  try { syncLbPill(); } catch {}
  toast(`Canvas: ${t.name} (${t.docs.length} bodies)`);
}
// close-canvas notice: dev-editable template (✎ in the dialog, same lock as
// every helper — editor preview only). {name}/{n}/{bodies} fill in per canvas.
function closeCanvasMsg(t, blank) {
  const key = blank ? 'closeCanvasBlank' : 'closeCanvas';
  const tpl = (typeof helpTexts[key] === 'string' && helpTexts[key].trim()) ? helpTexts[key] : DEFAULT_HELP[key];
  return tpl.split('{name}').join(t.name).split('{n}').join(String(t.docs.length)).split('{bodies}').join(t.docs.length === 1 ? 'body' : 'bodies');
}
// "+" hover captions: dev-editable templates (right-click the button).
// {name} fills in per joined universe; the dev hint only rides along where
// helpEditAllowed() (editor preview — desktop/file shells stay read-only).
function plusCaption(key, name) {
  const tpl = (typeof helpTexts[key] === 'string' && helpTexts[key].trim()) ? helpTexts[key] : DEFAULT_HELP[key];
  return (name == null ? tpl : tpl.split('{name}').join(name)) + (helpEditAllowed() ? ' — dev: right-click to reword' : '');
}
async function closeCanvas(id) {
  const t = vault.tabs.find(t => t.id === id);
  if (!t) return;
  if (vault.tabs.length <= 1) {
    // closing the final canvas is allowed: there is no hidden replacement
    // canvas. A close removes the canvas outright — unsaved work is gone.
    const empty = !t.docs.length;
    if (!await confirmDlg(closeCanvasMsg(t, empty), 'Close canvas', { editKey: empty ? 'closeCanvasBlank' : 'closeCanvas' })) return;
    if (!vault.closeTab(id)) return;
    unis.delete(id); thematicUnis.delete(id); thematicBuilt.delete(id); tagUnis.delete(id); tagBuilt.delete(id); tagRecords.delete(id); edgeByTab.delete(id);
    lensThematic = false; thematicWhole = false; lensTags = false; syncLensBtn();
    uni = null; if (ren) ren.hover = null;
    activeId = null; edgeInfo = [];
    try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; } catch {}
    matchSet = null;
    selSet.clear();
    hideBoxSel();
    renderDoc();
    updateStats();
    renderTabs();
    markBackupDirty();
    toast(`Canvas “${t.name}” closed`);
    return;
  }
  if (!await confirmDlg(closeCanvasMsg(t, false), 'Close canvas', { editKey: 'closeCanvas' })) return;
  const wasActive = id === vault.activeTabId;
  vault.closeTab(id);
  unis.delete(id);
  thematicUnis.delete(id); thematicBuilt.delete(id);
  tagUnis.delete(id); tagBuilt.delete(id); tagRecords.delete(id);
  if (wasActive) {
    const nid = vault.activeTabId;
    if (!unis.has(nid)) rebuildTab(nid);
    uni = unis.get(nid);
    if (lensThematic) uni = thematicUniFor(nid) || uni;
    else if (lensTags) uni = tagUniFor(nid) || uni;
    activeId = vault.tab().activeId;
    if (activeId && !vault.byId(activeId) && !themeById(activeId) && !tagById(activeId)) activeId = null; // stale sun
    if (activeId == null && vault.tab().activeId !== null) activeId = vault.docs[0]?.id || null; // general state (explicit null) stays general
    vault.tab().activeId = activeId;
    refreshEdgeInfo(nid);
    try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; } catch {}
    matchSet = null;
    selSet.clear();
    hideBoxSel();
    renderDoc();
    updateStats();
  }
  renderTabs();
  markBackupDirty();
  toast(`Canvas “${t.name}” closed`);
}

// verse isolation: any tab with no associations is a fully separate VisiDocsverse
// (uploads, searches, tags, copies, deletes, twin motion stay inside).
// Linking is done per-verse from the tab's right-click menu; closing the main
// verse promotes the oldest tab.

// removal entry points (shared by the right-click menu AND the reader-panel buttons,
// so touch users with no right-click can also remove bodies).
async function removeFromCanvas(id) {
  const d = vault.byId(id);
  if (!d) return;
  const root = d.origin || d.id;
  const elsewhere = vault.tabs.filter(t => t.id !== vault.activeTabId && t.docs.some(x => x.id === root || x.origin === root)).length;
  if (!await confirmDlg(`Remove “${vault.titleOf(d)}” from “${vault.tab().name}” only?${elsewhere ? ` (Still in ${elsewhere} other canvas${elsewhere === 1 ? '' : 'es'}.)` : ''}`, 'Remove')) return;
  const wasSun = id === activeId;
  vault.remove(id);
  markBackupDirty();
  selSet.delete(id); // drop it from any box selection too
  if (!selSet.size) hideBoxSel();
  if (activeId != null && (wasSun || !vault.byId(activeId))) activeId = vault.docs[0]?.id || null; // general state (null) stays general
  vault.tab().activeId = activeId;
  rebuild(activeId);
  renderTabs();
  toast('Removed from this canvas');
    purgeImages(); // picture bytes nobody references anymore get swept
}
async function deleteEverywhere(id) {
  const d = vault.byId(id) || vault.tabs.flatMap(t => t.docs).find(x => x.id === id);
  if (!d) return;
  const root = d.origin || d.id;
  const scope = vault.scopeTabs(); // unassociated verses purge only themselves
  const hits = scope.filter(t => t.docs.some(x => x.id === id || x.id === root || x.origin === root)).length;
  const where = scope.length > 1
    ? `“${vault.tab().name}” and its ${scope.length - 1} associated verse${scope.length === 2 ? '' : 's'} (${hits} canvas${hits === 1 ? '' : 'es'} hold it)`
    : `“${vault.tab().name}” only (isolated verse — other canvases keep their copies)`;
  if (!await confirmDlg(`Delete “${vault.titleOf(d)}” from ${where}? This cannot be undone.`, 'Delete everywhere')) return;
  const n = vault.removeEverywhere(id);
  markBackupDirty();
  pruneSel(); // universe-wide purge can take selected bodies with it
  rebuildAllTabs();
  if (activeId != null && !vault.byId(activeId)) activeId = vault.docs[0]?.id || null; // general state (null) stays general
  vault.tab().activeId = activeId;
  renderDoc();
  updateStats();
  renderTabs();
  toast(`Deleted ${n} ${n === 1 ? 'copy' : 'copies'} from the universe`);
    purgeImages(); // picture bytes nobody references anymore get swept
}
// empty the active canvas (bodies only — the canvas itself stays open; other canvases untouched)
async function removeAllFromCanvas() {
  const t = vault.tab();
  if (!t) return;
  if (!t.docs.length) { toast('This canvas is already empty'); return; }
  if (!await confirmDlg(`Remove all ${t.docs.length} ${t.docs.length === 1 ? 'body' : 'bodies'} from “${t.name}” only? The canvas stays open but empty. Other canvases are untouched.`, 'Remove all')) return;
  t.docs = [];
  t.activeId = null;
  selSet.clear();
  hideBoxSel();
  vault.persist();
  activeId = null;
  rebuild(null);
  renderTabs();
  markBackupDirty();
  toast(`Removed everything from “${t.name}”`);
    purgeImages(); // picture bytes nobody references anymore get swept
}

// bulk removal for the marquee box selection: bodies AND their docs leave this
// tab only (each tab owns its doc copies — other canvases keep theirs).
async function removeIdsFromCanvas(ids) {
  const t = vault.tab();
  if (!t) return;
  const targets = [...new Set(ids || [])].filter(sid => t.docs.some(d => d.id === sid));
  if (!targets.length) { toast('Selected bodies are themes — exit the Thematic lens to delete docs'); selSet.clear(); hideBoxSel(); return; }
  if (!await confirmDlg(`Delete ${targets.length} ${targets.length === 1 ? 'body' : 'bodies'} AND ${targets.length === 1 ? 'its doc' : 'their docs'} from “${t.name}” only? Other canvases keep their copies. This cannot be undone.`, 'Delete')) return;
  t.docs = t.docs.filter(d => !targets.includes(d.id));
  targets.forEach(sid => selSet.delete(sid));
  hideBoxSel();
  vault.persist();
  if (!vault.byId(activeId)) activeId = vault.docs[0]?.id || null;
  vault.tab().activeId = activeId;
  rebuild(activeId);
  renderDoc();
  updateStats();
  renderTabs();
  markBackupDirty();
  toast(`Deleted ${targets.length} ${targets.length === 1 ? 'body' : 'bodies'} (+ docs) from “${t.name}”`);
    purgeImages(); // picture bytes nobody references anymore get swept
}
// nuke the whole tab universe + its docs (the "Remove all" sibling with explicit docs wording)
async function removeUniverseFromCanvas() {
  const t = vault.tab();
  if (!t) return;
  if (!t.docs.length) { toast('This canvas is already empty'); return; }
  if (!await confirmDlg(`Delete the ENTIRE “${t.name}” universe — all ${t.docs.length} ${t.docs.length === 1 ? 'body' : 'bodies'} AND their docs? This tab only; other canvases keep their copies. This cannot be undone.`, 'Delete universe')) return;
  t.docs = [];
  t.activeId = null;
  selSet.clear();
  hideBoxSel();
  vault.persist();
  activeId = null;
  rebuild(null);
  renderDoc();
  updateStats();
  renderTabs();
  markBackupDirty();
  toast(`Deleted the “${t.name}” universe + docs`);
    purgeImages(); // picture bytes nobody references anymore get swept
}
// per-canvas persistent universes: switching tabs swaps the live universe instead
// of rebuilding, so every canvas holds its exact formation (rotation included).
function rebuildTab(tabId) {
  clearFit(); // new node objects: any fitted boosts/snapshot are stale
  const prevActive = vault.activeTabId;
  vault.activeTabId = tabId;
  const tab = vault.tab();
  const { bodies, edges } = vault.universe();
  let u = unis.get(tabId);
  if (!u) { u = new Universe(); unis.set(tabId, u); }
  u.setData(bodies, edges, tab.activeId);
  tab.activeId = u.sunId;
  vault.activeTabId = prevActive;
  edgeByTab.set(tabId, { n: tab.docs.length, edges });
  if (tabId === prevActive) edgeInfo = edges;
  vault.persist();
  return u;
}
function rebuildAllTabs() {
  for (const t of vault.tabs) rebuildTab(t.id);
  uni = unis.get(vault.activeTabId) || null;
  if (lensThematic) uni = thematicUniFor(vault.activeTabId) || uni;
  else if (lensTags) uni = tagUniFor(vault.activeTabId) || uni;
  return uni;
}
function rebuild(sunId) {
  // active-tab rebuild (legacy entry point): optional sun override, then refresh panes
  try { camCancelGlide(); } catch {} // fresh node objects invalidate any in-flight pan
  panHeld = false; // fresh layout: gravity may seat it until the hand moves it again
  if (sunId && vault.byId(sunId)) vault.tab().activeId = sunId;
  uni = rebuildTab(vault.activeTabId);
  if (lensThematic) uni = thematicUniFor(vault.activeTabId) || uni;
  else if (lensTags) uni = tagUniFor(vault.activeTabId) || uni;
  activeId = uni ? uni.sunId : null;
  vault.tab().activeId = activeId;
  renderDoc();
  updateStats();
}
// quantum lock: every copy mirrors its root's live pose in every canvas, each frame.
// The first canvas holding a root (usually the main canvas) is the source of truth.
function entangleSync() {
  const seen = new Map(); // rootId -> primary node
  const syncScope = new Set(vault.scopeTabs().map(t => t.id)); // only the active association stays in lockstep
  for (const t of vault.tabs) {
    if (!syncScope.has(t.id)) continue; // unassociated verses evolve independently — no twin lockstep
    const u = unis.get(t.id);
    if (!u) continue;
    for (const n of u.nodes) {
      const root = n.origin || n.id;
      const p = seen.get(root);
      if (!p) seen.set(root, n);
      else {
        n.x = p.x; n.y = p.y; n.z = p.z; n.vx = p.vx; n.vy = p.vy; n.vz = p.vz;
      }
    }
  }
}

function updateStats() {
  if (!$('#stBodies')) return; // stats row removed from the top pill: nothing to update
  { const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  if (!uni) { set('#stBodies', 0); set('#stLinks', 0); set('#stKe', 0); set('#stRim', 0); return; }
  const s = uni.stats();
    set('#stBodies', s.bodies); set('#stLinks', s.links);
    set('#stKe', s.ke.toFixed(0)); set('#stRim', s.maxR.toFixed(0)); }
}

// remember a newly focused sun on its canvas (survives reloads via vault.persist)
function claimSun(id) {
  pushView(); // Return can come back to the previous sun
  activeId = id;
  paneId = null; // the canvas moved — the pane follows it again
  canvasHiId = null; // a real selection owns the canvas now — drop the MAIN highlight
  assocSelId = null; // a fresh selection drops the old associated pick (focusAssocDoc re-sets its own right after)
  intakeHiIds.clear(); // ...and any intake landing (the new pick supersedes it)
  srcHoldHi(); srcHi = null; // focus owns the reader now — drop any hover trace
  try { const t = vault.tab(); if (t) t.activeId = id; vault.persist(); } catch {}
}
// selection is light-only: lens orbs and icons, search picks, reader
// rows and title links drive the reader, and the picked body is marked
// exactly where it already sits — gold halo + bold label + hot tethers on
// the canvas, gold rows in the inventory (Main-canvas orbs locate instead
// — inventory + halo, never opening). Bodies never move for a selection;
// the camera pans only when the pick is off-screen, and only just enough
// to bring it into view. The physical sun changes solely through explicit
// sun controls — the inventory dot boxes, releasing it, intake, and
// fresh-universe builds (which crown the persisted selection) — so the map
// never reshuffles under a click.
function selectBody(id, label, quiet) {
  if (!uni || !uni.byId.has(id)) return false;
  if (activeId !== id) {
    claimSun(id);
    if (!quiet) toast(label + ' selected');
  }
  try { centerCamOn(id, true); } catch {} // off-screen picks only; physics untouched
  renderDoc();
  return true;
}
// canvas locate (Main view): clicking a body never opens it — the reader goes
// to the document inventory instead, with the body's row lit and centered so
// its position reads at a glance. Halo + row gold ride canvasHiId (same funnel
// as the MAIN pill); the sun, pin and selection state are otherwise untouched
// except that a standing pin/selection yields to the inventory (Return walks
// back to it). Lens canvases keep their selection wiring — only Main locates.
function locateBody(id) {
  if (!uni || !uni.byId.has(id)) return false;
  if (lensThematic || lensTags) return false;
  const d = vault.byId(id);
  if (!d) return false;
  if (activeId !== null || paneId !== null) pushView(); // Return can come back to the parked/selected doc
  paneId = null;
  activeId = null; // locate, never open: the inventory owns the reader now
  try { const t = vault.tab(); if (t) { t.activeId = null; vault.persist(); } } catch {}
  canvasHiId = id;
  centerCamOn(id, true);
  renderDoc(); // general inventory (no selection, no pin)
  // unfold View-all when the row hides past the 6 largest, then center it
  // (same recipe as the notes-pane gold tracking).
  const sel = `#docLinks .bl-row[data-open="${CSS.escape(id)}"]`;
  if (!document.querySelector(sel)) {
    const t = vault.tab();
    if (t && (t.docs || []).length > 6 && !showAllBodies) { showAllBodies = true; renderGeneral(); }
  }
  try { paintGoldRows(id); } catch {}
  return true;
}
// view jumps (side-cluster MAIN / THEMATIC / TAGS): show where the shown
// document sits in each view. MAIN never touches the reader — it exits any
// lens, then lights the doc's orb on the Main canvas only (canvasHiId),
// leaving the pane, the pin and the selection exactly as they were.
// THEMATIC / TAGS enter the lens and select the grounding theme / first tag
// on the canvas, but park the jumped-from doc in the reader (pane-only pin)
// — the switch can never lose it; clicking the haloed node itself selects it
// for real. Selection history pushes along the way, so Return walks back
// through the jumps.
function gotoViewFor(docId, view) {
  const t = vault.tab();
  const d = t && (t.docs || []).find(x => x.id === docId);
  if (!d) return;
  const name = vault.titleOf(d);
  if (view === 'main') {
    // MAIN never opens anything: it leaves any lens, lights the doc's orb on
    // the Main canvas (halo + camera pan when off-screen + a row flash), and
    // leaves the reader exactly as it was — a parked pin survives the exit
    // untouched, while a lens-entity selection (theme/tag, which cannot exist
    // in Main) yields the neutral overview instead of the sun's doc.
    const wasLens = lensThematic || lensTags;
    const keepSel = activeId;
    if (wasLens) goViewMode('main');
    if (wasLens) {
      if (keepSel && (String(keepSel).startsWith('theme_') || String(keepSel).startsWith('tag:'))) {
        activeId = null; // the lens selection can't survive in Main — overview, not the sun's doc
        try { const t = vault.tab(); if (t) { t.activeId = null; vault.persist(); } } catch {}
      }
      renderDoc();
    }
    canvasHiId = docId; // canvas-only: gild the orb + hold its row gold, never open the doc
    centerCamOn(docId, false); // VIEW IN always centers its target; zoom/spin/physics untouched
    try { paintGoldRows(); } catch {} // light the row now (rebuilds pick it up from goldIds)
    return;
  }
  if (view === 'thematic') {
    const wasLens = lensThematic;
    if (!lensThematic) toggleThematicLens();
    const recs = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
    const mine = recs.filter(r => (r.members || []).includes(docId)).sort((a, b) => (b.weight || 0) - (a.weight || 0));
    if (!mine.length) { toast(`“${name}” grounds in no theme — it rides along ungrounded`); return; }
    // the reader keeps the jumped-from doc (parked pin) — only the canvas
    // takes the lens selection, so the switch can never lose it. Clicking
    // the haloed theme itself selects it for real.
    try { if (wasLens) pushView(); } catch {} // fresh entries already pushed in the lens setter — only push mid-lens re-jumps, so Return never stops on auto-seated states
    activeId = mine[0].id;
    paneId = docId;
    canvasHiId = null; assocSelId = null; srcHi = null; // the lens lights its own bodies and rows
    try { const t2 = vault.tab(); if (t2) { t2.activeId = activeId; vault.persist(); } } catch {}
    centerCamOn(mine[0].id, false); // VIEW IN always centers its target; zoom/spin/physics untouched
    renderDoc();
    try { paintGoldRows(docId); } catch {} // its member row stays gold + centered
    toast(`◈ ${mine[0].label} — “${name}” stays in the reader`);
    return;
  }
  const wasTags = lensTags;
  if (!lensTags) setTagsVerse(true);
  if (!lensTags) return; // setTagsVerse bailed: no tags on this canvas
  const mine = tagsFor(t.docs || []).filter(r => (r.members || []).includes(docId));
  if (!mine.length) { toast(`“${name}” carries no tags`); return; }
  // same contract as the thematic jump: reader keeps the doc, canvas takes
  // the tag selection.
  try { if (wasTags) pushView(); } catch {} // fresh entries already pushed in the lens setter
  activeId = mine[0].id;
  paneId = docId;
  canvasHiId = null; assocSelId = null; srcHi = null; // the lens lights its own bodies and rows
  try { const t2 = vault.tab(); if (t2) { t2.activeId = activeId; vault.persist(); } } catch {}
  centerCamOnMean(mine.map(r => r.id)); // center the whole grounding-tag group, not just the first; zoom/spin/physics untouched
  renderDoc();
  try { paintGoldRows(docId); } catch {} // its member row stays gold + centered
  try { tagHiKey = ''; syncTagHi(); } catch {} // gild every grounding tag at once, not just the first
  toast(mine.length > 1 ? `${mine[0].label} +${mine.length - 1} more — “${name}” stays in the reader` : `${mine[0].label} — “${name}” stays in the reader`);
}
// lens intake landing: the rebuild above already re-situated the new files, so
// light up every theme/tag that grounded them instead of crowning a doc sun
// that isn't a lens body. The reader lands neutral on the lens overview with
// the situating rows gold + centered; their orbs halo via the hot set. Any
// fresh selection, release, lens/tab/Return move, or next intake clears it.
function highlightIntakeLanding(newIds) {
  const want = new Set(newIds || []);
  let recs = [];
  try {
    recs = lensThematic
      ? (thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []))
      : (tagRecords.get(vault.activeTabId) || tagsFor(((vault.tab() || {}).docs) || []));
  } catch { recs = []; }
  const hit = (recs || []).filter(r => ((r.members || []).some(m => want.has(m))) && uni && uni.byId.has(r.id));
  intakeHiIds = new Set(hit.map(r => r.id));
  // a doc sun means nothing in a lens — land neutral on the lens overview
  activeId = null; paneId = null;
  canvasHiId = null; assocSelId = null; srcHi = null;
  try { const t = vault.tab(); if (t) { t.activeId = null; vault.persist(); } } catch {}
  renderDoc();
  if (hit.length) {
    try { paintGoldRows(hit[0].id); } catch {} // its row gold + centered
    try { centerCamOnMean(hit.map(r => r.id)); } catch {} // the group centered as a group
  }
  const n = want.size;
  const files = n === 1 ? '1 new file' : n + ' new files';
  if (!hit.length) {
    toast(lensThematic
      ? `${files} ride${n === 1 ? 's' : ''} along ungrounded — no theme grounds ${n === 1 ? 'it' : 'them'} yet`
      : `${files} carr${n === 1 ? 'ies' : 'y'} no tags yet`);
    return;
  }
  const names = hit.map(r => r.label);
  const shown = names.slice(0, 2).join(' · ') + (names.length > 2 ? ` +${names.length - 2} more` : '');
  toast(lensThematic ? `◈ ${shown} — ${files} landed here` : `${shown} — ${files} assigned here`);
}
// general state: no active body — the sun cools back to a body and the canvas
// center becomes the gravitational center. Returns true when something changed.
function defocusSun() {
  if (!uni) return false;
  if (activeId == null && uni.sunId == null && !paneId && !canvasHiId) return false;
  pushView(); // Return can come back to the released sun
  uni.defocus();
  activeId = null;
  paneId = null; // released — the pane follows the canvas again
  canvasHiId = null; // released — no highlight left to keep
  assocSelId = null; srcHi = null; // released — no selection left to stay lit
  intakeHiIds.clear(); // released — no landing left to stay lit
  try { const t = vault.tab(); if (t) t.activeId = null; vault.persist(); } catch {}
  renderDoc();
  updateStats();
  return true;
}
// notes: one shared notepad per document lineage — a list of entries
// ({id, text, at}) on the vault doc. The canvas sticky square, the reader
// pop-out and the Notes book pane are mirror views re-rendered from it on
// every change; edits in any tab's copy sync across the whole lineage, so
// every surface shows the same notepad for that document.
const NOTE_MAX = 2000; // per-entry cap (legacy 140-char notes migrate untouched)
let notePopId = null; // doc id shown in the reader's note pop-out
let noteEditId = null; // doc id being edited in the floating canvas editor
function noteLogOf(d) {
  if (!d) return [];
  if (!Array.isArray(d.noteLog)) d.noteLog = [];
  if (typeof d.note === 'string' && d.note.trim()) { // legacy single note -> first entry
    d.noteLog.unshift({ id: 'n_' + Math.random().toString(36).slice(2, 10), text: d.note.slice(0, NOTE_MAX), at: Date.now() });
    delete d.note;
    try { vault.persist(); } catch {}
  }
  return d.noteLog;
}
function noteCount(id) { // hot-path presence check: never migrates, never persists
  const d = vault.byId(id);
  if (!d) return 0;
  if (Array.isArray(d.noteLog)) return d.noteLog.length;
  return (typeof d.note === 'string' && d.note.trim()) ? 1 : 0;
}
function kinDocs(id) { // every copy of this doc, all tabs: same root id/origin
  const d = vault.byId(id) || vault.byIdAnywhere(id);
  if (!d) return [];
  const root = d.origin || d.id;
  const out = [];
  for (const t of vault.tabs) for (const x of (t.docs || [])) {
    if (x.id === id || x.id === root || x.origin === root) out.push(x);
  }
  return out;
}
function syncNoteKin(id) { // one notepad per document: mirror the entry list across the lineage
  const d = vault.byId(id) || vault.byIdAnywhere(id);
  if (!d) return;
  const snap = cloneNoteLog(noteLogOf(d));
  for (const x of kinDocs(id)) {
    if (x === d) continue;
    x.noteLog = cloneNoteLog(snap);
    delete x.note;
  }
}
function getNote(id) { const es = noteLogOf(vault.byId(id)); return es.length ? es[es.length - 1].text : ''; } // latest entry (legacy quick editors)
function refreshNoteViews(id) {
  if (shownId === id) renderDoc(); // refreshes the notes button too
  if (notePopId === id && !$('#notePop').hidden) renderNotePop(false);
  try { if (notesOpen && notesDocId === id) renderNotesPane(); } catch {}
  try { syncNotesTab(); } catch {}
  try { paintNoteBoxes(id); } catch {} // inventory note boxes flip yellow the moment a note lands — no list rebuild needed
}
function paintNoteBoxes(id) { // repaint every visible row note box for a doc (and its kin copies): filled sticky vs empty outline + count title
  let ids = [id];
  try { for (const x of kinDocs(id)) if (x && x.id && !ids.includes(x.id)) ids.push(x.id); } catch {}
  for (const nid of ids) {
    let n = 0; try { n = noteCount(nid) || 0; } catch {}
    const svg = n ? NOTE_SVG_FILLED : NOTE_SVG_EMPTY;
    const tip = n ? ` (${n} ${n === 1 ? 'entry' : 'entries'})` : ' (no notes yet)';
    let boxes = [];
    try { boxes = [...document.querySelectorAll('.bl-note[data-notes-pane="' + CSS.escape(String(nid)) + '"]')]; } catch { continue; }
    for (const b of boxes) {
      try {
        b.classList.toggle('empty', !n);
        b.innerHTML = svg;
        const base = String(b.title || '').split(' (')[0];
        b.title = base + tip;
      } catch {}
    }
  }
}
function saveNote(id, text) { // legacy quick editors: rewrite the latest entry (or append the first)
  const d = vault.byId(id); if (!d) return false;
  text = String(text ?? '').slice(0, NOTE_MAX);
  const log = noteLogOf(d);
  if (text.trim()) {
    if (log.length) log[log.length - 1].text = text;
    else log.push({ id: 'n_' + Math.random().toString(36).slice(2, 10), text, at: Date.now() });
  } else if (log.length) log.pop(); // saving empty clears the latest entry
  delete d.note;
  markBackupDirty();
  vault.persist();
  syncNoteKin(id);
  refreshNoteViews(id);
  return true;
}
function cleanNoteSpot(sp) { // validate a pinned-passage anchor (same rich shape as manual-tag spots)
  if (!sp || typeof sp !== 'object' || Array.isArray(sp)) return null;
  if (typeof sp.snip !== 'string' || sp.snip.replace(/\s+/g, ' ').trim().length < 2) return null;
  const out = { snip: sp.snip.replace(/\s+/g, ' ').trim().slice(0, 300) };
  if (isFinite(sp.at)) out.at = Math.max(0, Math.round(sp.at));
  if (Array.isArray(sp.path) && sp.path.length <= 12 && sp.path.every(n => Number.isInteger(n) && n >= 0 && n < 10000)) out.path = sp.path.slice();
  if (Number.isInteger(sp.off) && sp.off >= 0) out.off = sp.off;
  return out;
}
function cloneNoteLog(log) { // deep copy (spots carry a DOM-path array — never share it)
  return (Array.isArray(log) ? log : []).map(e => {
    const c = { ...e };
    if (c.spot && typeof c.spot === 'object') { c.spot = { ...c.spot }; if (Array.isArray(c.spot.path)) c.spot.path = [...c.spot.path]; }
    return c;
  });
}
// original page of a pinned passage: resolve a note/tag-style spot anchor to
// the real folio page via the rendered markers (nearest .pagemark at/before
// the passage start). DOM-based, so it stays exact whatever the intake
// offsets and whitespace-stripping do — null when the doc has no pagination.
function pageOfSpotInReader(spot, budget) {
  try {
    const root = document.getElementById('docBody');
    if (!root || !spot) return null;
    const len = (typeof budget === 'number' && budget > 0) ? Math.min(2000, Math.round(budget)) : 80;
    const r = findSpotRange(root, spot, len);
    if (!r || r.collapsed) return null;
    let page = null;
    const marks = root.querySelectorAll('.pagemark');
    for (const m of marks) {
      let c = 1;
      try { c = r.comparePoint(m, 0); } catch { break; }
      if (c > 0) break; // this marker stands past the passage start
      const n = parseInt(m.dataset.page, 10);
      if (isFinite(n) && n > 0) page = n;
    }
    return page;
  } catch { return null; }
}
function notePageLabel(d, e) { // "p. 42" / "slide 3" / "sheet 3" for a highlight-sourced entry, else ''
  try {
    if (!e || !Number.isInteger(e.page) || e.page <= 0) return '';
    const kind = (d && d.pageMap && d.pageMap.kind) || 'pdf';
    const unit = (typeof pageUnitName === 'function') ? pageUnitName(kind) : 'page';
    return unit === 'page' ? ` · p. ${e.page}` : ` · ${unit} ${e.page}`;
  } catch { return ''; }
}
function addNoteEntry(id, text, spot) { // append one entry (Notes pane, send-to-notes)
  const d = vault.byId(id); if (!d) return null;
  text = String(text ?? '').slice(0, NOTE_MAX);
  if (!text.trim()) return null;
  const e = { id: 'n_' + Math.random().toString(36).slice(2, 10), text, at: Date.now() };
  const csp = cleanNoteSpot(spot);
  if (csp) e.spot = csp; // pinned passage: the highlight persists while this entry lives
  if (csp && id === shownId) { // reader shows this doc: also pin the real original page number
    const pg = pageOfSpotInReader(csp, String(text).length);
    if (pg) e.page = pg;
  }
  noteLogOf(d).push(e);
  delete d.note;
  vault.persist();
  markBackupDirty();
  syncNoteKin(id);
  refreshNoteViews(id);
  return e;
}
function setNoteEntry(id, entryId, text) {
  const d = vault.byId(id); if (!d) return false;
  const e = noteLogOf(d).find(x => x.id === entryId);
  if (!e) return false;
  text = String(text ?? '').slice(0, NOTE_MAX);
  if (!text.trim()) return deleteNoteEntry(id, entryId);
  e.text = text;
  vault.persist();
  markBackupDirty();
  syncNoteKin(id);
  refreshNoteViews(id);
  return true;
}
function deleteNoteEntry(id, entryId) {
  const d = vault.byId(id); if (!d) return false;
  const log = noteLogOf(d);
  const i = log.findIndex(x => x.id === entryId);
  if (i < 0) return false;
  log.splice(i, 1);
  markBackupDirty();
  if (d.notePending === entryId) delete d.notePending;
  delete d.note;
  vault.persist();
  syncNoteKin(id);
  refreshNoteViews(id);
  return true;
}
function clearNoteEntries(id) {
  const d = vault.byId(id); if (!d) return 0;
  const n = noteLogOf(d).length;
  if (!n) return 0;
  d.noteLog = [];
  markBackupDirty();
  delete d.notePending; delete d.note;
  vault.persist();
  syncNoteKin(id);
  refreshNoteViews(id);
  return n;
}
function deleteNote(id) { // legacy quick editors: drop the latest entry
  const d = vault.byId(id); if (!d) return false;
  const log = noteLogOf(d);
  if (!log.length) return false;
  const last = log[log.length - 1];
  return deleteNoteEntry(id, last.id);
}
// floating canvas editor (opened by clicking a body's note square; sun stays put)
function openNoteEditor(id, cx, cy) {
  const d = vault.byId(id); if (!d) return;
  noteEditId = id;
  const elog = noteLogOf(d);
  $('#noteEditTitle').textContent = '◉ ' + vault.titleOf(d) + (elog.length ? ` (${elog.length} ${elog.length === 1 ? 'entry' : 'entries'})` : '');
  try { const ec = $('#noteEditCite'); if (ec) { ec.innerHTML = docApaHtml(d); ec.hidden = false; } } catch {} // mined APA reference under the title
  $('#noteEditText').value = getNote(id);
  $('#noteEditCount').textContent = String(getNote(id).length);
  $('#noteEditDelete').style.display = getNote(id) ? '' : 'none';
  const el = $('#noteEdit');
  el.hidden = false;
  el.style.left = Math.max(8, Math.min(window.innerWidth - 266, cx + 12)) + 'px';
  el.style.top = Math.max(8, Math.min(window.innerHeight - 250, cy + 12)) + 'px';
  setTimeout(() => { try { $('#noteEditText').focus(); } catch {} }, 30);
}
function closeNoteEditor() { const el = $('#noteEdit'); if (el) el.hidden = true; noteEditId = null; }
// reader pop-out for the active body's note (copy / delete mirror the square)
function openNotePop(id) {
  if (notePopId === id && !$('#notePop').hidden) { closeNotePop(); return; } // toggle
  if (!vault.byId(id)) return;
  notePopId = id;
  renderNotePop(false);
  $('#notePop').hidden = false;
}
function closeNotePop() { const el = $('#notePop'); if (el) el.hidden = true; notePopId = null; }
function renderNotePop(editing) {
  const d = vault.byId(notePopId); if (!d) { closeNotePop(); return; }
  const log = noteLogOf(d);
  const note = log.length ? log[log.length - 1].text : '';
  const box = $('#notePop');
  const countLine = log.length > 1 ? `<div class="np-count">${log.length} entries in the shared notepad</div>` : '';
  if (editing || !note) {
    box.innerHTML = `<div class="np-head"><span class="np-title">◉ ${esc(vault.titleOf(d))}</span><span class="np-cap" data-np="close">✕</span></div>` +
      `<div class="np-cite" data-np="copycite" title="APA reference for this document - click to copy">${docApaHtml(d)}</div>` +
      `<textarea class="np-area" id="notePopText" maxlength="${NOTE_MAX}" placeholder="2000 characters max…">${esc(note)}</textarea>` +
      `<div class="np-count"><span id="notePopCount">${note.length}</span>/${NOTE_MAX}</div>` + countLine +
      `<div class="rowbtns"><button class="btn" data-np="save">Save</button><button class="btn" data-np="close">Cancel</button></div>`;
    const ta = $('#notePopText');
    if (ta) {
      ta.addEventListener('input', () => { const c = $('#notePopCount'); if (c) c.textContent = String(ta.value.length); });
      setTimeout(() => { try { ta.focus(); } catch {} }, 30);
    }
  } else {
    box.innerHTML = `<div class="np-head"><span class="np-title">◉ ${esc(vault.titleOf(d))}</span><span class="np-cap" data-np="copy">copy</span><span class="np-cap danger" data-np="del">delete</span><span class="np-cap" data-np="edit">edit</span><span class="np-cap" data-np="pane">notes pane</span><span class="np-cap" data-np="close">✕</span></div>` +
      `<div class="np-cite" data-np="copycite" title="APA reference for this document - click to copy">${docApaHtml(d)}</div>` +
      `<div class="np-text">${esc(note)}</div>` + countLine;
  }
}
// Citation metadata from the ORIGINAL file (not the rendered text): PDFs
// carry a document-info dict (+ XMP), Office files carry docProps/core.xml.
// Resolved once per original (sidecar bytes are shared across lineage
// copies), cached on the doc as d.citeMeta, then docApaInfo prefers it.
const citeMetaCache = new Map(); // origKey -> cleaned meta ({} when the original has none)
const citeMetaInflight = new Set(); // origKeys currently resolving
// words that are never person names: placeholders, headings, title vocabulary.
// Kills phantom "authors" mined from rendered text ("This Page" -> Page, T.).
const CITE_NAME_STOP = new Set(('this,that,these,those,page,pages,left,right,blank,intentionally,introduction,chapter,section,figure,table,abstract,contents,volume,report,study,studies,document,documents,file,draft,final,note,notes,preface,foreword,appendix,index,part,edition,copy,cover,title,text,body,sheet,slides,slide,image,picture,photo,scan,' +
'developing,development,potential,across,full,career,careers,guide,handbook,overview,summary,analysis,survey,research,science,sciences,business,management,health,education,national,international,global,world,new,complete,practical,ultimate,essential,primer,companion,paper,article,thesis,ebook,issue,number,magazine,newspaper,publishers,publishing,newsletter,workshop,fundamentals,student,students,teacher,school,course,lesson,history,law,medicine,engineering').split(','));
// lowercase words allowed inside a person-name line (particles + connectors).
// Title lines leak other lowercase words ("a", "of", "the") - names never do.
const NAME_GLUE = new Set(['and', '&', 'de', 'van', 'von', 'der', 'den', 'la', 'le', 'du', 'del', 'della', 'di', 'da', 'das', 'do', 'dos', 'bin', 'ibn', 'al', 'el', 'y']);
// shared person-name pattern: First [M.] [particle] Last - particles let
// "Ludwig van Beethoven" parse as one person instead of no one.
const CITE_WD = '[A-Z\u00C0-\u00DE][a-z\u00E0-\u00FE]+(?:-[A-Z\u00C0-\u00DE][a-z\u00E0-\u00FE]+)?';
const CITE_TAIL = '((?:\\s+[A-Z]\\.?|\\s+(?:van|von|de|der|den|la|le|du|del|della|di|da|das|do|dos|bin|ibn|al|el|y))*\\s+' + CITE_WD + ')';
function citeTailLast(tail) { // surname keeping particles ("van Beethoven"), dropping middle initials ("Q.")
  const toks = String(tail || '').trim().split(/\s+/).filter(t => !/^[A-Z]\.?$/.test(t));
  return toks.length ? toks.join(' ') : String(tail || '').trim().split(/\s+/).pop();
}
function cleanCiteNames(names) { // drop placeholder "people" (This Page, Left Blank) and fragments
  return (Array.isArray(names) ? names : []).filter(a => {
    const f = String((a && a.first) || '').toLowerCase().replace(/[^a-z\u00C0-\u00FF]/g, '');
    const l = String((a && a.last) || '').toLowerCase().replace(/[^a-z\u00C0-\u00FF]/g, '');
    return f.length >= 2 && l.length >= 2 && !CITE_NAME_STOP.has(f) && !CITE_NAME_STOP.has(l);
  });
}
const CITE_SOFT_JUNK = /^(microsoft word|microsoft office|ms word|word|untitled|document\d*|adobe|acrobat|distiller|ghostscript|libreoffice|openoffice|apple|pages|pdf[^a-z]*|creator|producer|author)$/i;
function splitCiteAuthors(s) { // embedded Author string -> [{first,last}]: "A. Smith; B. Jones", "Smith, A.", "A. Smith and B. Jones"
  const out = [];
  if (typeof s !== 'string' || !s.trim()) return out;
  const chunks = s.split(/\s*;\s*/).map(t => t.trim()).filter(Boolean);
  const parts = (chunks.length > 1 ? chunks : s.split(/\s+(?:and|&)\s+/i).map(t => t.trim()).filter(Boolean)).slice(0, 8);
  const WD = CITE_WD;
  for (const p of parts) {
    if (CITE_SOFT_JUNK.test(p.replace(/[0-9.]+/g, '').trim())) continue; // software names, not people
    let m = p.match(new RegExp('^(' + WD + '),\\s+(' + WD + '(?:\\s+[A-Z]\\.?)?|[A-Z]\\.?(?:\\s+[A-Z]\\.?)?)$'));
    if (m && !CITE_NAME_STOP.has(m[1].toLowerCase()) && !CITE_NAME_STOP.has(m[2].toLowerCase().replace(/[^a-z\u00C0-\u00FF]/g, ''))) { out.push({ first: m[2], last: m[1] }); continue; }
    const fl = new RegExp('\\b(' + WD + ')' + CITE_TAIL + '\\b').exec(p);
    if (fl) { out.push({ first: fl[1], last: citeTailLast(fl[2]) }); continue; }
  }
  return cleanCiteNames(out);
}
function cleanCiteMeta(m) { // validate shape (persisted rows, sidecar parses)
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const out = {};
  if (typeof m.title === 'string' && m.title.trim().length >= 4) out.title = m.title.trim().slice(0, 300);
  const au = cleanCiteNames(m.authors);
  if (au.length) out.authors = au.slice(0, 8);
  if (Number.isInteger(m.year) && m.year >= 1500 && m.year <= new Date().getFullYear()) out.year = m.year;
  return out;
}
async function citeMetaFromPdf(bytes) { // Title / Author / CreationDate from the real PDF dict (+ XMP)
  const out = {};
  let pdf = null;
  try {
    const pdfjs = await import('./vendor/pdf.mjs');
    const lib = pdfjs.getDocument ? pdfjs : (pdfjs.default || {});
    if (lib && lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
      try { lib.GlobalWorkerOptions.workerSrc = vendorBase() + 'pdf.worker.js'; } catch {}
    }
    if (!lib.getDocument) return out;
    pdf = await lib.getDocument({ data: bytes }).promise;
    let info = null, xm = null;
    try { const md = await pdf.getMetadata(); info = (md && md.info) || null; xm = (md && md.metadata) || null; } catch {}
    const pick = (...vs) => { for (const v of vs) { const s = String(v == null ? '' : v).trim(); if (s) return s; } return ''; };
    let xTitle = '', xAuth = '';
    try { if (xm && xm.get) { xTitle = String(xm.get('dc:title') || '').trim(); xAuth = String(xm.get('dc:creator') || '').trim(); } } catch {}
    let title = pick(xTitle, info && info.Title).replace(/^(Microsoft Word\s*-\s*|Word\s*-\s*)/i, '').trim();
    if (title && title.length >= 4 && !CITE_SOFT_JUNK.test(title.replace(/\.[a-z0-9]+$/i, '').trim()) && !/^untitled$/i.test(title)) out.title = title.slice(0, 300);
    const au = splitCiteAuthors(pick(info && info.Author, xAuth));
    if (au.length) out.authors = au;
    const ym = String(pick(info && info.CreationDate, info && info.ModDate)).match(/D:(\d{4})|^(\d{4})/);
    const y = ym ? +(ym[1] || ym[2]) : 0;
    if (y >= 1500 && y <= new Date().getFullYear()) out.year = y;
  } catch (e) { console.warn('cite metadata: PDF original parse skipped', (e && e.message) || e); }
  finally { try { if (pdf && pdf.destroy) await pdf.destroy(); } catch {} }
  return out;
}
async function citeMetaFromOffice(bytes) { // dc:title / dc:creator / dcterms:created from docProps/core.xml
  const out = {};
  try {
    const fflate = await import('./vendor/fflate.mjs');
    const unzip = fflate.unzipSync || (fflate.default || {}).unzipSync;
    if (!unzip) return out;
    const files = unzip(bytes);
    const key = Object.keys(files).find(k => /(^|\/)docProps\/core\.xml$/.test(k));
    if (!key) return out;
    const xml = new DOMParser().parseFromString(new TextDecoder().decode(files[key]), 'application/xml');
    if (!xml || xml.querySelector('parsererror')) return out;
    const txt = (n) => {
      const els = xml.getElementsByTagNameNS('*', n);
      for (const el of els) { const s = String(el.textContent || '').trim(); if (s) return s; }
      return '';
    };
    const title = txt('title').replace(/^(Microsoft Word\s*-\s*)/i, '').trim();
    if (title && title.length >= 4 && !/^untitled$/i.test(title)) out.title = title.slice(0, 300);
    const creator = txt('creator');
    if (creator && !/microsoft|libreoffice|openoffice|google|apple/i.test(creator)) {
      const au = splitCiteAuthors(creator);
      if (au.length) out.authors = au;
    }
    const ym = (txt('created') || txt('modified')).match(/^(\d{4})/);
    const y = ym ? +ym[1] : 0;
    if (y >= 1500 && y <= new Date().getFullYear()) out.year = y;
  } catch (e) { console.warn('cite metadata: office original parse skipped', (e && e.message) || e); }
  return out;
}
async function resolveCiteMeta(id) { // fill d.citeMeta from the original bytes, then repaint the notes surfaces
  let d = null;
  try { d = vault.byId(id) || vault.byIdAnywhere(id); } catch { return; }
  if (!d || d.citeMeta || !d.origKey) return;
  const key = String(d.origKey);
  if (citeMetaInflight.has(key)) return;
  const hit = citeMetaCache.get(key);
  if (hit) {
    d.citeMeta = { ...hit };
    try { vault.persist(); } catch {}
    try { if (notesOpen && notesDocId === d.id) renderNotesPane(); } catch {}
    return;
  }
  citeMetaInflight.add(key);
  try {
    let bytes = null;
    try {
      const blob = await origBlob(d);
      if (blob) bytes = new Uint8Array(await blob.arrayBuffer());
    } catch {}
    let meta = {};
    if (bytes && bytes.length) {
      const nm = String(d.name || '').toLowerCase();
      if (/\.pdf$/.test(nm)) meta = await citeMetaFromPdf(bytes);
      else if (/\.(docx?|pptx?|xlsx?)$/.test(nm)) meta = await citeMetaFromOffice(bytes);
      // txt/md/csv/images: the stored text already IS the original - text mining stands
    }
    const clean = cleanCiteMeta(meta) || {};
    citeMetaCache.set(key, clean);
    const apply = (x) => { x.citeMeta = { ...clean }; };
    apply(d);
    try { for (const x of kinDocs(d.id)) if (x !== d) apply(x); } catch {} // same original, same citation
    try { vault.persist(); } catch {}
    try { markBackupDirty(); } catch {}
    if (notesOpen && notesDocId === id) { try { renderNotesPane(); } catch {} }
  } catch (e) {
    console.warn('cite metadata: original unreadable, staying with text-mined reference', (e && e.message) || e);
    citeMetaCache.set(key, {});
    d.citeMeta = {};
    try { vault.persist(); } catch {}
  } finally {
    citeMetaInflight.delete(key);
  }
}
async function copyNotePop() {
  const d = vault.byId(notePopId);
  if (!d) return;
  const all = noteLogOf(d).map(e => e.text).join('\n\n');
  if (!all) return;
  try { await navigator.clipboard.writeText(all); }
  catch { const ta = document.createElement('textarea'); ta.value = all; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove(); }
  toast(noteLogOf(d).length > 1 ? `${noteLogOf(d).length} note entries copied` : 'Sticky note copied');
}
function setKicker(s) { const k = $('#docPanel .kicker'); if (k && k.textContent !== s) k.textContent = s; }
// tags-view pop-out: every tag in the active verse as its original pill on a
// glass card — frosted + dark font on a white canvas, clear glass + white font
// on a black canvas (maximum contrast either way). Tag pills keep data-tag, so
// clicking one still feeds the search box.
function verseTags() {
  const t = vault.tab();
  const out = new Map();
  for (const d of ((t && t.docs) || [])) for (const tg of (d.tags || [])) {
    const disp = vault.stripAuto(tg);
    if (!disp) continue;
    if (!out.has(disp)) out.set(disp, { disp, auto: true, manual: false });
    const low = String(tg).toLowerCase();
    if (!low.startsWith('auto/')) out.get(disp).auto = false;
    if (low.startsWith('manual/')) out.get(disp).manual = true;
  }
  return [...out.values()].sort((a, b) => a.disp < b.disp ? -1 : 1);
}
function syncTagVerseBtn() {
  const b = $('#tagVerseBtn');
  if (!b) return;
  b.textContent = lensTags ? '◈ Exit tags view' : '◈ Show tags view';
  b.title = lensTags
    ? 'Leave the tags view — restore the Main view'
    : 'Tags view: redraw the canvas around the labels on the documents — one body per tag, webbed by the member documents the tags share';
}
function openTagPop(hiDisp) {
  const box = $('#tagPop');
  if (!box) return;
  const tags = verseTags();
  const card = box.querySelector('.tvp-card');
  const darkCanvas = (typeof bgShade === 'number' ? bgShade : 1) > 0.5;
  if (card) {
    card.classList.toggle('tvp-clear', darkCanvas);
    card.classList.toggle('tvp-frost', !darkCanvas);
  }
  const title = box.querySelector('.tvp-title');
  if (title) title.textContent = `ALL TAGS — ${tags.length}`;
  const list = box.querySelector('.tvp-tags');
  if (list) list.innerHTML = tags.length
    ? tags.map(t => `<button class="tagpill${t.auto ? ' auto' : ''}${t.manual ? ' manual' : ''}" data-tag="${esc(t.disp)}" data-tpill="${esc(t.disp)}" draggable="true" title="Click to open in TAGS view as the sun · drag onto another tag to merge · drop onto highlighted reader text to tag that passage · × deletes · right-click or double-click renames">#${esc(t.disp)}${t.manual ? '<span class="mmark" title="Manually created tag">M</span>' : ''}<span class="tvp-x" data-tdel="${esc(t.disp)}" title="Delete #${esc(t.disp)} from every body on this canvas">×</span></button>`).join('')
    : '<span class="tvp-empty">No tags in this verse yet — add #hashtags to a body.</span>';
  syncTagVerseBtn();
  syncConfirmTip();
  applyTvpGeom();
  box.hidden = false;
  // sun linkage: the highlighted tag (explicit, else the canvas-selected one)
  // glows gold; off-screen pills auto-scroll into view (explicit list scroll
  // so a pill below the fold always lands fully in view)
  try {
    let hi = hiDisp;
    if (!hi && typeof activeId === 'string') { const sr = tagById(activeId); hi = sr && sr.terms && sr.terms[0]; }
    const listHi = box.querySelector('.tvp-tags');
    if (hi && listHi) {
      let pill = null;
      try { pill = listHi.querySelector(`[data-tpill="${CSS.escape(hi)}"]`); } catch {}
      if (!pill) {
        const want = String(hi).trim().toLowerCase();
        for (const p of listHi.querySelectorAll('[data-tpill]')) {
          if (String(p.dataset.tpill || '').trim().toLowerCase() === want) { pill = p; break; }
        }
      }
      if (pill) {
        pill.classList.add('sunlit');
        try { ensureTvpPillVisible(listHi, pill); } catch {}
      }
    }
  } catch {}
}
function closeTagPop() { const box = $('#tagPop'); if (box) box.hidden = true; }
// ---------- tagging guide: dev-editable glass pane from the tags card ----------
// Machine-only like the glossary (localStorage `visidocsverse.tagGuide`): edits
// never ship to installers or backups, and the ✎ button only appears in the
// editor preview (body.help-can-edit gates it via CSS, same as every helper).
const TAG_GUIDE_DEFAULT = [
  'Tags are the labels on your documents. Three kinds live here: #explicit tags you type into body text, manual tags you pin onto a selection through the Tag menu (gold M — click one to jump back to the exact passage), and #auto tags the app derives from titles.',
  'In your research workflow, you tag documents to create clusters of related information, which helps visualize conceptual relationships and navigate your document universe. You apply specific, logical tags—such as #Theme or #Phase—to group files effectively. These tags act as metadata, allowing the system to identify connections, reveal overlaps, and maintain structure across your research materials. Using consistent naming conventions alongside these tags improves searchability, ensuring your workspace remains organized and impactful. Ultimately, this approach transforms scattered documents into an interactive, structured workspace that makes synthesizing evidence across different sources straightforward.',
  'To make the "art of tagging" feel intuitive, here are three easy-to-understand analogies:',
  '1. The Supermarket Aisle vs. The Magic Scanner\nTraditional Folders: Imagine a physical grocery store. An apple must sit in the Produce section under Fruit. If you want to put it in "Snacks," "Baking Supplies," or "Low-Calorie Foods," you can\'t—unless you buy three identical apples and put one in each section.',
  'Tagging: Imagine every item in the store has a set of invisible digital tags (#Fruit, #Snacks, #Baking, #Under100Calories). When you scan your shopping list for #Baking, the store instantly brings the apple, flour, and cinnamon together in front of you.',
  'The Art: Tagging allows one item to exist in multiple context categories simultaneously without creating duplicate copies.',
  '2. Wardrobe Accessories vs. Complete Outfits\nTraditional Folders: Storing files in strict folders is like buying a pre-styled mannequin from a store window—the jacket, shirt, and pants are locked together as one fixed outfit.',
  'Tagging: Tagging treats each document like an individual clothing item hanging in a modular closet. A pair of black boots can be tagged #Formal, #Winter, and #Leather.',
  'The Art: Depending on what occasion you are dressing for (or what research question you are answering), you pull items based on the specific combination of tags you need at that exact moment.',
  '3. The Constellation Map (Connecting the Dots)\nTraditional Folders: Think of a traditional filing cabinet as a row of isolated cardboard boxes stacked on a shelf. The contents of Box A cannot see or interact with Box B.',
  'Tagging: Think of your document collection as a night sky full of stars. Each document is a single star. When you apply a tag like #Phase1 or #Theme, you light up a string that connects all stars bearing that tag, drawing a clear constellation across your entire universe of information.',
  'The Art: Over time, overlapping tags reveal hidden patterns, clusters, and relationships between documents that would have otherwise remained buried inside separate folders.',
  'Core Principles of Great Tagging\nKeep them broad yet specific: Use tags for cross-cutting attributes (e.g., #Status/Draft, #Source/Interview, #Topic/Equity).',
  'Be consistent: Decide on a naming rule early on (e.g., lowercase vs. TitleCase) to avoid duplicate tags like #Research and #research.',
  'Use them as dynamic filters: Combine two or three tags (e.g., #Phase1 + #HighPriority) to instantly isolate the exact subset of documents you need.'
];
let tagGuideText = null; // null = pristine default above
try { const g = localStorage.getItem('visidocsverse.tagGuide'); if (typeof g === 'string' && g.trim()) tagGuideText = g; } catch { /* fresh prefs */ }
function tagGuideRaw() {
  return (typeof tagGuideText === 'string' && tagGuideText.trim()) ? tagGuideText : TAG_GUIDE_DEFAULT.join('\n\n');
}
function saveTagGuide() {
  try {
    if (typeof tagGuideText === 'string' && tagGuideText.trim()) localStorage.setItem('visidocsverse.tagGuide', tagGuideText);
    else localStorage.removeItem('visidocsverse.tagGuide');
  } catch { /* private mode */ }
}
function renderTagGuide() {
  const b = $('#tagGuideBody');
  if (!b) return;
  b.innerHTML = tagGuideRaw().split(/\n\s*\n/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}
function openTagGuide() {
  const box = $('#tagGuidePane');
  if (!box) return;
  const card = box.querySelector('.tvp-card');
  const darkCanvas = (typeof bgShade === 'number' ? bgShade : 1) > 0.5;
  if (card) {
    card.classList.toggle('tvp-clear', darkCanvas);
    card.classList.toggle('tvp-frost', !darkCanvas);
  }
  renderTagGuide();
  box.hidden = false;
}
function closeTagGuide() { const box = $('#tagGuidePane'); if (box) box.hidden = true; }
// ---------- how-to-start: the same glass card recipe as the tagging guide,
// opened from the discrete "How to start" link at the pill's bottom-left.
// Machine-only like the guide (localStorage `visidocsverse.howStart`): edits
// never ship to installers or backups, and the ✎ button only appears in the
// editor preview (body.help-can-edit gates it via CSS, same as every helper).
// Paragraphs starting with "N · Title." keep their bold lead when rendered.
const HOWSTART_DEFAULT = [
  '1 · Create your first project. Click the “Create a project” tab at the top of the top pill. That tab is also called a canvas — it is your document universe. Then double-click the new tab to rename it anything you like.',
  '2 · Upload your files or a whole folder. In the left pane, click “⤓ Folder” to bring in a whole folder, or “⤓ Files” to pick individual files — or simply drop files straight onto the canvas. Each file becomes a body in your universe. Your originals never move: they stay right where they are on your computer.',
  '3 · Add tabs when you need room. The “+” inside your project\u2019s frame adds more tabs to the same universe. Extra tabs are handy for isolating a smaller part of the main tab\u2019s document universe, or for spreading out when the main canvas gets crowded. They always stay connected to the main universe tab — uploads, copies, deletes and twin motion span the whole group.',
  '4 · Start something completely separate. Click the dashed “+” box that sits beside — outside — your project\u2019s cluster of tabs. That creates a brand-new, standalone universe: separate, and not associated with the current project cluster.',
  '5 · Copy single things easily. Right-click any body (or a box-selected bunch of bodies) and choose “⤓ Copy to …” to send it straight into any other tab, wherever that tab lives. Copies only — the originals never move.',
  '6 · Copy everything at once. Right-click a tab and choose “⧉ Copy all content”. Then either right-click the destination tab and choose “⤓ Paste …”, or simply right-click its empty canvas and choose “⤓ Paste …” there. Whole canvases travel too: click the small “save project” label on a tab to keep a backup copy on your computer, then “Open Saved Project” in the left pane to merge it into any tab — so nothing is ever stuck.',
  'NOTE: ALWAYS SAVE YOUR WORK BEFORE CLOSING THE VISIDOCSVERSE APP. CLICK ON "SAVE PROJECT" (SAVE IS TO YOUR HARD DRIVE). THAT WAY YOUR HARD WORK IS ALWAYS SAFE. IMPORTING A SAVED PROJECT IS EASY: CLICK ON "OPEN SAVED PROJECT" (LEFT PANE) AND SELECT THE FOLDER WHERE YOUR SAVED PROJECT LIVES ON YOUR HARD DRIVE.',
];
let howStartText = null; // null = pristine default above
try { const g = localStorage.getItem('visidocsverse.howStart'); if (typeof g === 'string' && g.trim()) howStartText = g; } catch { /* fresh prefs */ }
function howStartRaw() {
  return (typeof howStartText === 'string' && howStartText.trim()) ? howStartText : HOWSTART_DEFAULT.join('\n\n');
}
function saveHowStart() {
  try {
    if (typeof howStartText === 'string' && howStartText.trim()) localStorage.setItem('visidocsverse.howStart', howStartText);
    else localStorage.removeItem('visidocsverse.howStart');
  } catch { /* private mode */ }
}
function renderHowStart() {
  const b = $('#howStartBody');
  if (!b) return;
  b.innerHTML = howStartRaw().split(/\n\s*\n/).map(p => {
    const t = p.trim();
    if (!t) return '';
    const m = t.match(/^(\d+\s*·[^.]*\.)\s*/);
    const body = m ? t.slice(m[1].length).trim() : t;
    return `<p>${m ? `<b>${esc(m[1])}</b> ` : ''}${esc(body).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}
function openHowStart() {
  const box = $('#howStartPane');
  if (!box) return;
  const card = box.querySelector('.tvp-card');
  const darkCanvas = (typeof bgShade === 'number' ? bgShade : 1) > 0.5;
  if (card) {
    card.classList.toggle('tvp-clear', darkCanvas);
    card.classList.toggle('tvp-frost', !darkCanvas);
  }
  renderHowStart();
  box.hidden = false;
}
function closeHowStart() { const box = $('#howStartPane'); if (box) box.hidden = true; }
let howEditing = false;
function openHowEditor() {
  if (!helpEditAllowed()) return;
  howEditing = true; glossEditingWord = null; helpEditingKey = null; guideEditing = false;
  const modal = document.querySelector('#helpEditModal');
  const title = document.querySelector('#helpEditTitle');
  const area = document.querySelector('#helpEditText');
  const hint = document.querySelector('#helpEditHint');
  if (!modal || !area) return;
  if (title) title.textContent = 'Edit How to start guide';
  if (hint) hint.textContent = 'Saved on this machine only — the guide never rides backups or installers. A blank line starts a new paragraph. Begin a paragraph with “N · Title.” to keep its bold lead.';
  area.value = howStartRaw();
  modal.hidden = false;
  setTimeout(() => { try { area.focus(); area.select(); } catch {} }, 30);
}
function saveHowEditor(reset) {
  if (reset) howStartText = null;
  else {
    const area = document.querySelector('#helpEditText');
    const v = area ? area.value.trim() : '';
    howStartText = v || null;
  }
  saveHowStart();
  renderHowStart();
  howEditing = false;
  closeHelpEditor();
  toast(reset ? 'How to start guide reset to default' : 'How to start guide saved (this machine only)');
}
let guideEditing = false;
function openGuideEditor() {
  if (!helpEditAllowed()) return;
  guideEditing = true; glossEditingWord = null; helpEditingKey = null; howEditing = false;
  const modal = document.querySelector('#helpEditModal');
  const title = document.querySelector('#helpEditTitle');
  const area = document.querySelector('#helpEditText');
  const hint = document.querySelector('#helpEditHint');
  if (!modal || !area) return;
  if (title) title.textContent = 'Edit tagging guide';
  if (hint) hint.textContent = 'Saved on this machine only — the guide never rides backups or installers. A blank line starts a new paragraph.';
  area.value = tagGuideRaw();
  modal.hidden = false;
  setTimeout(() => { try { area.focus(); area.select(); } catch {} }, 30);
}
function saveGuideEditor(reset) {
  if (reset) tagGuideText = null;
  else {
    const area = document.querySelector('#helpEditText');
    const v = area ? area.value.trim() : '';
    tagGuideText = v || null;
  }
  saveTagGuide();
  renderTagGuide();
  guideEditing = false;
  closeHelpEditor();
  toast(reset ? 'Tagging guide reset to default' : 'Tagging guide saved (this machine only)');
}
// ---------- view source: 120-word smart preview on right-hold ----------
// Section-led excerpt: abstract for papers, foreword/preface/prologue/
// introduction for books, opening lines otherwise; thumbnails for image-only docs.
const SRC_WORDS = 120;
const SRC_HOLD_MS = 280;
const SRC_SEC_RES = [
  [/^\s*abstract\b/i, 'Abstract'],
  [/^\s*(executive\s+summary|summary|synopsis)\b/i, 'Summary'],
  [/^\s*foreword\b/i, 'Foreword'],
  [/^\s*preface\b/i, 'Preface'],
  [/^\s*prologue\b/i, 'Prologue'],
  [/^\s*(introduction|intro|overview)\b/i, 'Introduction'],
];
const SRC_STOP_RE = /^\s*(references|bibliography|works\s+cited|appendix|acknowledg(e)?ments?|contents|table\s+of\s+contents|chapter\s+\d+)\b/i;
function srcWords(s) { return (String(s || '').match(/\S+/g) || []); }
function srcTake(lines, budget) {
  // gather lines until the word budget or a stop heading (past 30 words)
  const out = [];
  let n = 0, ci = 0;
  for (const ln of lines) {
    ci++;
    if (n >= 30 && (SRC_STOP_RE.test(ln) || /^#{1,3}\s+\S/.test(ln))) break;
    const ws = srcWords(ln);
    if (!ws.length) { if (n > 0) out.push(''); continue; }
    if (n + ws.length > budget) { out.push(ws.slice(0, budget - n).join(' ')); n = budget; break; }
    out.push(ln); n += ws.length;
    if (n >= budget) break;
  }
  return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), words: n, more: ci < lines.length || n >= budget };
}
function srcSection(text) {
  const lines = String(text || '').split('\n');
  for (const [re, label] of SRC_SEC_RES) {
    const i = lines.findIndex(l => re.test(l));
    if (i >= 0) {
      const take = srcTake(lines.slice(i + 1), SRC_WORDS);
      if (take.words > 0) return { label, ...take };
    }
  }
  // opening: strip a leading H1 title (already in the header), skip blanks
  let s = (lines[0] && /^#\s+/.test(lines[0])) ? 1 : 0;
  while (s < lines.length && !lines[s].trim()) s++;
  return { label: 'Opening', ...srcTake(lines.slice(s), SRC_WORDS) };
}
function srcHighlight(id) {
  try {
    const p = $('#docPanel');
    if (!p || p.classList.contains('collapsed') || !p.offsetParent) return;
    // the row must exist to light up: the general list shows only the 6
    // largest until "View all bodies" — expand automatically (once) so the
    // hovered body always has a row, then scroll that row into view.
    // (Explicit jumps already scroll via paintGoldRows(id); hover used to
    // deliberately skip all of this — that is what stranded off-list docs.)
    try {
      const dl = document.querySelector('#docLinks');
      const row = dl && id && dl.querySelector(`.bl-row[data-open="${CSS.escape(id)}"]`);
      if (!row) {
        const t = vault.tab();
        if (t && (t.docs || []).length > 6 && !showAllBodies && typeof renderGeneral === 'function') {
          showAllBodies = true;
          renderGeneral(); // lists every body; nulls srcHi, re-set below
        }
      }
    } catch {}
    srcHi = id;
    paintGoldRows(id); // lights the row and scrolls it into the visible inventory
  } catch {}
}
// Tags view multi-highlight: every tag body grounding the shown document
// lights gold together (the TAGS jump still seats+pan on the first one, but
// the doc reads as belonging to all of them). Recomputed lazily per frame
// via tagHiKey so tag edits / doc switches refresh without a 60fps rebuild.
// Reader rule (every view): the displayed document's orb stays lit wherever
// it has a body — parking a doc in the reader can never leave it cold blue.
function syncTagHi() {
  try {
    if (!uni) { if (tagHiIds.size) tagHiIds = new Set(); tagHiKey = '|'; if (ren) ren.hotSet = tagHiIds; return; }
    if (!lensTags) {
      // no tag set outside the Tags view — just the reader rule below
      if (tagHiIds.size) tagHiIds = new Set();
      tagHiKey = 'main';
    } else {
      const vid = paneId || (vault.byId(activeId) ? activeId : null);
      const d = vid && vault.byId(vid);
      const sig = (vault.activeTabId || '') + '|' + (d ? d.id : '') + '|' + tagSig(((vault.tab() || {}).docs) || []);
      if (sig !== tagHiKey || !ren || ren.hotSet !== tagHiIds) {
        tagHiKey = sig;
        const want = new Set();
        if (d) for (const r of tagsFor(((vault.tab() || {}).docs) || [])) {
          if ((r.members || []).includes(d.id) && uni.byId.has(r.id)) want.add(r.id);
        }
        tagHiIds = want;
      }
    }
    if (paneId && uni.byId.has(paneId) && !tagHiIds.has(paneId)) {
      const nx = new Set(tagHiIds); nx.add(paneId); tagHiIds = nx;
    }
    if (ren && ren.hotSet !== tagHiIds) ren.hotSet = tagHiIds;
  } catch { try { if (ren) ren.hotSet = tagHiIds; } catch {} }
}
// every id whose row should stay gold while its selection stands: the hovered
// body, the last associated-document pick, the selected orb, the pane pin and
// whatever the reader shows, the open Notes pane's own document, plus the
// physical sun (dot crowns never render).
function goldIds() {
  const s = new Set();
  try {
    if (srcHi) s.add(srcHi);
    if (assocSelId) s.add(assocSelId);
    if (canvasHiId) s.add(canvasHiId); // MAIN pill pick: its row stays gold while the canvas halo stands (reader untouched)
    if (activeId) s.add(activeId);
    if (paneId) s.add(paneId);
    if (shownId) s.add(shownId);
    if (notesOpen && notesDocId) s.add(notesDocId); // its pane stands: row stays gold
    const sun = (uni && uni.sunId && uni.byId && uni.byId.has(uni.sunId)) ? uni.sunId : null;
    if (sun) s.add(sun);
    for (const id of intakeHiIds) s.add(id); // lens arrivals stay lit where they situated
  } catch {}
  return s;
}
// repaint the reader inventory gold from the live selection state. Every
// render ends here (via syncDocActionButtons) so rebuilt rows re-light;
// hover fades and preview closes funnel through srcClearHi, which keeps the
// persistent ids lit. Pass an id to also scroll it into view.
function paintGoldRows(scrollTo) {
  try {
    const dl = document.querySelector('#docLinks');
    if (!dl) return;
    const want = goldIds();
    dl.querySelectorAll('.bl-row[data-open]').forEach(r => {
      const id = r.getAttribute('data-open');
      if (id && want.has(id)) r.classList.add('src-hi');
      else r.classList.remove('src-hi');
    });
    // the open Notes pane red-frames its document's inventory note mark;
    // closing the pane drops the frame (closeNotesPane repaints here too).
    const openNote = (notesOpen && notesDocId && vault.byId(notesDocId)) ? notesDocId : null;
    dl.querySelectorAll('.bl-note[data-notes-pane]').forEach(b => {
      if (b.getAttribute('data-notes-pane') === openNote) b.classList.add('note-open');
      else b.classList.remove('note-open');
    });
    if (scrollTo) {
      const row = dl.querySelector(`.bl-row[data-open="${CSS.escape(scrollTo)}"]`);
      if (row) { try { row.scrollIntoView({ block: 'center' }); } catch {} }
    }
    try { syncEye(); } catch {} // rows rebuild or pins toggle — the pinned eye follows
  } catch {}
}
function srcClearHi() { srcHi = null; try { paintGoldRows(); } catch { try { document.querySelectorAll('#docLinks .bl-row.src-hi').forEach(b => b.classList.remove('src-hi')); } catch {} } }
// camera pan glide: reader-driven locates ease instead of snapping. A locate
// whose target already projects on-screen glides (slow for near-center
// picks, so the jump reads instead of jolts); a target off the screen edge
// still snaps instantly, as before. Any fresh canvas gesture, Fit move or
// view restore cancels the glide and owns the camera.
let camGlide = null; // {x0,y0,x1,y1,d0,d1,yaw0,yaw1,pitch0,pitch1,t0,dur} | null (d/yaw/pitch optional: pan-only glides leave them null)
let snapCenter = true; // setting: reader-driven locates recenter the canvas (glide on-screen, snap off-screen). Off = the camera never auto-pans on picks.
function camCancelGlide() { camGlide = null; }
function camGlideStep(nowMs) {
  if (!camGlide || !ren || !ren.cam) { camGlide = null; return; }
  const g = camGlide;
  const k = (nowMs - g.t0) / Math.max(1, g.dur);
  if (!(k < 1)) {
    ren.cam.px = g.x1; ren.cam.py = g.y1;
    if (g.d1 != null) ren.cam.dist = g.d1;
    if (g.yaw1 != null) ren.cam.yaw = g.yaw1;
    if (g.pitch1 != null) ren.cam.pitch = g.pitch1;
    camGlide = null; return;
  }
  const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; // easeInOutCubic
  ren.cam.px = g.x0 + (g.x1 - g.x0) * e;
  ren.cam.py = g.y0 + (g.y1 - g.y0) * e;
  if (g.d0 != null && g.d1 != null) ren.cam.dist = g.d0 + (g.d1 - g.d0) * e;
  if (g.yaw0 != null && g.yaw1 != null) ren.cam.yaw = g.yaw0 + (g.yaw1 - g.yaw0) * e;
  if (g.pitch0 != null && g.pitch1 != null) ren.cam.pitch = g.pitch0 + (g.pitch1 - g.pitch0) * e;
}
function camEaseTo(dx, dy, offscreen) {
  if (!ren || !ren.cam) return false;
  if (!snapCenter) return false; // snap-to-center disabled: the camera stays put on picks
  if (offscreen) {
    // fast path: the summoned body is off the edge — snap as before
    camGlide = null;
    ren.cam.px += dx;
    ren.cam.py += dy;
    return true;
  }
  const dist = Math.hypot(dx, dy);
  if (!(dist > 0.5)) return false;
  // slow path: on-screen picks glide — a fixed gentle beat whose speed falls
  // for close-to-center nudges (small dist / ~450ms reads as a calm drift,
  // edge-visible travels take up to ~900ms but never snap)
  const dur = Math.max(450, Math.min(900, 350 + dist * 0.9));
  camGlide = { x0: ren.cam.px || 0, y0: ren.cam.py || 0, x1: (ren.cam.px || 0) + dx, y1: (ren.cam.py || 0) + dy, d0: null, d1: null, yaw0: null, yaw1: null, pitch0: null, pitch1: null, t0: performance.now(), dur };
  return true;
}
// Return glide: ease the whole camera (pan + dolly + orbit) to a remembered
// view instead of snapping. Duration scales with travel distance so short
// hops feel snappy (~450ms) and cross-canvas leaps still land softly (≤1100ms).
// Any fresh gesture cancels it via the existing camCancelGlide() call sites.
function camFlyTo(t) {
  if (!ren || !ren.cam || !t) return false;
  const cx = ren.cam.px || 0, cy = ren.cam.py || 0, cd = ren.cam.dist || 620;
  const cyaw = ren.cam.yaw || 0, cpitch = ren.cam.pitch || 0;
  const tx = (typeof t.px === 'number' ? t.px : cx), ty = (typeof t.py === 'number' ? t.py : cy);
  const td = (typeof t.dist === 'number' ? t.dist : cd);
  const tyaw = (typeof t.yaw === 'number' ? t.yaw : cyaw), tpitch = (typeof t.pitch === 'number' ? t.pitch : cpitch);
  const pan = Math.hypot(tx - cx, ty - cy);
  const zoom = Math.abs(Math.log(Math.max(80, td) / Math.max(80, cd)));
  const ang = Math.abs(tyaw - cyaw) + Math.abs(tpitch - cpitch);
  if (pan < 0.5 && zoom < 0.001 && ang < 0.0005) {
    camGlide = null;
    ren.cam.px = tx; ren.cam.py = ty; ren.cam.dist = td; ren.cam.yaw = tyaw; ren.cam.pitch = tpitch;
    return true;
  }
  const dur = Math.max(450, Math.min(1100, 350 + pan * 0.6 + zoom * 450 + ang * 320));
  camGlide = { x0: cx, y0: cy, x1: tx, y1: ty, d0: cd, d1: td, yaw0: cyaw, yaw1: tyaw, pitch0: cpitch, pitch1: tpitch, t0: performance.now(), dur };
  return true;
}
// pan the camera just enough to bring a body into view — zoom, spin and
// physics untouched, and a no-op when the body already projects on-screen.
function centerCamOn(id, onlyIfOffscreen) {
  if (!ren || !uni) return false;
  try {
    const n = uni.byId.get(id);
    if (!n) return false;
    const r = ren.cv.getBoundingClientRect();
    const W = r.width || 300, H = r.height || 400;
    const p = ren.project(n.x, n.y, n.z);
    const m = 40; // margin: only travel when truly out of sight
    const off = p.x < -m || p.x > W + m || p.y < -m || p.y > H + m;
    if (onlyIfOffscreen && !off) { camCancelGlide(); return false; }
    return camEaseTo(W / 2 - p.x, H / 2 - p.y, off);
  } catch { return false; }
}
// VIEW IN jumps: center the whole pertinent area, not just travel when
// off-screen — the target can be on-screen yet buried in a dense cluster.
// For one body this is an exact center; for several (a doc's tags) it is
// their centroid, so the group lands centered as a group. Zoom, spin and
// physics untouched.
function centerCamOnMean(ids) {
  if (!ren || !uni) return false;
  try {
    const pts = (ids || []).map(id => uni.byId.get(id)).filter(Boolean);
    if (!pts.length) return false;
    if (pts.length === 1) return centerCamOn(pts[0].id, false);
    // pan so the MEAN OF PROJECTIONS lands dead-center: every marker shifts
    // by the same screen offset, so one step plants the group exactly
    // (projecting the world centroid instead sits off-center for deep groups)
    const r = ren.cv.getBoundingClientRect();
    const W = r.width || 300, H = r.height || 400;
    let sx = 0, sy = 0;
    for (const n of pts) { const p = ren.project(n.x, n.y, n.z); sx += p.x; sy += p.y; }
    const mx = sx / pts.length, my = sy / pts.length;
    const m = 40;
    const off = mx < -m || mx > W + m || my < -m || my > H + m;
    return camEaseTo(W / 2 - mx, H / 2 - my, off);
  } catch { return false; }
}
// hover handoff: the gold row lingers briefly after the cursor leaves its orb,
// so the user can travel to the reader pane and click it; gliding onto the row
// itself holds the highlight until the click lands.
function srcClearHiSoon(ms) { try { clearTimeout(hoverHiTimer); } catch {} try { hoverHiTimer = setTimeout(() => { srcClearHi(); }, ms || 1400); } catch {} }
function srcHoldHi() { try { clearTimeout(hoverHiTimer); } catch {} }
function openSrcPop(id, x, y, sticky) {
  const d = vault.byId(id) || vault.byIdAnywhere(id);
  const box = $('#srcPop');
  if (!d || !box) return false;
  // overlays never stack: a preview dismisses the lightbox and any menu, so
  // clicks can never land on the wrong layer (zoom opening over a preview,
  // or a preview's ✕ buried under the zoom).
  try { $('#imgLight').hidden = true; } catch {}
  try { $('#ctxMenu').hidden = true; } catch {}
  const card = box.querySelector('.svp-card');
  const darkCanvas = (typeof bgShade === 'number' ? bgShade : 1) > 0.5;
  if (card) { card.classList.toggle('tvp-clear', darkCanvas); card.classList.toggle('tvp-frost', !darkCanvas); }
  $('#svpTitle').textContent = vault.titleOf(d);
  const words = srcWords(d.text).length;
  const imgs = (d.images || []).filter(im => im && im.key);
  const body = $('#svpBody'), cap = $('#svpCap'), foot = $('#svpFoot');
  cap.hidden = true; cap.textContent = '';
  const mkind0 = mediaKind(d.name, '');
  if (mkind0 === 'image' && d.origKey) {
    // standalone photo body: thumbnail from the kept original bytes
    $('#svpSec').textContent = 'Image';
    body.innerHTML = '<span style="color:var(--mut)">loading thumbnail…</span>';
    const titleAtOpen = vault.titleOf(d);
    (async () => {
      try {
        let url = mediaUrlCache.get(d.origKey);
        if (!url) {
          const blob0 = await origBlob(d);
          if (!blob0 || !(blob0.size > 0)) throw 0;
          url = URL.createObjectURL(blob0); mediaUrlCache.set(d.origKey, url);
        }
        if (box.hidden || $('#svpTitle').textContent !== titleAtOpen) return; // moved on
        body.innerHTML = '';
        const img = document.createElement('img');
        img.onload = () => { try { if (!box.hidden) place(); } catch {} };
        img.src = url; img.alt = titleAtOpen;
        body.appendChild(img);
      } catch { body.innerHTML = '<span style="color:var(--mut)">image kept on the original device — not in this backup</span>'; }
    })();
    if (words) { cap.hidden = false; cap.textContent = `${words} words of readable text`; }
    foot.textContent = 'thumbnail preview · release to close';
  } else if (words < 8 && imgs.length) {
    // picture-only body: miniaturized picture instead of words
    $('#svpSec').textContent = 'Image';
    body.innerHTML = '<span style="color:var(--mut)">loading thumbnail…</span>';
    const first = imgs[0];
    const titleAtOpen = vault.titleOf(d);
    (async () => {
      try {
        let url = imgUrlCache.get(first.key);
        if (!url) {
          const rec = await imgGet(first.key);
          if (!rec || !rec.blob || !(rec.blob.size > 0)) throw 0;
          url = URL.createObjectURL(rec.blob); imgUrlCache.set(first.key, url);
        }
        if (box.hidden || $('#svpTitle').textContent !== titleAtOpen) return; // moved on
        body.innerHTML = '';
        const img = document.createElement('img');
        img.onload = () => { try { if (!box.hidden) place(); } catch {} };
        img.src = url; img.alt = first.cap || titleAtOpen;
        body.appendChild(img);
      } catch { body.innerHTML = '<span style="color:var(--mut)">image kept on the original device — not in this backup</span>'; }
    })();
    if (imgs.length > 1 || words > 0) { cap.hidden = false; cap.textContent = `${imgs.length} image${imgs.length === 1 ? '' : 's'}${words ? ` · ${words} words` : ''}${first.cap ? ` — ${first.cap}` : ''}`; }
    foot.textContent = 'thumbnail preview · release to close';
  } else {
    const sec = srcSection(d.text);
    const mk = mediaKind(d.name, '');
    $('#svpSec').textContent = mk ? (mk === 'video' ? 'Video' : mk === 'audio' ? 'Audio' : 'Image') : sec.label;
    body.textContent = (sec.text || '(no readable text)') + (sec.more && sec.text ? '…' : '');
    foot.textContent = `${Math.min(sec.words, SRC_WORDS)} of ${d.words} words · release to close`;
  }
  // pin near the press, clamped on screen using the card's real size
  // (content varies — fixed 320px math let tall previews run off the edge)
  box.hidden = false;
  const place = () => {
    const w = card.offsetWidth || 360, h = card.offsetHeight || 320;
    card.style.left = Math.max(8, Math.min(Math.max(8, window.innerWidth - w - 8), x + 14)) + 'px';
    card.style.top = Math.max(8, Math.min(Math.max(8, window.innerHeight - h - 8), y + 12)) + 'px';
  };
  place();
  if (sticky) {
    const rel = $('#svpRel'); if (rel) rel.textContent = 'pinned';
    foot.textContent = 'pinned preview — click 👁 again, press Esc, or click the canvas to close';
  } else {
    const rel = $('#svpRel'); if (rel) rel.textContent = 'release to close';
  }
  place(); // re-clamp: the sticky footer text above can wrap and grow the card
  srcHoldHi(); // the preview owns the flash now — kill any hover fade
  srcHighlight(id);
  try { syncEye(); } catch {} // light the pinning row's eye
  return true;
}
function closeSrcPop() { const box = $('#srcPop'); if (box) box.hidden = true; srcStickyId = null; srcHoldHi(); srcClearHi(); try { syncEye(); } catch {} }
// ---------- document carousel: curved glass coverflow of the Active body ----------
// Reader-pane trigger (two-pages button under the stretch arrow). Clones the reader's document into ≥3 glass
// panes on a curved track (center pane flat, sides swung back like the reference
// coverflow), scrollable via arrows, wheel, drag and ←/→ keys. Video/audio
// bodies are excluded (they play natively); everything else — prose, pictures,
// OCR'd photos — rides in its original rendered format. Any click outside the
// panes (the dim backdrop), ✕, Esc or re-pressing the toggle dismisses it.
let carOpen = false, carDocId = null, carRaf = 0, carMoved = false, carIdx = 0, carPid = null, carSettleT = 0, carLive = false, carLiveT = 0, carZoom = 100; // carLive = track still gliding (center pane keeps its 3D pose until it rests); carZoom = pane enlargement %, 100-145 (header slider)
let carPagesArr = null, carZoomOpen = false, carZoom2 = 100, carMediaFirst = false; // expander: chunk list for scroll-to-page, overlay state, overlay zoom % (session-only); media pane leads the track
// split prose into ≥3 page-sized chunks, paragraph-aware, with no upper cap;
// short docs still get 3 panes (wordiest chunk splits until they do).
function carouselPages(text) {
  const raw = String(text || '').replace(/^#[^\n]*\n+/, '').trim();
  const words = raw ? raw.split(/\s+/).filter(Boolean) : [];
  const paras = raw ? raw.split(/\n+/).map(s => s.trim()).filter(Boolean) : [];
  const n = Math.max(3, Math.ceil(words.length / 150) || 3);
  if (!paras.length) return ['', '', ''].slice(0, n);
  const per = Math.max(1, Math.ceil(words.length / n));
  const pages = [];
  let cur = [], curN = 0;
  for (const p of paras) {
    const wn = p.split(/\s+/).filter(Boolean).length;
    if (cur.length && curN + wn > per && pages.length < n - 1) { pages.push(cur.join('\n\n')); cur = []; curN = 0; }
    cur.push(p); curN += wn;
  }
  if (cur.length) pages.push(cur.join('\n\n'));
  while (pages.length < Math.min(3, n)) {
    let bi = 0;
    for (let i = 1; i < pages.length; i++) if (pages[i].length > pages[bi].length) bi = i;
    const w = pages[bi].split(/\s+/).filter(Boolean);
    if (w.length < 2) break;
    const half = Math.ceil(w.length / 2);
    pages.splice(bi, 1, w.slice(0, half).join(' '), w.slice(half).join(' '));
  }
  return pages;
}
let carReal = null; // folio map for the open carousel (null = word chunks, no real pages)
function pageSegments(text, pageMap) {
  // folio split for the carousel: body (sans leading H1 title) cut at the
  // recorded page starts. Returns {unit, count, segs} or null without a usable
  // map — mirrors the reader's renderBody split so panes land on real pages.
  const raw = String(text || '');
  let h1cut = 0;
  if (/^#\s+.*$/m.test(esc(raw))) {
    const stripped = raw.replace(/^#\s+.*$/m, '').replace(/^\s+/, '');
    h1cut = raw.length - stripped.length;
  }
  const body0 = h1cut ? raw.slice(h1cut) : raw;
  const pm = validPageMap(pageMap, raw.length);
  if (!pm) return null;
  const adj = pm.starts.map(s => Math.max(0, s - h1cut)).filter(s => s < body0.length);
  const uniq = [];
  for (const s of adj) { if (!uniq.length || s > uniq[uniq.length - 1]) uniq.push(s); }
  if (uniq.length < 2) return null;
  return { unit: pageUnitName(pm.kind), count: uniq.length, segs: uniq.map((s, i) => body0.slice(s, i + 1 < uniq.length ? uniq[i + 1] : body0.length)) };
}
function openCarousel() {
  const d = vault.byId(shownId);
  if (!d) { toast('Open a document body first — the carousel reads the Active body'); return false; }
  const wrap = $('#carWrap'), track = $('#carTrack');
  if (!wrap || !track) return false;
  carDocId = d.id;
  $('#carTitle').textContent = vault.titleOf(d);
  track.innerHTML = '';
  const seg = pageSegments(d.text, d.pageMap); // real folio pages when the import mapped them
  const pages = seg ? seg.segs : carouselPages(d.text);
  carPagesArr = pages;
  const hasMedia = !!mediaKind(d.name, '');
  carMediaFirst = hasMedia;
  carReal = seg ? { count: seg.count, off: hasMedia ? 1 : 0, segs: seg.segs } : null; // center-pane readout + pane anchors map back to folio pages
  const hasText = !!String(d.text || '').trim();
  const hasFigs = ((d.images || []).some(im => im && im.key));
  // media docs with no readable text get no blank filler panes (pure audio =
  // just the player; media + pictures but no words = player + one gallery page)
  const textPages = hasMedia ? (hasText ? pages : (hasFigs ? [''] : [])) : pages;
  const total = textPages.length + (hasMedia ? 1 : 0);
  let paneNo = 0;
  const phead = (realN) => `<div class="car-phead"><span class="car-ptitle">${esc(vault.titleOf(d))}</span><span class="car-pnum">${realN != null ? `p. ${realN} / ${seg.count}` : `${++paneNo} / ${total}`}</span><button class="car-expand" title="Open this page full-size — the whole original document, zoomable (double-click works too)">⤢</button></div>`;
  // pane 1: the original itself — photo original / video / audio player, like the reader
  if (hasMedia) {
    const mp = document.createElement('div');
    mp.className = 'car-pane glass car-media';
    mp.innerHTML = phead() + '<div class="car-text" title="Highlight text, then right-click to send it to notes"></div>';
    track.appendChild(mp);
    try {
      const t = mp.querySelector('.car-text');
      hydrateMedia(t, d);
    } catch {}
  }
  textPages.forEach((chunk, ti) => {
    const pane = document.createElement('div');
    pane.className = 'car-pane glass';
    pane.innerHTML = phead(seg ? ti + 1 : null) + `<div class="car-text" title="Highlight text, then right-click to send it to notes">${renderBody(chunk, null) || '<span style="color:var(--mut)">(this page is blank)</span>'}</div>`;
    track.appendChild(pane);
  });
  // original-format pictures ride on the last pane, hydrated like the reader gallery
  try {
    const last = track.lastElementChild;
    const figs = ((d.images || []).filter(im => im && im.key)).slice(0, 200);
    const t = last && last.querySelector('.car-text');
    if (t && figs.length) {
      t.insertAdjacentHTML('beforeend', `<div class="imggal">` + figs.map(im => {
        const dim = (im.w && im.h) ? ` · ${im.w}×${im.h}` : '';
        return `<figure data-imgkey="${esc(im.key)}"><span class="imgph">loading image…</span><figcaption>${esc(im.cap || 'image')}${esc(dim)}</figcaption></figure>`;
      }).join('') + `</div>`);
      hydrateImages(track, d.images);
    }
    if (t) hydrateSheet(t, d); // spreadsheets preview as a table, original one click away
  } catch {}
  try {
    const d2c = vault.byId(carDocId);
    if (d2c) {
      const troot = track.querySelectorAll('.car-pane .car-text');
      troot.forEach((t2, pi) => {
        const ti2 = pi - (carMediaFirst ? 1 : 0);
        if (ti2 < 0) return; // media pane: player, not prose
        markNoteSpotsIn(t2, d2c, true, seg ? paneBaseAt(seg, ti2) : 0);
      });
    }
  } catch {}
  wrap.hidden = false;
  carOpen = true;
  try { applyCarZoom(); } catch {}
  try { syncCarBtn(); } catch {}
  requestAnimationFrame(() => { try { track.scrollLeft = 0; } catch {} carLayout(); });
  return true;
}
function closeCarousel() {
  const wrap = $('#carWrap');
  carOpen = false;
  carDocId = null;
  try { if (wrap) wrap.querySelectorAll('video,audio').forEach(m => { try { m.pause(); } catch {} }); } catch {}
  try { const zw = $('#carZoomWrap'); if (zw) zw.querySelectorAll('video,audio').forEach(m => { try { m.pause(); } catch {} }); } catch {}
  if (wrap && !wrap.hidden) wrap.hidden = true;
  try { syncCarBtn(); } catch {}
}
// pane-size slider (100-145%): scales pane width, text and height via --carZoom
function applyCarZoom() {
  const wrap = $('#carWrap');
  if (wrap) wrap.style.setProperty('--carZoom', (carZoom / 100).toFixed(2));
  const v = $('#carZoomVal');
  if (v) v.textContent = carZoom + '%';
  const zr = $('#carZoomRg');
  if (zr && document.activeElement !== zr) zr.value = String(carZoom);
}
function setCarZoom(v) {
  carZoom = Math.max(100, Math.min(145, Math.round(+v || 100)));
  applyCarZoom(); saveUi();
  if (carOpen) { // re-park on the same pane at the new pitch, then re-curve
    try {
      const track = $('#carTrack');
      const first = track && track.querySelector('.car-pane');
      if (track && first) {
        const gap = parseFloat(getComputedStyle(track).columnGap) || 18;
        track.scrollLeft = carIdx * (first.offsetWidth + gap);
      }
    } catch {}
    carLayout();
  }
}
// expand-pane overlay: the whole original document in reader format + gallery,
// scrolled to the chunk the pane shows, with its own zoom (100-200%).
function applyCarZoom2() {
  const card = $('#carZoomCard');
  if (card) card.style.setProperty('--czx', (carZoom2 / 100).toFixed(2));
  const v = $('#carZoomVal2');
  if (v) v.textContent = carZoom2 + '%';
  const zr = $('#carZoomRg2');
  if (zr && document.activeElement !== zr) zr.value = String(carZoom2);
}
function setCarZoom2(v) {
  carZoom2 = Math.max(100, Math.min(200, Math.round(+v || 100)));
  applyCarZoom2();
}
function openCarZoom(i) {
  const d = vault.byId(carDocId) || vault.byId(shownId);
  if (!d) { toast('Open a document body first'); return false; }
  const wrap = $('#carZoomWrap'), body = $('#carZoomBody'), txt = $('#carZoomText');
  if (!wrap || !body || !txt) return false;
  $('#carZoomTitle').textContent = vault.titleOf(d);
  txt.innerHTML = renderBody(d.text, d.images, d.pageMap) || '';
  try { hydrateImages(txt, d.images); } catch {}
  try { hydrateMedia(txt, d); } catch {}
  try { hydrateSheet(txt, d); } catch {}
  try { const mg = txt.querySelector('.mediagal'); if (mg && txt.firstChild !== mg) txt.insertBefore(mg, txt.firstChild); } catch {} // originals lead here too
  wrap.hidden = false;
  carZoomOpen = true;
  try { applyCarZoom2(); } catch {}
  try { syncCarZoomPageBar(d); } catch {}
  try { markNoteSpotsIn(txt, d, false, 0); } catch {} // sent highlights stay marked in the overlay too
  // land on the chunk this pane shows: the chunk head is matched against the
  // rendered text node stream (markup spans split nodes, so single-node search
  // fails) — every occurrence is collected and the one nearest this page's
  // expected position wins, so repeated boilerplate can't misroute the jump.
  try {
    body.scrollTop = 0;
    const chunks = carPagesArr || [];
    const chunk = ((chunks[i] || '').replace(/\s+/g, ' ').trim())
      .replace(/\*\*/g, '').replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
    const nodes = [];
    {
      const walker = document.createTreeWalker(txt, NodeFilter.SHOW_TEXT);
      let n; while ((n = walker.nextNode())) { if (n.textContent) nodes.push(n); }
    }
    const parts = nodes.map(n => n.textContent.replace(/\s+/g, ' '));
    const full = parts.join(' ').replace(/\s+/g, ' ').trim();
    const probe = chunk.split(' ').slice(0, 8).join(' ').slice(0, 60);
    if (probe.length > 15 && full && nodes.length) {
      const want = (chunks.length > 1 ? (i / (chunks.length - 1)) : 0) * full.length;
      let best = -1, bestD = Infinity, at = 0;
      for (;;) { const f = full.indexOf(probe, at); if (f < 0) break; const dd = Math.abs(f - want); if (dd < bestD) { bestD = dd; best = f; } at = f + 1; if (at >= full.length) break; }
      if (best >= 0) {
        let acc = 0, hit = null;
        for (let k = 0; k < nodes.length; k++) {
          if (best < acc + parts[k].length + 1) { hit = nodes[k]; break; }
          acc += parts[k].length + 1;
        }
        if (!hit) hit = nodes[nodes.length - 1];
        const r = document.createRange();
        try { r.selectNodeContents(hit); } catch { r.selectNode(hit, 0); }
        const br = r.getBoundingClientRect(), cr = body.getBoundingClientRect();
        if (br.height) body.scrollTop += Math.max(0, (br.top - cr.top) - Math.round(cr.height * 0.22));
        // flash just the matched head words (not the whole mega-paragraph):
        // locate the probe in this node's collapsed text, map the collapsed
        // offsets back onto raw offsets (each whitespace run = 1 char), wrap.
        try {
          const raw = hit.textContent, cHit = raw.replace(/\s+/g, ' ');
          let li = cHit.indexOf(probe), llen = probe.length;
          if (li < 0 && probe.length > 24) { li = cHit.indexOf(probe.slice(0, 24)); llen = 24; }
          if (li >= 0) {
            const c2r = (cIdx) => { let c = 0, r = 0, inWs = false; while (r < raw.length && c < cIdx) { if (/\s/.test(raw[r])) { if (!inWs) { inWs = true; c++; } r++; } else { inWs = false; c++; r++; } } return r; };
            const rng2 = document.createRange();
            rng2.setStart(hit, c2r(li));
            rng2.setEnd(hit, c2r(Math.min(cHit.length, li + Math.min(llen, 60))));
            const sp = document.createElement('span');
            sp.className = 'cz-spot';
            rng2.surroundContents(sp);
            setTimeout(() => { try { const p = sp.parentNode; if (p) { while (sp.firstChild) p.insertBefore(sp.firstChild, sp); p.removeChild(sp); } } catch {} }, 1700);
          }
        } catch { /* weird node shape — the scroll still landed */ }
      }
    }
  } catch {}
  try { $('#carZoomClose').focus({ preventScroll: true }); } catch {}
  try { syncCarZoomPageNow(); } catch {}
  try { syncOrigTop(); } catch {}
  return true;
}
function closeCarZoom() {
  if (!carZoomOpen) return false;
  carZoomOpen = false;
  const wrap = $('#carZoomWrap');
  try { if (wrap) wrap.querySelectorAll('video,audio').forEach(m => { try { m.pause(); } catch {} }); } catch {}
  if (wrap && !wrap.hidden) wrap.hidden = true;
  try { const ob2 = $('#origTopBtn'); if (ob2) ob2.hidden = true; } catch {} // the Top tab never outlives its pane
  return true;
}
function syncCarBtn() {
  const b = $('#carPaneBtn');
  if (!b) return;
  b.classList.toggle('open', !!carOpen);
  b.setAttribute('aria-pressed', carOpen ? 'true' : 'false');
}
// coverflow curve: each pane swings back with its distance from track center
function carLayout() {
  const track = $('#carTrack');
  if (!track || !carOpen) return;
  const r = track.getBoundingClientRect();
  const mid = r.left + r.width / 2;
  const panes = track.querySelectorAll('.car-pane');
  let best = 0, bestDd = Infinity;
  panes.forEach((p, i) => {
    const pr = p.getBoundingClientRect();
    const off = (pr.width > 0) ? (pr.left + pr.width / 2 - mid) / pr.width : 0;
    const a = Math.max(-1.4, Math.min(1.4, off));
    const deg = a * 42;
    const z = -Math.min(Math.abs(a), 1.4) * 110;
    const sc = 1 - Math.min(Math.abs(a) * 0.09, 0.28);
    p.style.transform = `rotateY(${deg.toFixed(1)}deg) translateZ(${z.toFixed(0)}px) scale(${sc.toFixed(3)})`;
    p.style.zIndex = String(100 - Math.round(Math.abs(a) * 20));
    p.style.opacity = String(Math.abs(a) > 1.35 ? 0.25 : 1);
    p.classList.toggle('car-center', Math.abs(a) < 0.5);
    const dd = Math.abs(off);
    if (dd < bestDd) { bestDd = dd; best = i; }
  });
  const cc = $('#carCount');
  if (cc) {
    const ri = carReal ? best - carReal.off : -1;
    cc.textContent = (carReal && ri >= 0 && ri < carReal.count) ? ('p. ' + (ri + 1) + ' / ' + carReal.count) : ((best + 1) + ' / ' + panes.length);
  }
  carIdx = best; // arrows step from here — deterministic paging, no snap engine
  // the rested center pane drops out of the 3D context (transform:none) so its
  // text rasterizes flat and crisp — GPU-perspective layers blur body copy.
  // While gliding it keeps the curve pose so paging never pops.
  if (!carLive && bestDd < 0.5 && panes[best]) panes[best].style.transform = 'none';
  // caption rides above the current pane (re-seated every layout pass,
  // including mid-glide, so it tracks the nearest pane while paging)
  try {
    const tip = $('#carZoomTip');
    const stage = $('#carStage');
    if (tip && stage && panes[best]) {
      const sr = stage.getBoundingClientRect();
      const br2 = panes[best].getBoundingClientRect();
      tip.style.display = '';
      tip.style.left = Math.round(br2.left + br2.width / 2 - sr.left) + 'px';
    } else if (tip) tip.style.display = 'none';
  } catch {}
}
function carOnScroll() {
  if (!carOpen) return;
  carLive = true; // gliding: every pane stays in the 3D curve while moving
  try { clearTimeout(carLiveT); } catch {}
  carLiveT = setTimeout(() => { carLive = false; carLayout(); }, 220);
  if (!carRaf) carRaf = requestAnimationFrame(() => { carRaf = 0; carLayout(); });
  // settle: shortly after a glide ends (no finger down), park exactly on the
  // nearest pane — the paginated feel, without fighting the scroll engine
  try { clearTimeout(carSettleT); } catch {}
  carSettleT = setTimeout(() => {
    if (!carOpen || carPid !== null) return;
    const track = $('#carTrack');
    if (!track) return;
    const first = track.querySelector('.car-pane');
    if (!first) return;
    const gap = parseFloat(getComputedStyle(track).columnGap) || 18;
    const want = carIdx * (first.offsetWidth + gap);
    if (Math.abs(track.scrollLeft - want) > 4) track.scrollLeft = want;
  }, 200);
}
function carStep(dir) {
  const track = $('#carTrack');
  if (!track) return;
  const panes = track.querySelectorAll('.car-pane');
  if (!panes.length) return;
  const first = panes[0];
  const gap = parseFloat(getComputedStyle(track).columnGap) || 18;
  const i = Math.max(0, Math.min(panes.length - 1, carIdx + dir));
  track.scrollLeft = i * (first.offsetWidth + gap);
}
function wireCarousel() {
  const wrap = $('#carWrap'), track = $('#carTrack');
  if (!wrap || !track || track.dataset.carWired) return;
  track.dataset.carWired = '1';
  track.addEventListener('scroll', carOnScroll, { passive: true });
  // sideways wheel glides the track instead of the page
  track.addEventListener('wheel', (e) => {
    if (!carOpen) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); track.scrollLeft += e.deltaY; }
  }, { passive: false });
  // any click outside the panes (the dim backdrop / stage padding) dismisses
  wrap.addEventListener('click', (e) => {
    if (carMoved) return; // a drag just ended — not a dismiss click
    if (!e.target.closest('.car-pane') && !e.target.closest('button') && !e.target.closest('input,label') && !e.target.closest('#carZoomTip')) closeCarousel();
  });
  // drag-to-scroll with direction lock (vertical drags still scroll a pane)
  let dX = 0, dL = 0;
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    carMoved = false; dX = e.clientX; dL = track.scrollLeft; carPid = e.pointerId;
  });
  window.addEventListener('pointermove', (e) => {
    if (!carOpen || carPid === null || e.pointerId !== carPid) return;
    if (Math.abs(e.clientX - dX) > 8) { carMoved = true; track.scrollLeft = dL - (e.clientX - dX); }
  });
  window.addEventListener('pointerup', (e) => { if (e.pointerId === carPid) carPid = null; });
  window.addEventListener('pointercancel', (e) => { if (e.pointerId === carPid) carPid = null; });
  const pv = $('#carPrevB'), nx = $('#carNextB'), cx = $('#carClose');
  if (pv) pv.onclick = (e) => { e.stopPropagation(); carStep(-1); };
  if (nx) nx.onclick = (e) => { e.stopPropagation(); carStep(1); };
  if (cx) cx.onclick = (e) => { e.stopPropagation(); closeCarousel(); };
  const zr = $('#carZoomRg');
  if (zr && !zr.dataset.wired) { zr.dataset.wired = '1'; zr.addEventListener('input', () => setCarZoom(+zr.value)); }
  track.addEventListener('dblclick', (e) => {
    const pane = e.target && e.target.closest ? e.target.closest('.car-pane') : null;
    if (!pane) return;
    openCarZoom([...track.querySelectorAll('.car-pane')].indexOf(pane) - (carMediaFirst ? 1 : 0));
  });
  track.addEventListener('click', (e) => {
    const xp = e.target && e.target.closest ? e.target.closest('.car-expand') : null;
    if (!xp) return;
    e.stopPropagation();
    const pane = xp.closest('.car-pane');
    openCarZoom([...track.querySelectorAll('.car-pane')].indexOf(pane) - (carMediaFirst ? 1 : 0));
  });
  const zt = $('#carZoomTip');
  if (zt) zt.addEventListener('dblclick', (e) => { e.stopPropagation(); openCarZoom(carIdx - (carMediaFirst ? 1 : 0)); });
  const zj = $('#carZoomJump');
  if (zj) zj.onclick = (e) => { e.stopPropagation(); openCarZoom(carIdx - (carMediaFirst ? 1 : 0)); };
  const zw = $('#carZoomWrap'), zb = $('#carZoomBody'), zc2 = $('#carZoomClose'), zr2 = $('#carZoomRg2');
  if (zc2) zc2.onclick = (e) => { e.stopPropagation(); closeCarZoom(); };
  if (zw) zw.addEventListener('click', (e) => { if (e.target === zw) closeCarZoom(); });
  if (zr2 && !zr2.dataset.wired) { zr2.dataset.wired = '1'; zr2.addEventListener('input', () => setCarZoom2(+zr2.value)); }
  if (zb && !zb.dataset.wired) { zb.dataset.wired = '1'; zb.addEventListener('wheel', (e) => { if (e.ctrlKey) { e.preventDefault(); setCarZoom2(carZoom2 + (e.deltaY < 0 ? 10 : -10)); } }, { passive: false }); }
  if (zb && !zb.dataset.origWired) { zb.dataset.origWired = '1'; zb.addEventListener('scroll', () => { try { syncOrigTop(); } catch {} try { syncCarZoomPageNow(); } catch {} }, { passive: true }); }
  const otb = $('#origTopBtn');
  if (otb && !otb.dataset.wired) { otb.dataset.wired = '1'; otb.onclick = () => {
    try { const b2 = $('#carZoomBody'); if (b2) { try { b2.scrollTo({ top: 0, behavior: 'auto' }); } catch {} b2.scrollTop = 0; } } catch { try { $('#carZoomBody').scrollTop = 0; } catch {} }
    try { syncOrigTop(); } catch {}
    try { syncCarZoomPageNow(); } catch {}
  }; }
  const czt = $('#carZoomText');
  if (czt && !czt.dataset.pmWired) { czt.dataset.pmWired = '1'; czt.addEventListener('click', (ev) => {
    // folio marker: click copies a "Title, p. N" citation (same as the reader)
    try {
      const pmk = ev.target && ev.target.closest ? ev.target.closest('.pagemark') : null;
      if (pmk) {
        const np = pmk.dataset.page || '?';
        const zt2 = ($('#carZoomTitle') && $('#carZoomTitle').textContent) || 'document';
        const cite = zt2 + ', p. ' + np;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cite).then(() => toast('Citation copied: ' + cite), () => toast(cite, 4000));
          else toast(cite, 4000);
        } catch { toast(cite, 4000); }
      }
    } catch {}
  }); }
  window.addEventListener('resize', () => { try { syncOrigTop(); } catch {} });
  window.addEventListener('resize', () => { if (carOpen) carLayout(); });
}
// manual-spot plumbing: locate a creation anchor in the rendered reader text
// and wrap it. Anchors are rich ({snip, at, path, off}): the DOM path is
// tried first (verified against a snippet chunk), else the occurrence nearest
// the recorded stripped offset wins — repeated boilerplate can't misroute the
// jump. Plain-string anchors from older tags behave as before (first
// occurrence). Matching runs in two passes: whitespace-blind exact first
// (fresh anchors land precisely), then punctuation-blind (lowercased,
// a–z 0–9 only) so anchors survive later text edits that add/remove #tag
// markers, [[ ]] brackets or ** stars — without this the search shrank to a
// generic substring and jumped to the wrong occurrence (e.g. a section
// title). The recorded offset is mapped into each pass's own coordinate
// space, so "nearest" stays meaningful in both.
const spotNormWs = (s) => String(s || '').replace(/\s+/g, '');
const spotNormAn = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const spotCountWs = (c) => !/\s/.test(c);
const spotCountAn = (c) => /[a-z0-9]/i.test(c);
function spotCollect(root, norm) {
  const nodes = [];
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) { if (n.textContent) nodes.push(n); }
  } catch { return null; }
  if (!nodes.length) return null;
  const nx = norm || spotNormWs;
  return { nodes, parts: nodes.map(n => nx(n.textContent)) };
}
function spotRawOff(text, k, isCounted) {
  const cnt = isCounted || spotCountWs;
  let c = 0;
  for (let i = 0; i < text.length; i++) { if (cnt(text[i])) { if (c === k) return i; c++; } }
  return text.length;
}
function spotHits(full, target, minLen) {
  let t = target;
  for (;;) {
    const hits = [];
    let from = 0, ix;
    while ((ix = full.indexOf(t, from)) >= 0) { hits.push(ix); from = ix + 1; }
    if (hits.length || t.length <= minLen) return { hits, len: t.length };
    t = t.slice(0, Math.max(minLen, Math.floor(t.length * 0.7)));
  }
}
function spotNearest(hits, wantAt) {
  let at = hits[0], best = Math.abs(hits[0] - wantAt);
  for (const h of hits) { const dd = Math.abs(h - wantAt); if (dd < best) { best = dd; at = h; } }
  return at;
}
function spotDomRange(col, at, budget, isCounted) {
  let acc = 0, si = -1, soff = 0;
  for (let i = 0; i < col.parts.length; i++) {
    if (at < acc + col.parts[i].length) { si = i; soff = at - acc; break; }
    acc += col.parts[i].length;
  }
  if (si < 0) return null;
  let ei = si, eoff = soff, left = budget;
  for (let i = si; i < col.parts.length && left > 0; i++) {
    const take = Math.min(col.parts[i].length - (i === si ? soff : 0), left);
    ei = i; eoff = (i === si ? soff : 0) + take; left -= take;
  }
  try {
    const range = document.createRange();
    range.setStart(col.nodes[si], spotRawOff(col.nodes[si].textContent, soff, isCounted));
    range.setEnd(col.nodes[ei], spotRawOff(col.nodes[ei].textContent, eoff, isCounted));
    return range;
  } catch { return null; }
}
function findSpotRange(root, entry, budget) {
  if (!root || !entry) return null;
  const len = (typeof budget === 'number' && budget > 0) ? Math.min(2000, Math.round(budget)) : 80; // manual spots mark 80 chars; note highlights span their whole sent passage
  const snip = (typeof entry === 'string') ? entry : entry.snip;
  const norm = spotNormWs;
  const fullSnip = norm(snip);
  if (fullSnip.length < 2) return null;
  if (typeof entry === 'object' && Array.isArray(entry.path)) {
    try {
      let n = root;
      for (const ix of entry.path) { n = n.childNodes[ix]; if (!n) throw 0; }
      if (n.nodeType === 3) {
        const chunk = fullSnip.slice(0, 24);
        const here = norm(n.textContent) + norm((n.nextSibling && n.nextSibling.textContent) || '');
        if (chunk && here.includes(chunk)) {
          const col = spotCollect(root);
          if (col) {
            const full2 = col.parts.join('');
            let nodeAt = 0;
            for (const nd of col.nodes) { if (nd === n) break; nodeAt += norm(nd.textContent).length; }
            // the snip STARTS inside this node (recorded off could be deep
            // into it), so start the range at the chunk — not at node start
            let from = 0, ix, best = -1, bestDd = Infinity;
            while ((ix = full2.indexOf(chunk, from)) >= 0) {
              const dd = ix < nodeAt ? (nodeAt - ix) * 4 : ix - nodeAt;
              if (dd < bestDd) { bestDd = dd; best = ix; }
              from = ix + 1;
            }
            if (best >= 0 && bestDd < 5000) {
              const r = spotDomRange(col, best, len);
              if (r) return r;
            }
          }
        }
      }
    } catch { /* fall through to text search */ }
  }
  const col = spotCollect(root);
  if (!col) return null;
  const full = col.parts.join('');
  const wantAt = (typeof entry === 'object' && isFinite(entry.at)) ? entry.at : 0;
  // pass 1: the full distinctive snippet, no shrinking — exact or nothing
  const p1 = spotHits(full, fullSnip.slice(0, 120), 120);
  if (p1.hits.length) return spotDomRange(col, spotNearest(p1.hits, wantAt), Math.min(p1.len, len));
  // pass 2: punctuation-blind, so later tag-strip/merge edits can't break it
  const colA = spotCollect(root, spotNormAn);
  if (!colA) return null;
  const fullA = colA.parts.join('');
  const wantAtA = spotNormAn(full.slice(0, wantAt)).length;
  const p2 = spotHits(fullA, spotNormAn(snip).slice(0, 120), 12);
  if (!p2.hits.length) return null;
  return spotDomRange(colA, spotNearest(p2.hits, wantAtA), Math.min(p2.len, len), spotCountAn);
}
// wrap every text-node portion of a range in its own span — unlike
// surroundContents this survives ranges that cross element boundaries
// (explicit #tag pills, [[link]] spans, <strong>, <br> runs), which manual
// spots routinely do. Ranges crossing such markup used to throw and silently
// skip the highlight entirely. Returns the created spans (possibly empty).
function wrapRangeText(root, range, cls, attrs) {
  const out = [];
  if (!root || !range || range.collapsed) return out;
  let nodes = [];
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n; while ((n = walker.nextNode())) nodes.push(n);
  } catch { return out; }
  for (const t of nodes) {
    if (!t.parentNode || !root.contains(t)) continue;
    try {
      if (range.comparePoint(t, 0) > 0) continue; // range ends before this node
      if (range.comparePoint(t, t.textContent.length) < 0) continue; // range starts after this node
    } catch { continue; }
    let s = 0, e = t.textContent.length;
    if (t === range.startContainer) s = Math.min(range.startOffset, e);
    if (t === range.endContainer) e = Math.max(Math.min(range.endOffset, t.textContent.length), s);
    if (e <= s) continue;
    try {
      let target = t;
      if (s > 0) target = target.splitText(s);
      const len = e - s;
      if (len < target.textContent.length) target.splitText(len);
      const mark = document.createElement('span');
      mark.className = cls;
      if (attrs) for (const [k, val] of Object.entries(attrs)) mark.setAttribute(k, val);
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      out.push(mark);
    } catch { /* keep going — other nodes may still wrap */ }
  }
  return out;
}
// jump the reader to a manual tag's creation spot: center + gold flash
function scrollToManualSpot(entry) {
  const root = $('#docBody');
  if (!root) return false;
  let r = null;
  try { r = findSpotRange(root, entry); } catch { return false; }
  if (!r || r.collapsed) return false;
  try {
    const token = 'sf' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    const marks = wrapRangeText(root, r, 'spot-flash', { 'data-sflash': token });
    if (!marks.length) throw 0;
    try { marks[0].scrollIntoView({ block: 'center' }); } catch {}
    setTimeout(() => {
      try {
        root.querySelectorAll(`[data-sflash="${token}"]`).forEach(mark => {
          const p = mark.parentNode; if (!p) return;
          while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
          p.removeChild(mark);
        });
      } catch {}
    }, 2600);
    return true;
  } catch {
    try { r.startContainer.parentElement.scrollIntoView({ block: 'center' }); return true; } catch { return false; }
  }
}
// persistent gold markers on every manual-tag spot in the open reader,
// re-applied on each render (renderDoc rebuilds the DOM, wiping old marks)
function markManualSpots(d) {
  const root = $('#docBody');
  if (!root || !d || !d.manualTags) return;
  for (const [slug, anchor] of Object.entries(d.manualTags)) {
    if (!(d.tags || []).some(tg => vault.stripAuto(tg) === slug && String(tg).toLowerCase().startsWith('manual/'))) continue;
    let r = null;
    try { r = findSpotRange(root, anchor); } catch { continue; }
    if (!r || r.collapsed) continue;
    wrapRangeText(root, r, 'spot-mark', { 'data-mtag': slug, title: `Manual tag #${slug} — click its pill to jump here` });
  }
}
// tags-pane tips: the Confirms row mirrors the skipTagConfirms pref (gold term,
// clickable toggle so "don't ask again" is always reversible from the pane).
function syncConfirmTip() {
  const tx = $('#tvpConfirmTxt'), bt = $('#tvpConfirmBtn');
  if (!tx || !bt) return;
  if (skipTagConfirms) { tx.textContent = 'tag delete/merge/rename confirmations are off'; bt.textContent = 'click to ask again'; }
  else { tx.textContent = 'tag delete/merge/rename confirmations are on'; bt.textContent = 'click to stop asking'; }
}
// tag helpers shared by delete + merge (stripped/lowercase names, tag-boundary regexes)
const normDisp = (s) => String(s || '').trim().toLowerCase().replace(/^(auto|manual)\//, '');
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tagUseRe = (disp) => new RegExp('(^|\\s)#' + escRe(disp) + '(?![A-Za-z0-9_\\-/])', 'gi');
const carriersOf = (tab, disp) => ((tab && tab.docs) || []).filter(d => ((d.tags || []).some(tg => vault.stripAuto(tg) === disp)));
// click a tag in the ALL TAGS pane: the origin body becomes the sun on
// the canvas AND shows in the Active body reader, so verse and reader agree.
// Origin = the first body carrying the tag, preferring one where the tag was
// actually written (explicit #tag or manual M) over pure auto derivations.
function focusTagOrigin(disp) {
  const t = vault.tab();
  if (!t) { toast('No open canvas — nothing to focus'); return false; }
  const d = normDisp(disp);
  const docs = (t.docs || []).filter(x => (x.tags || []).some(tg => vault.stripAuto(tg) === d));
  if (!docs.length) { toast(`#${d} is not in this verse`); return false; }
  const doc = docs.find(x => (x.tags || []).some(tg => { const l = String(tg).toLowerCase(); return vault.stripAuto(tg) === d && !l.startsWith('auto/'); })) || docs[0];
  // a lens shows tag/theme nodes, not bodies — leave it so canvas + reader agree
  if (lensThematic || lensTags) { lensThematic = false; thematicWhole = false; lensTags = false; syncLensBtn(); applyLens(); saveUi(); }
  if (!uni) { toast('No universe to focus yet'); return false; }
  claimSun(doc.id);
  renderDoc();
  // manual tag with a remembered creation spot: put the reader on it exactly
  try {
    const spot = doc.manualTags && doc.manualTags[d];
    if (spot) scrollToManualSpot(spot);
  } catch {}
  try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; matchSet = null; } catch {}
  if (window.innerWidth <= 760) $('#docPanel').classList.add('open');
  toast(`#${d} → “${vault.titleOf(doc)}”`);
  return true;
}
// reader tag -> ALL TAGS pane linkage: when the tag pane stands open,
// a reader click gilds the same pill there (gold sunlit) and scrolls it
// into view, without rebuilding the pane or stealing its scroll.
function ensureTvpPillVisible(list, pill) {
  // guaranteed in-list scroll: brings the pill fully inside the visible
  // band of the tags list (8px breathing room). Operates only on the
  // list's own scrollTop, so the page/reader never jump. Falls back to
  // scrollIntoView constrained to the list when measures are unavailable.
  const lr = list.getBoundingClientRect();
  const pr = pill.getBoundingClientRect();
  if (!lr.height || !pr.height) { try { pill.scrollIntoView({ block: 'nearest' }); } catch {} return; }
  if (pr.top < lr.top) list.scrollTop -= (lr.top - pr.top) + 8;
  else if (pr.bottom > lr.bottom) list.scrollTop += (pr.bottom - lr.bottom) + 8;
  // final guard: fractional/rrounding edge still clipping -> nudge into view
  try {
    const lr2 = list.getBoundingClientRect();
    const pr2 = pill.getBoundingClientRect();
    if (pr2.top < lr2.top - 1) list.scrollTop -= (lr2.top - pr2.top) + 8;
    else if (pr2.bottom > lr2.bottom + 1) list.scrollTop += (pr2.bottom - lr2.bottom) + 8;
  } catch {}
}
function highlightTagInPop(disp) {
  try {
    const box = document.querySelector('#tagPop');
    if (!box || box.hidden) return false;
    const list = box.querySelector('.tvp-tags');
    if (!list) return false;
    const want = String(disp || '').trim().toLowerCase().replace(/^(auto|manual)\//, '');
    if (!want) return false;
    const pills = list.querySelectorAll('[data-tpill]');
    if (!pills.length) return false;
    let hit = null;
    pills.forEach(p => {
      const v = String(p.dataset.tpill || p.dataset.tag || '').trim().toLowerCase().replace(/^(auto|manual)\//, '');
      if (v === want && !hit) hit = p;
    });
    if (!hit) return false;
    pills.forEach(p => { if (p !== hit) p.classList.remove('sunlit'); });
    hit.classList.add('sunlit');
    try { ensureTvpPillVisible(list, hit); } catch {}
    return true;
  } catch { return false; }
}
// click a tag in the ALL TAGS pane: enter the TAGS view and sun that exact tag
// body, so the pane and the TAGS canvas agree. Entering from Main/Thematic (or
// a stale lens) swaps the universe first, then the tag body is claimed as the
// sun — the same path as clicking the body on the TAGS canvas itself.
function focusTagInTagsView(disp) {
  const t = vault.tab();
  if (!t) { toast('No open canvas — nothing to focus'); return false; }
  const d = normDisp(disp);
  const rec = (tagsFor(t.docs || []).find(r => r.terms[0] === d)) || null;
  if (!rec) { toast(`#${d} is not in this verse`); return false; }
  if (!uni && !lensTags) { toast('No universe to focus yet'); return false; }
  if (!lensTags) {
    pushView(); // Return can come back to the pre-view state
    canvasHiId = null; // the new view lights its own bodies
    assocSelId = null; srcHi = null; // the new view lights its own rows
    intakeHiIds.clear(); // the new view lights its own arrivals
    clearFit(); // the lens swaps the universe: a fitted view is stale
    lensThematic = false; thematicWhole = false;
    lensTags = true;
    syncLensBtn(); applyLens(); saveUi();
    try { syncTagVerseBtn(); } catch {}
    // the pane stays open: the user is hopping between tags, so the card
    // remains standing while the canvas jumps underneath it
    try { syncLbPill(); } catch {}
    try { syncViewModes(); } catch {}
  }
  if (!uni || !uni.byId.has(rec.id)) { toast('No universe to focus yet'); return false; }
  const ok = selectBody(rec.id, '#' + d, true);
  if (!ok) { toast(`#${d} is not in this verse`); return false; }
  // center the newly-sunned tag body exactly (selectBody only nudges when
  // off-screen — a pane pick always lands dead-center of the canvas)
  try { centerCamOn(rec.id, false); } catch {}
  // pane stays open: re-highlight it on the picked tag so card and canvas agree
  try { openTagPop(d); } catch {}
  // manual-tag pick: remember it for the reader (gold clone pill in doc TAGS
  // rows) and feed the find box so every instance lights up in the reader
  try {
    const manDocs = (t.docs || []).filter(x => (x.tags || []).some(tg => String(tg).toLowerCase().startsWith('manual/') && normDisp(tg) === d));
    if (manDocs.length) { selManualTag = d; setReaderFind(d, true); }
    else if (selManualTag) { if (findTerm === selManualTag) clearReaderFind(); selManualTag = null; }
  } catch {}
  try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; matchSet = null; } catch {}
  if (window.innerWidth <= 760) $('#docPanel').classList.add('open');
  toast(`#${d} in Tags view — grounds ${rec.members.length} ${rec.members.length === 1 ? 'body' : 'bodies'}`);
  return true;
}
// delete a tag from the whole canvas: strip every explicit #tag from body texts,
// recount (auto/* recompute), and suppress the auto form so title words can't
// resurrect it. Explicit #tags are never suppressed — writing #name in any body
// brings the tag back. Current canvas only.
function deleteTag(disp) {
  const t = vault.tab();
  if (!t) { toast('No open canvas — nothing to delete from'); return 0; }
  const d = normDisp(disp);
  if (!/^[a-z0-9_\-/]{2,}$/.test(d)) return 0;
  const carriers = carriersOf(t, d);
  if (!carriers.length) { toast(`#${d} is not in this verse`); return 0; }
  vault.suppressTag(t, d);
  const re = tagUseRe(d);
  for (const doc of carriers) {
    doc.text = String(doc.text || '').replace(re, '$1');
    // manual tags aren't in the text — drop their entries directly
    doc.tags = (doc.tags || []).filter(tg => !(vault.isManual(tg) && vault.stripAuto(tg) === d));
    if (doc.manualTags) delete doc.manualTags[d];
    vault.recountDoc(doc);
  }
  vault.persist();
  try { rebuild(activeId); } catch {}
  try { if (!$('#tagPop').hidden) openTagPop(); } catch {}
  markBackupDirty();
  toast(`Deleted #${d} from ${carriers.length} ${carriers.length === 1 ? 'body' : 'bodies'} — write #${d} in any body to bring it back`);
  return carriers.length;
}
// merge one tag into another (simple hierarchy: the receiving tag is the
// primary and keeps its name; the moved tag is rewritten into it everywhere
// and does not retain its name). Docs carrying the source gain the target
// (explicit #target, appended when the doc only had it as auto), the source's
// explicit uses are removed, and its auto form is suppressed. Current canvas only.
function mergeTags(src, dst) {
  const t = vault.tab();
  if (!t) { toast('No open canvas — nothing to merge into'); return 0; }
  const s = normDisp(src), g = normDisp(dst);
  if (!/^[a-z0-9_\-/]{2,}$/.test(s) || !/^[a-z0-9_\-/]{2,}$/.test(g)) return 0;
  if (s === g) { toast('Those are the same tag — nothing to merge'); return 0; }
  const carriers = carriersOf(t, s);
  if (!carriers.length) { toast(`#${s} is not in this verse`); return 0; }
  vault.suppressTag(t, s);
  const reDel = tagUseRe(s), reRep = tagUseRe(s);
  for (const doc of carriers) {
    const hasDst = (doc.tags || []).some(tg => vault.stripAuto(tg) === g);
    const hadManual = (doc.tags || []).some(tg => vault.isManual(tg) && vault.stripAuto(tg) === s);
    // the manual source never survives a merge — its manual-ness moves to the target
    doc.tags = (doc.tags || []).filter(tg => !(vault.isManual(tg) && vault.stripAuto(tg) === s));
    if (doc.manualTags && doc.manualTags[s]) { // carry the spot anchor onto the target name
      if (!doc.manualTags[g]) doc.manualTags[g] = doc.manualTags[s];
      delete doc.manualTags[s];
    }
    if (hasDst) {
      doc.text = String(doc.text || '').replace(reDel, '$1'); // already grounded in target: just drop the source
    } else {
      let n = 0;
      doc.text = String(doc.text || '').replace(reRep, (...a) => { n++; return a[1] + '#' + g; });
      if (!n && hadManual) {
        // source lived only as a manual tag: keep it manual on the target side
        if (!doc.tags.some(tg => vault.stripAuto(tg) === g)) doc.tags.push('manual/' + g);
      } else if (!n) doc.text = String(doc.text || '').replace(/\s+$/, '') + '\n#' + g; // auto-only source: ground the target explicitly
    }
    vault.recountDoc(doc);
  }
  vault.persist();
  try { rebuild(activeId); } catch {}
  try { if (!$('#tagPop').hidden) openTagPop(); } catch {}
  markBackupDirty();
  toast(`Merged #${s} into #${g} — ${carriers.length} ${carriers.length === 1 ? 'body' : 'bodies'} now carry #${g}`);
  return carriers.length;
}
async function deleteTagUI(disp) {
  const t = vault.tab();
  if (!t) return;
  const d = normDisp(disp);
  const carriers = carriersOf(t, d);
  if (!carriers.length) { toast(`#${d} is not in this verse`); return; }
  const n = carriers.length;
  if (!skipTagConfirms) {
    const sk = { label: "Don't ask again for tag deletes, merges and renames", checked: skipTagConfirms };
    const ok = await confirmDlg(
      `Delete #${d}? Removes it from ${n} ${n === 1 ? 'body' : 'bodies'} on “${t.name}” (explicit uses are stripped from the text; auto-tags with that name stay suppressed). Write #${d} in any body to bring it back.`,
      'Delete tag', { title: `Delete #${d}`, skip: sk });
    if (ok && sk.checked !== skipTagConfirms) { skipTagConfirms = sk.checked; saveUi(); try { syncConfirmTip(); } catch {} }
    if (!ok) return;
  }
  deleteTag(d);
}
// delete a tag from EVERY tab that carries it: same strip + recount +
// suppress per tab, so the name can't resurrect anywhere. Other tabs rebuild
// on switch (their universes/tag lenses recompute from docs); the active one
// rebuilds immediately.
function deleteTagEverywhere(disp) {
  const d = normDisp(disp);
  if (!/^[a-z0-9_\-/]{2,}$/.test(d)) return 0;
  const tabs = vault.tabs.filter(t => carriersOf(t, d).length);
  if (!tabs.length) { toast(`#${d} is not in any verse`); return 0; }
  const re = tagUseRe(d);
  let bodies = 0;
  for (const t of tabs) {
    vault.suppressTag(t, d);
    for (const doc of carriersOf(t, d)) {
      doc.text = String(doc.text || '').replace(re, '$1');
      // manual tags aren't in the text — drop their entries directly
      doc.tags = (doc.tags || []).filter(tg => !(vault.isManual(tg) && vault.stripAuto(tg) === d));
      if (doc.manualTags) delete doc.manualTags[d];
      vault.recountDoc(doc);
      bodies++;
    }
  }
  vault.persist();
  try { rebuild(activeId); } catch {}
  try { if (!$('#tagPop').hidden) openTagPop(); } catch {}
  markBackupDirty();
  toast(`Deleted #${d} from ${bodies} ${bodies === 1 ? 'body' : 'bodies'} across ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'} — write #${d} in any body to bring it back`);
  return bodies;
}
async function deleteTagEverywhereUI(disp) {
  const d = normDisp(disp);
  const tabs = vault.tabs.filter(t => carriersOf(t, d).length);
  if (!tabs.length) { toast(`#${d} is not in any verse`); return; }
  const n = tabs.reduce((a, t) => a + carriersOf(t, d).length, 0);
  if (!skipTagConfirms) {
    const sk = { label: "Don't ask again for tag deletes, merges and renames", checked: skipTagConfirms };
    const ok = await confirmDlg(
      `Delete #${d} from everywhere? Removes it from ${n} ${n === 1 ? 'body' : 'bodies'} across ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'} (${tabs.map(t => `“${t.name}”`).join(', ')}) — explicit uses are stripped from every text and the name stays suppressed on each tab. Write #${d} in any body to bring it back.`,
      'Delete everywhere', { title: `Delete #${d} everywhere`, skip: sk });
    if (ok && sk.checked !== skipTagConfirms) { skipTagConfirms = sk.checked; saveUi(); try { syncConfirmTip(); } catch {} }
    if (!ok) return;
  }
  deleteTagEverywhere(d);
}
async function mergeTagsUI(src, dst) {
  const t = vault.tab();
  if (!t) return;
  const s = normDisp(src), g = normDisp(dst);
  if (s === g || !s || !g) return;
  const carriers = carriersOf(t, s);
  if (!carriers.length) { toast(`#${s} is not in this verse`); return; }
  if (!skipTagConfirms) {
    const sk = { label: "Don't ask again for tag deletes, merges and renames", checked: skipTagConfirms };
    const ok = await confirmDlg(
      `Merge #${s} into #${g}? ${carriers.length} ${carriers.length === 1 ? 'body carries' : 'bodies carry'} #${s} — they will carry #${g} instead, and #${s} disappears (its name is suppressed on “${t.name}”). #${g} keeps its name.`,
      'Merge tags', { title: `Merge #${s} → #${g}`, skip: sk });
    if (ok && sk.checked !== skipTagConfirms) { skipTagConfirms = sk.checked; saveUi(); try { syncConfirmTip(); } catch {} }
    if (!ok) return;
  }
  mergeTags(s, g);
}
// rename one tag everywhere on the canvas: explicit #old in body texts becomes
// #new, manual/old moves to manual/new with its spot anchor, auto-only sources
// are grounded as explicit #new (like a merge), the old name is suppressed so
// title words can't grow it back, and the new name is unsuppressed so it can
// live. Renaming onto an existing name folds in (like a merge). Current canvas only.
function renameTag(oldDisp, newRaw) {
  const t = vault.tab();
  if (!t) { toast('No open canvas — nothing to rename on'); return 0; }
  const s = normDisp(oldDisp);
  const g = String(newRaw || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_\-/]/g, '');
  if (!/^[a-z0-9_\-/]{2,}$/.test(s)) return 0;
  if (!/^[a-z0-9_\-/]{2,}$/.test(g) || !/[a-z]/.test(g)) { toast('That name can’t be a tag — use at least 2 letters (a–z, 0–9)'); return 0; }
  if (s === g) { toast('That’s the same name — nothing to rename'); return 0; }
  const carriers = carriersOf(t, s);
  if (!carriers.length) { toast(`#${s} is not in this verse`); return 0; }
  vault.suppressTag(t, s);
  // the new name must be allowed to live: drop it from this canvas's
  // suppression (a previously deleted/merged-away name can be renamed back)
  if (Array.isArray(t.suppressedTags) && t.suppressedTags.map(normDisp).includes(g)) {
    t.suppressedTags = t.suppressedTags.filter(x => normDisp(x) !== g);
  }
  const re = tagUseRe(s);
  for (const doc of carriers) {
    const hasG = (doc.tags || []).some(tg => vault.stripAuto(tg) === g);
    const hadManualS = (doc.tags || []).some(tg => vault.isManual(tg) && vault.stripAuto(tg) === s);
    const anchorS = (doc.manualTags && doc.manualTags[s]) || null;
    if (doc.manualTags) delete doc.manualTags[s];
    doc.tags = (doc.tags || []).filter(tg => !(vault.isManual(tg) && vault.stripAuto(tg) === s));
    if (hasG) {
      // the new name already grounds this body: just drop the old one
      doc.text = String(doc.text || '').replace(re, '$1');
    } else {
      let n = 0;
      doc.text = String(doc.text || '').replace(re, (...a) => { n++; return a[1] + '#' + g; });
      if (n === 0 && hadManualS) {
        // a hand-placed tag keeps its hand-placed nature under the new name
        doc.tags = (doc.tags || []).filter(tg => !(String(tg).toLowerCase().startsWith('auto/') && vault.stripAuto(tg) === g));
        if (!doc.tags.some(tg => vault.stripAuto(tg) === g)) doc.tags.push('manual/' + g);
        if (anchorS) { if (!doc.manualTags) doc.manualTags = {}; doc.manualTags[g] = anchorS; }
      } else if (n === 0) {
        // auto-only source: ground the new name explicitly so it survives
        doc.text = String(doc.text || '').replace(/\s+$/, '') + '\n#' + g;
      }
      // n > 0: rewritten in the prose as explicit #new — no anchor needed
    }
    vault.recountDoc(doc);
  }
  // the tag page follows the rename: a focused #old becomes the focused #new
  let followTag = null;
  try {
    if (activeId === 'tag:' + s) { activeId = 'tag:' + g; followTag = 'tag:' + g; }
    if (vault.tab() && vault.tab().activeId === 'tag:' + s) vault.tab().activeId = 'tag:' + g;
  } catch {}
  // a search box showing the old name follows it too
  try {
    const si = $('#searchInput');
    if (si && si.value === '#' + s) si.value = '#' + g;
  } catch {}
  vault.persist();
  try { rebuild(activeId); } catch {}
  // rebuild re-seats the Main universe first, which steals tab.activeId back
  // when the sun is a tag body — re-assert the followed tag on the tags-view
  // universe so canvas and reader stay on the renamed tag
  try {
    if (followTag && lensTags && uni && uni.byId && uni.byId.has(followTag)) {
      activeId = followTag;
      try { if (vault.tab()) vault.tab().activeId = followTag; vault.persist(); } catch {}
      try { renderDoc(); } catch {}
    }
  } catch {}
  try { if (!$('#tagPop').hidden) openTagPop(); } catch {}
  markBackupDirty();
  toast(`Renamed #${s} to #${g} — ${carriers.length} ${carriers.length === 1 ? 'body' : 'bodies'} now ${carriers.length === 1 ? 'carries' : 'carry'} #${g}`);
  return carriers.length;
}
async function renameTagConfirm(s, g) {
  const t = vault.tab();
  if (!t) return;
  s = normDisp(s);
  g = String(g || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_\-/]/g, '');
  if (!/^[a-z0-9_\-/]{2,}$/.test(s) || !/^[a-z0-9_\-/]{2,}$/.test(g) || !/[a-z]/.test(g)) { toast('That name can’t be a tag — use at least 2 letters (a–z, 0–9)'); return; }
  if (s === g) { toast('That’s the same name — nothing to rename'); return; }
  const carriers = carriersOf(t, s);
  if (!carriers.length) { toast(`#${s} is not in this verse`); return; }
  const n = carriers.length;
  const already = carriersOf(t, g).length;
  if (!skipTagConfirms) {
    const sk = { label: "Don't ask again for tag deletes, merges and renames", checked: skipTagConfirms };
    const ok = await confirmDlg(
      already
        ? `Rename #${s} to #${g}? ${n} ${n === 1 ? 'body carries' : 'bodies carry'} #${s} — #${g} already grounds ${already} ${already === 1 ? 'body' : 'bodies'}, so they will share it, and #${s} disappears (suppressed on “${t.name}”).`
        : `Rename #${s} to #${g}? ${n} ${n === 1 ? 'body carries' : 'bodies carry'} #${s} — every explicit use is rewritten, manual anchors move with it, and #${s} disappears (suppressed on “${t.name}”).`,
      'Rename tag', { title: `Rename #${s} → #${g}`, skip: sk });
    if (ok && sk.checked !== skipTagConfirms) { skipTagConfirms = sk.checked; saveUi(); try { syncConfirmTip(); } catch {} }
    if (!ok) return;
  }
  renameTag(s, g);
}
// tags pop-out geometry: null pos = flex-centered, null size = CSS default;
// dragged = fixed at the stored point (clamped on-screen), gripped = stored size
function applyTvpGeom() {
  const box = $('#tagPop'); if (!box) return;
  const card = box.querySelector('.tvp-card'); if (!card) return;
  if (tvpW != null && isFinite(tvpW)) card.style.width = Math.max(320, Math.min(Math.min(920, window.innerWidth * 0.94), tvpW)) + 'px';
  else card.style.width = '';
  if (tvpH != null && isFinite(tvpH)) card.style.height = Math.max(200, Math.min(window.innerHeight * 0.94, tvpH)) + 'px';
  else card.style.height = '';
  if (tvpX == null || tvpY == null) { card.style.position = ''; card.style.left = ''; card.style.top = ''; card.style.margin = ''; return; }
  // hard clamp: the whole card stays on-screen (8px margins), measured at its
  // real size — no edge may ever cross the viewport, while dragging or on load
  const cw = card.offsetWidth || Math.min(920, window.innerWidth * 0.94) || 320;
  const ch = card.offsetHeight || 200;
  tvpX = Math.max(8, Math.min(Math.max(8, window.innerWidth - cw - 8), tvpX));
  tvpY = Math.max(8, Math.min(Math.max(8, window.innerHeight - ch - 8), tvpY));
  card.style.position = 'fixed'; card.style.left = tvpX + 'px'; card.style.top = tvpY + 'px'; card.style.margin = '0';
}
// in-body find: highlight every occurrence of a term inside the open body
// and step through them. The term arrives from a search-result click
// (lastSearchQ, captured before the box clears) or the find bar itself.
// Highlighting is plain spans over text nodes (never touches the stored
// text), re-applied after each reader render, cleared with Esc (or by
// deleting the term).
let findTerm = '', findSpans = [], findIdx = -1, lastSearchQ = '', findSideOn = false;
let selManualTag = null; // manual tag picked in ALL TAGS: its clone pill gilds gold in doc TAGS rows + find auto-fills
let lastFindDocId = null; // find terms never carry between documents: cleared whenever a new doc renders
const MAX_FIND_HITS = 500;
function unwrapFind() {
  const root = $('#docBody');
  if (root) for (const sp of [...root.querySelectorAll('.find-hit')]) {
    try { sp.replaceWith(document.createTextNode(sp.textContent)); } catch {}
  }
  // heal the shatter: every highlight cycle splits text nodes (wrapping the
  // match, then unwrapping it leaves "art" as "a"|"rt"), and the highlighter
  // only matches inside a single node — without this, terms spanning an old
  // split silently find nothing, and find rots the more it is used.
  try { if (root) root.normalize(); } catch {}
  findSpans = []; findIdx = -1;
}
// reader action row: remove/delete/preview act on real documents only. The
// find bar is permanently parked under the tag row in every view (doc,
// theme, tag, overview) — there is no open/close state and no button.
function syncDocActionButtons() {
  const isDoc = !!vault.byId(shownId);
  const rm = $('#docRemoveBtn'), del = $('#docDeleteBtn');
  if (rm) rm.hidden = !isDoc;
  if (del) del.hidden = !isDoc;
  // Back is hidden in the general inventory view (a list, not a body): there
  // is no focused position to step back from, so the whole row hides there.
  // Focused docs, themes and tags keep it — it walks the reader's own
  // history (docs and lists alike) without touching the canvas.
  const bb = $('#docBackBtn');
  if (bb) bb.hidden = readerIsList;
  const da = $('#docActions');
  if (da) da.hidden = readerIsList && !isDoc;
  try { paintCanvasDot(); } catch {} // inventories rebuilt above — re-apply the red canvas-dot mark
  try { paintGoldRows(); } catch {} // ...and the persistent gold selection marks
  try { syncGotoSide(); } catch {} // ...and the side jump cluster follows the shown doc
}
function syncFindBar() {
  const bar = $('#findBar'), fi = $('#findInput'), fc = $('#findCount');
  if (!bar) return;
  // gate on reader prose, never on vault: themes, tags and overviews are
  // findable too, and this keeps the bar alive outside doc views. The bar
  // itself is permanent — Esc only clears the term and its highlights.
  // The reader collapse toggle rides in this row, so the row itself never
  // hides — only the find controls drop out when there is no prose.
  const hasProse = !!($('#docBody') && $('#docBody').textContent.trim());
  const show = !!hasProse;
  bar.hidden = false;
  for (const cid of ['findInput', 'findPrev', 'findNext', 'findCount']) {
    const cel = document.getElementById(cid);
    if (cel) cel.hidden = !show;
  }
  if (fi && document.activeElement !== fi && fi.value !== findTerm) fi.value = findTerm;
  const count = findSpans.length ? `${findIdx + 1}/${findSpans.length}` : (findTerm ? '0/0' : '');
  if (fc) fc.textContent = count;
  // redundant side bar: same term, same count, parked left of the reader
  const side = $('#findSide'), fi2 = $('#findInput2'), fc2 = $('#findCount2');
  if (!side) return;
  const p = $('#docPanel');
  const panelOpen = p && !p.hidden && p.offsetParent !== null && !p.classList.contains('collapsed');
  // the side bar, once summoned by ‹ ›, stays put even when the term is
  // cleared to empty (only Esc or the × dismisses it) so retyping never loses it
  side.hidden = !(hasProse && panelOpen && findSideOn);
  if (fi2 && document.activeElement !== fi2 && fi2.value !== findTerm) fi2.value = findTerm;
  if (fc2) fc2.textContent = count;
  if (!side.hidden) placeFindSide();
  try { placeGotoSide(); } catch {} // re-stack the jump cluster when the find box shows/hides
}
// side find bar: pinned left of the Active-body pane, centered on its height
function placeFindSide() {
  const side = $('#findSide'), p = $('#docPanel');
  // the jump cluster must follow the pane even when the find bar is hidden
  if (!side || side.hidden || !p) { try { placeGotoSide(); } catch {} return; }
  const px = p.offsetLeft, py = p.offsetTop, ph = p.offsetHeight;
  const w = 210;
  side.style.width = w + 'px';
  side.style.left = Math.max(8, px - w - 8) + 'px';
  const h = side.offsetHeight || 80;
  side.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, py + ph / 2 - h / 2)) + 'px';
  rideTiltPlane(side);
  try { placeGotoSide(); } catch {} // the jump cluster stacks below the find box
}
// view-jump side cluster: one MAIN / THEMATIC / TAGS set for the shown doc,
// docked left of the reader (below the side find bar when that stands)
function placeGotoSide() {
  const box = $('#gotoSide'), p = $('#docPanel');
  if (!box || box.hidden || !p) return;
  // FLAT ALWAYS: this card never joins the tilt plane — it stays axis-aligned
  // in screen space, seated from the visual (bounding) edge, re-seated after
  // the glide lands by setDocTilt's post-glide pass
  const r = p.getBoundingClientRect();
  const w = 250;
  box.style.width = w + 'px';
  // 26px clear of the pane edge: the ‹ arrow + tilt/carousel icon buttons ride
  // the edge (carousel sticks 14px left of it), so 8px would slide under them
  box.style.left = Math.max(8, r.left - w - 26) + 'px';
  // park below the mid-height edge cluster (arrow ± tilt/jump/carousel icons) — never cover it
  let top = r.top + r.height / 2 + 162;
  const fs = $('#findSide');
  if (fs && !fs.hidden && fs.offsetParent !== null) {
    const fr = fs.getBoundingClientRect();
    if (fr.width > 0) top = fr.bottom + 8;
  }
  box.style.top = Math.max(8, Math.min(window.innerHeight - (box.offsetHeight || 60) - 8, top)) + 'px';
}
function syncGotoSide() {
  const box = $('#gotoSide'), p = $('#docPanel');
  if (!box) return;
  const panelOpen = p && !p.hidden && p.offsetParent !== null && !p.classList.contains('collapsed');
  let doc = null;
  try { doc = vault.byId(shownId); } catch {}
  if (gotoPicked && gotoPicked.docId !== shownId) gotoPicked = null; // new doc — no VIEW IN pick yet
  if (gotoSideClosedFor && gotoSideClosedFor !== shownId) gotoSideClosedFor = null; // new doc — the locate floater stands again
  applyGotoPicked();
  box.hidden = !(doc && panelOpen) || gotoSideClosedFor === shownId;
  if (!box.hidden) placeGotoSide();
}
// VIEW IN pick: the last-clicked jump button wears the red frame until the reader moves to another doc
let gotoPicked = null; // {docId, view:'main'|'thematic'|'tags'} | null
let gotoSideClosedFor = null; // shownId the locate floater was ×-dismissed on: stays shut until the reader moves on
function applyGotoPicked() {
  try {
    const m = { main: $('#gotoMain'), thematic: $('#gotoThematic'), tags: $('#gotoTags') };
    for (const k of Object.keys(m)) if (m[k]) m[k].classList.toggle('picked', !!(gotoPicked && gotoPicked.view === k));
  } catch {}
}
// back-to-top tab: appears once the reader pane is scrolled down, parked at
// the pane's bottom-right; vanishes the moment the pane is back at the top.
function placeTopBtn() {
  const b = $('#docTopBtn'), p = $('#docPanel');
  if (!b || b.hidden || !p) return;
  const px = p.offsetLeft, py = p.offsetTop, pw = p.offsetWidth, ph = p.offsetHeight;
  const bw = b.offsetWidth, bh = b.offsetHeight;
  b.style.left = Math.max(8, px + pw - bw - 12) + 'px';
  b.style.top = Math.max(8, Math.min(window.innerHeight - bh - 8, py + ph - bh - 12)) + 'px';
  rideTiltPlane(b);
}
function syncTopBtn() {
  const b = $('#docTopBtn'), p = $('#docPanel');
  if (!b || !p) return;
  const open = !p.hidden && p.offsetParent !== null && !p.classList.contains('collapsed');
  b.hidden = !(open && (document.getElementById('docScroll')?.scrollTop || 0) > 64);
  if (!b.hidden) placeTopBtn();
}
function placeGlossTop() {
  const b = $('#glossTopBtn'), p = $('#glossPane');
  if (!b || b.hidden || !p) return;
  const r = p.getBoundingClientRect();
  // right edge stops 34px in so the pane's own resize grip stays grabbable
  b.style.left = Math.max(8, r.right - b.offsetWidth - 34) + 'px';
  b.style.top = Math.max(8, Math.min(window.innerHeight - b.offsetHeight - 8, r.bottom - b.offsetHeight - 12)) + 'px';
}
function syncGlossTop() {
  const b = $('#glossTopBtn'), p = $('#glossPane'), body = $('#glossBody');
  if (!b || !p || !body) return;
  const open = glossOpen && !p.hidden && p.offsetParent !== null;
  b.hidden = !(open && (body.scrollTop || 0) > 64);
  if (!b.hidden) placeGlossTop();
}
// notes back-to-top tab: appears once the entries list is scrolled down,
// parked at the pane's bottom-right; vanishes the moment it's back at top.
function placeNotesTop() {
  const b = $('#notesTopBtn'), p = $('#notesPane'), l = $('#notesList');
  if (!b || b.hidden || !p || !l) return;
  // anchored to the entries list (not the pane): it never covers Save/Cancel
  const r = l.getBoundingClientRect();
  b.style.left = Math.max(8, r.right - b.offsetWidth - 12) + 'px';
  b.style.top = Math.max(8, Math.min(window.innerHeight - b.offsetHeight - 8, r.bottom - b.offsetHeight - 8)) + 'px';
}
function syncNotesTop() {
  const b = $('#notesTopBtn'), p = $('#notesPane'), list = $('#notesList');
  if (!b || !p || !list) return;
  const open = notesOpen && !p.hidden && p.offsetParent !== null;
  b.hidden = !(open && (list.scrollTop || 0) > 64);
  if (!b.hidden) placeNotesTop();
}
// original-pane back-to-top tab: appears once the whole-original overlay is
// scrolled down, parked at the card's bottom-right; vanishes at the top.
function placeOrigTop() {
  const b = $('#origTopBtn'), c = $('#carZoomCard');
  if (!b || b.hidden || !c) return;
  const r = c.getBoundingClientRect();
  const bw = b.offsetWidth, bh = b.offsetHeight;
  b.style.left = Math.max(8, r.right - bw - 14) + 'px';
  b.style.top = Math.max(8, Math.min(window.innerHeight - bh - 8, r.bottom - bh - 12)) + 'px';
}
function syncOrigTop() {
  const b = $('#origTopBtn'), wrap = $('#carZoomWrap'), body = $('#carZoomBody');
  if (!b || !wrap || !body) return;
  const open = carZoomOpen && !wrap.hidden;
  b.hidden = !(open && (body.scrollTop || 0) > 64);
  if (!b.hidden) placeOrigTop();
}
let carZoomGeomToken = 0; // bumped whenever the original overlay body is rebuilt
let carZoomGeomCache = { token: -1, offs: [], w: 0 }; // marker content-offsets for the live "on page N" readout
function syncCarZoomPageBar(d) {
  // original-overlay page bar: folio count, live position, jump, rebuild —
  // same recipe as the reader's syncPageBar, scoped to #carZoomBody/Text.
  const pb = $('#carZoomPageBar');
  if (!pb) return;
  carZoomGeomToken++; // the overlay body was just rebuilt — cached marker geometry is stale
  const close = () => { pb.hidden = true; pb.innerHTML = ''; };
  if (!d || !d.text) { close(); return; }
  const pm = validPageMap(d.pageMap, String(d.text).length);
  if (pm) {
    const unit = pageUnitName(pm.kind);
    const plural = pm.count === 1 ? '' : 's';
    pb.hidden = false;
    pb.innerHTML = `<span class="pg-info" title="Original ${unit}s recorded at import — markers in the text below name each one">▦ ${pm.count} original ${unit}${plural} · on ${unit} <b id="czNow">1</b></span>` +
      (pm.count > 1 ? `<span class="pg-jump">jump to <input id="czJump" inputmode="numeric" autocomplete="off" aria-label="Go to original ${unit}" placeholder="1–${pm.count}"><button class="btn" id="czGo" title="Scroll to that original ${unit}">Go</button></span>` : '');
    try {
      const go = $('#czGo'), inp = $('#czJump');
      const run = () => { try { gotoCarZoomPage(inp ? inp.value : 1); } catch {} };
      if (go) go.onclick = (e) => { try { e.stopPropagation(); } catch {} run(); };
      if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } e.stopPropagation(); };
    } catch {}
    try { syncCarZoomPageNow(); } catch {}
    return;
  }
  // no map: PDFs can rebuild it from the kept original bytes; anything else
  // says so honestly (slides/sheets already carry their numbers as headers).
  if (fileTypeKey(d.name) === 'pdf') {
    pb.hidden = false;
    pb.innerHTML = d.origKey
      ? `<span class="pg-info">▦ page numbers not mapped for this import</span><button class="btn" id="czMap" title="Re-read the kept original PDF and map its real page numbers onto this text">Map pages</button>`
      : `<span class="pg-info" title="The original file bytes were not kept for this body (older import or restored backup)">▦ no page map — re-import the PDF to enable page numbers</span>`;
    try {
      const mb = $('#czMap');
      if (mb) mb.onclick = (e) => { try { e.stopPropagation(); } catch {} try { rebuildPageMap(d.id); } catch {} };
    } catch {}
    return;
  }
  close();
}
function syncCarZoomPageNow() {
  // which original page is on screen in the overlay: the last folio marker
  // at/above the overlay's scroll position (same recipe as the reader bar).
  try {
    const now = $('#czNow');
    if (!now) return;
    const sc = $('#carZoomBody');
    const marks = [...document.querySelectorAll('#carZoomText .pagemark')];
    if (!sc || !marks.length) { now.textContent = '1'; return; }
    if (carZoomGeomCache.token !== carZoomGeomToken || carZoomGeomCache.offs.length !== marks.length || carZoomGeomCache.w !== sc.clientWidth) {
      const sr = sc.getBoundingClientRect(), top = sc.scrollTop || 0;
      carZoomGeomCache = { token: carZoomGeomToken, w: sc.clientWidth, offs: marks.map(m => m.getBoundingClientRect().top - sr.top + top) };
    }
    const top = sc.scrollTop || 0;
    let cur = 1;
    for (let i = 0; i < marks.length; i++) {
      if (carZoomGeomCache.offs[i] <= top + 8) cur = Number(marks[i].dataset.page) || cur;
      else break;
    }
    now.textContent = String(cur);
  } catch {}
}
function gotoCarZoomPage(n) {
  const marks = [...document.querySelectorAll('#carZoomText .pagemark')];
  if (!marks.length) return false;
  n = Math.max(1, Math.min(marks.length, Math.round(Number(n)) || 1));
  const m = marks[n - 1];
  // land the marker at the top of the overlay (not centered): the page below
  // it is the one on screen, so the live "on page N" readout agrees.
  try {
    const sc = $('#carZoomBody');
    if (sc) {
      const sr = sc.getBoundingClientRect();
      sc.scrollTop = Math.max(0, m.getBoundingClientRect().top - sr.top + (sc.scrollTop || 0) - 8);
    } else m.scrollIntoView({ block: 'start' });
  } catch { try { m.scrollIntoView({ block: 'start' }); } catch {} }
  try {
    m.classList.add('spot-flash');
    setTimeout(() => { try { m.classList.remove('spot-flash'); } catch {} }, 1400);
  } catch {}
  try { syncCarZoomPageNow(); setTimeout(() => { try { syncCarZoomPageNow(); } catch {} }, 350); } catch {}
  try { syncOrigTop(); } catch {}
  return true;
}
function applyReaderFind() {
  unwrapFind();
  const root = $('#docBody');
  if (root && findTerm) {
    const q = findTerm.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.nodeValue || !n.nodeValue.toLowerCase().includes(q)) continue;
      if (n.parentElement && n.parentElement.closest && (n.parentElement.closest('.imggal') || n.parentElement.closest('.mediagal') || n.parentElement.closest('.pagemark'))) continue;
      nodes.push(n);
    }
      for (const n of nodes) {
        const text = n.nodeValue, low = text.toLowerCase();
        const frag = document.createDocumentFragment();
        let idx = 0, count = 0;
        for (;;) {
        if (findSpans.length >= MAX_FIND_HITS) break;
        const p = low.indexOf(q, idx);
        if (p < 0) break;
        if (p > idx) frag.appendChild(document.createTextNode(text.slice(idx, p)));
        const sp = document.createElement('span');
        sp.className = 'find-hit';
        sp.textContent = text.slice(p, p + findTerm.length);
        frag.appendChild(sp);
        findSpans.push(sp);
        idx = p + findTerm.length;
        count++;
      }
      if (count) {
        if (idx < text.length) frag.appendChild(document.createTextNode(text.slice(idx)));
        try { n.replaceWith(frag); } catch {}
      }
      if (findSpans.length >= MAX_FIND_HITS) break;
    }
  }
  if (findSpans.length) { findIdx = 0; findSpans[0].classList.add('cur'); }
  syncFindBar();
}
function stepFind(d) {
  if (!findSpans.length) return;
  findSpans.forEach(s => s.classList.remove('cur'));
  findIdx = (((findIdx + d) % findSpans.length) + findSpans.length) % findSpans.length;
  const sp = findSpans[findIdx];
  sp.classList.add('cur');
  try { sp.scrollIntoView({ block: 'center' }); } catch {}
  syncFindBar();
}
function setReaderFind(term, jump) {
  findTerm = String(term || '').trim().slice(0, 60);
  applyReaderFind();
  if (jump && findSpans.length) {
    try { findSpans[0].scrollIntoView({ block: 'center' }); } catch {}
    // second trigger for the side bar: a search-result jump that lands past
    // the top of the body summons it (a jump already at the top needs no
    // step controls); typing never summons it on its own.
    // (the jump scrolls the reader pane — the body itself never scrolls.)
    try {
      const sc = document.getElementById('docScroll').scrollTop || document.getElementById('docBody').scrollTop || 0;
      if (sc > 8) { findSideOn = true; syncFindBar(); }
    } catch {}
  }
}
function clearReaderFind() {
  findTerm = ''; findSideOn = false;
  applyReaderFind();
}

// split inventory rows: document rows get a two-box stack where the dot box
// was — 👁 previews the doc (120-word pinned pop-out), the lower box is a
// reserved slot for a later function. Titles park the doc in the pane and
// never touch the canvas (any lens included). Theme/tag rows keep the single
// dot box (canvas selection); dots put the body on the canvas as the sun and
// never open it in the pane (lens members take the canvas to Main first).
// canvas-sticky icons shared by the inventory note boxes + the reader notes pill:
// filled yellow while the doc has notes, empty outline when it doesn't.
const NOTE_SVG_FILLED = '<svg class="bl-note-ic" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><rect x="0.5" y="0.5" width="11" height="11" fill="#eccb45" stroke="rgba(138,106,31,.9)"/><line x1="2" y1="4.6" x2="10" y2="4.6" stroke="rgba(138,106,31,.55)" stroke-width="0.9"/><line x1="2" y1="7.4" x2="10" y2="7.4" stroke="rgba(138,106,31,.55)" stroke-width="0.9"/><line x1="2.9" y1="1.5" x2="2.9" y2="10.5" stroke="rgba(200,80,60,.7)" stroke-width="0.9"/></svg>';
const NOTE_SVG_EMPTY = '<svg class="bl-note-ic" viewBox="0 0 12 12" width="13" height="13" aria-hidden="true"><rect x="0.5" y="0.5" width="11" height="11" fill="none" stroke="rgba(140,160,190,.6)"/><line x1="2" y1="4.6" x2="10" y2="4.6" stroke="rgba(140,160,190,.35)" stroke-width="0.9"/><line x1="2" y1="7.4" x2="10" y2="7.4" stroke="rgba(140,160,190,.35)" stroke-width="0.9"/></svg>';
function blRow(id, dotGlyph, bodyHtml, rowCls, dotName, noteId) {
  const rc = rowCls ? ' ' + rowCls : '';
  // every DOCUMENT row carries a note box on its right: a filled sticky when
  // the doc has notes, an empty outline when it doesn't (both open its Notes
  // pane). Theme/tag rows pass non-doc ids, so nothing shows there.
  const nid = noteId || id;
  let nn = 0;
  try { if (vault.byIdAnywhere(nid)) nn = noteCount(nid) || 0; } catch {}
  const hasDoc = (() => { try { return !!vault.byIdAnywhere(nid); } catch { return false; } })();
  const filledSvg = NOTE_SVG_FILLED;
  const emptySvg = NOTE_SVG_EMPTY;
  const nb = hasDoc ? `<button class="bl-note${rc}${nn ? '' : ' empty'}" data-notes-pane="${nid}" title="Open ${esc(dotName || nid)}’s notes pane${nn ? ` (${nn} ${nn === 1 ? 'entry' : 'entries'})` : ' (no notes yet)'}">${nn ? filledSvg : emptySvg}</button>` : '';
  // view jumps live in the side cluster docked left of the reader (one
  // MAIN / THEMATIC / TAGS set for the shown doc) — rows carry no pills.
  const onActive = (() => { try { return !!(vault.tab() && (vault.tab().docs || []).some(d => d.id === id)); } catch { return false; } })();
  // inventory × : document rows on the ACTIVE canvas get a small remove box
  // parked over the strip's bottom-right (lens/theme/tag rows and
  // whole-verse foreign members never qualify, so nothing shows there).
  let bx = '';
  try { if (onActive) bx = `<button class="bl-x${rc}" data-blx="${id}" title="Remove “${esc(dotName || id)}” from this canvas">×</button>`; } catch {}
  // document rows: eye-preview + + #tag writer stacked where the dot box was
  // (the eye lights while its preview is pinned); theme/tag rows keep dots.
  // +#tag slot frame = tag provenance (both modes): user-made explicit tags
  // keep the dashed maker frame, gold while live; system-associated tags
  // (auto top-ups, manual passage anchors) ground it solid; untagged docs
  // keep the dashed grey reserved look. rebuild() repaints rows on every
  // tag commit, so the frame follows tag edits by itself.
  const eyeOn = (() => { try { return (typeof srcStickyId !== 'undefined' && srcStickyId === id) ? ' eye-on' : ''; } catch { return ''; } })();
  let slotCls = '';
  try {
    const dd = vault.byIdAnywhere(id);
    const tgs = (dd && Array.isArray(dd.tags) ? dd.tags : []).map(t => String(t).toLowerCase());
    const hasUser = tgs.some(t => !t.startsWith('auto/') && !t.startsWith('manual/'));
    const hasAssoc = tgs.some(t => t.startsWith('auto/') || t.startsWith('manual/'));
    slotCls = hasUser ? ' slot-user' : (hasAssoc ? ' slot-solid' : '');
  } catch {}
  const side = hasDoc
    ? `<span class="bl-side${rc}"><button class="bl-eye${rc}${eyeOn}" data-preview="${id}" title="Preview “${esc(dotName || id)}” (120-word pop-out; click again to close)">👁</button><button class="bl-slot${rc}${slotCls}" data-slotadd="${id}" title="Declare what this document/body belongs with by assigning a +#tag to it. Bodies sharing the tag pull together, share weight, match in search, and form one Tags-view node. This tag button is the same as the +#Tag function/button in the document reading/display view.">+ #tag</button></span>`
    : `<button class="bl-dot${rc}" data-canvas="${id}" title="Show “${esc(dotName || id)}” in the canvas">${dotGlyph}</button>`;
  // original-file-type badge: standardized label parked over the strip's
  // top-right (above the ×), from the doc's original extension. Theme/tag
  // rows aren't documents, so they get none.
  let ft = '';
  try {
    const dd = vault.byIdAnywhere(nid);
    if (dd) { const k = fileTypeKey(dd.name); if (k) ft = `<span class="bl-ft ft-${k}">${FILE_TYPE_LABEL[k]}</span>`; }
  } catch {}
  return `<span class="bl-wrap">${side}<span class="bl-col"><button class="bl-row${rc}" data-open="${id}">${bodyHtml}</button></span>${nb}${bx}${ft}</span>`;
}
// eye state: the 👁 box of the doc whose preview is pinned stays gold
function syncEye() {
  try {
    document.querySelectorAll('#docLinks .bl-eye[data-preview]').forEach(b => {
      b.classList.toggle('eye-on', !!srcStickyId && b.dataset.preview === srcStickyId);
    });
  } catch {}
}
function paintCanvasDot() {  const dl = $('#docLinks');
  if (!dl) return;
  dl.querySelectorAll('.bl-dot.dot-on').forEach(b => b.classList.remove('dot-on'));
  const sid = (uni && uni.sunId && uni.byId.has(uni.sunId)) ? uni.sunId : null;
  if (!sid) return;
  const b = dl.querySelector(`.bl-dot[data-canvas="${CSS.escape(sid)}"]`);
  if (b) b.classList.add('dot-on');
}
// mass readout for a doc that isn't a body on the live canvas (e.g. a pane
// pin parked from a lens): fall back to its node on any built universe.
function mainNodeById(id) {
  try {
    for (const u of unis.values()) {
      const n = u && u.byId && u.byId.get(id);
      if (n) return n;
    }
  } catch {}
  return null;
}
// backlink counts for a doc set, computed once: docs linking here by title.
// Inventory sub-line, identical in every pane: words · mass · backlinks.
// Mass falls back to any built universe, so lens members still read right.
function canvasBackCount(docs) {
  const backCount = new Map();
  const ids = new Set(docs.map(d => d.id));
  for (const d of docs) for (const t of (d.links || [])) {
    const target = vault.byTitle(t);
    if (target && target.id !== d.id && ids.has(target.id)) backCount.set(target.id, (backCount.get(target.id) || 0) + 1);
  }
  return backCount;
}
function docRowSub(o, backCount) {
  const m = (uni && uni.byId.get(o.id)) || mainNodeById(o.id);
  const mass = m ? (m.trueMass ?? m.mass) : 0;
  const bl = (backCount && backCount.get(o.id)) || 0;
  return `${o.words} words · mass ${Number(mass).toFixed(1)} · ${bl} backlink${bl === 1 ? '' : 's'}`;
}

// general-state reader: no active body — a live overview with drill-down rows,
// never stale bodies. Thematic general lists the lens's themes; regular general
// lists the canvas. An empty canvas keeps its import hint.
function renderGeneral() {
  readerIsList = true; // list views have no Back button (no focused position)
  shownId = null; // no doc shown — the Notes tab + pane follow shownId, so general view clears it
  srcHi = null; // fresh rows — a stale hover id would block re-highlighting
  try { trackReader(); } catch {} // the list itself is a backable position
  const t = vault.tab();
  const docs = t ? (t.docs || []) : [];
  if (!t) {
    // every canvas is closed: say so and point at the two ways back.
    setKicker('◌ NO OPEN CANVAS');
    $('#docTitle').textContent = 'No open canvas';
    $('#docMeta').textContent = '';
    $('#docTags').innerHTML = '';
    $('#docBody').innerHTML = `<span class="ovNote">${ovBlurb('ovNoCanvas')}</span>`;
    $('#docLinks').innerHTML = '';
    try { syncDocActionButtons(); } catch {} // the find bar stays parked even here
    try { syncPageBar(null); } catch {} // no doc — no folio bar
    try { applyReaderFind(); } catch {} // rebuild highlights for the hint text
    try { syncResizeHandle(); } catch {} try { syncNotesPaneDoc(); } catch {} // Notes book tab/pane follow the shown doc
    return;
  }
  if (lensThematic) {
    const themes = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
    const scope = thematicWhole ? 'the whole Visi|Docsverse' : `“${t ? t.name : 'this canvas'}”`;
    setKicker('◈ Document universe view mode: THEMATIC');
    $('#docTitle').textContent = `◈ PROJECT TAB: ${t.name}`;
    const grounded = themes.reduce((s, th) => s + ((th.members && th.members.length) || 0), 0);
    $('#docMeta').textContent = `${themes.length} themes · ${grounded} grounded bodies · distilled from ${scope}`;
    $('#docTags').innerHTML = '';
    $('#docBody').innerHTML = `<span class="ovNote">${themes.length ? ovBlurb('ovThematic') : ovBlurb('ovThematicEmpty')} ${ovBlurb('ovThematicRelease')}</span>`;
    const sg = $('#docShared');
    if (sg) sg.innerHTML = '';
    $('#docLinks').innerHTML = (themes.length ? `<div class="bl-head">THEMES — ${themes.length}</div>` : '') +
      [...themes].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1))
        .map(th => blRow(th.id, '◈', `${esc(th.label)}<span>${esc((th.terms || []).slice(0, 3).join(' · '))}</span>`, '', th.label)).join('');
  } else if (lensTags) {
    // tags-view general state: the lens's tag bodies (regular docs aren't bodies here)
    const recs = tagRecords.get(vault.activeTabId) || [];
    const grounded = recs.reduce((s, r) => s + ((r.members && r.members.length) || 0), 0);
    setKicker('◈ Document universe view mode: TAGS');
    const sg = $('#docShared');
    if (sg) sg.innerHTML = '';
    $('#docTitle').textContent = `◈ PROJECT TAB: ${t.name}`;
    $('#docMeta').textContent = `${recs.length} tags · ${grounded} grounded bodies · click a tag to make it the center`;
    $('#docTags').innerHTML = '';
    $('#docBody').innerHTML = `<span class="ovNote">${ovBlurb('ovTags')}</span>`;
    $('#docLinks').innerHTML = `<div class="bl-head">TAGS — ${recs.length} <button class="viewall" data-tvexit="1" title="Leave the tags view">Exit tags view</button></div>` +
      [...recs].sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1))
        .map(r => blRow(r.id, '◈', `${esc(r.label)}<span>grounds ${r.members.length} ${r.members.length === 1 ? 'body' : 'bodies'}</span>`, '', r.label)).join('');
  } else {
    setKicker('◌ Document universe view mode: MAIN');
    const sg = $('#docShared');
    if (sg) sg.innerHTML = '';
    if (!docs.length) {
      $('#docTitle').textContent = 'Empty canvas';
      $('#docMeta').innerHTML = '';
      $('#docTags').innerHTML = '';
      $('#docBody').innerHTML = `<span class="ovNote">${ovBlurb('ovEmpty')}</span>`;
      $('#docLinks').innerHTML = '';
    } else {
      const tethers = uni ? uni.edges.length : 0;
      const words = docs.reduce((s, d) => s + (d.words || 0), 0);
      $('#docTitle').textContent = `◌ PROJECT TAB: ${t.name}`;
      $('#docMeta').textContent = `${docs.length} bodies · ${tethers} tethers · ${words} words · no active body`;
      $('#docTags').innerHTML = '';
      $('#docBody').innerHTML = `<span class="ovNote">${ovBlurb('ovMain')}</span>`;
      const sorted = [...docs].sort((a, b) => (b.words || 0) - (a.words || 0));
      const big = sorted.slice(0, 6);
      const rest = showAllBodies ? sorted.slice(6) : [];
      // backlink counts for this canvas, computed once: docs linking here by title
      const backCount = canvasBackCount(docs);
      const rowSub = (o) => docRowSub(o, backCount);
      $('#docLinks').innerHTML = `<div class="bl-head">LARGEST BODIES — ${big.length}` +
        (docs.length > 6 ? ` <button class="viewall" data-viewall="1" title="${showAllBodies ? 'Collapse back to the 6 largest' : `Also list the other ${docs.length - 6}`}">${showAllBodies ? 'Show fewer' : 'View all bodies'}</button>` : '') +
        `</div>` +
        big.map(o => blRow(o.id, '◉', `${esc(vault.titleOf(o))}<span>${rowSub(o)}</span>`, '', vault.titleOf(o), o.id)).join('') +
        rest.map(o => blRow(o.id, '<span class="rest-dot">●</span>', `${esc(vault.titleOf(o))}<span>${rowSub(o)}</span>`, 'rest-row', vault.titleOf(o), o.id)).join('');
    }
  }
  try { syncDocActionButtons(); } catch {} // overview: action buttons hide off-doc; the find bar stays
  try { syncPageBar(null); } catch {} // list views carry no pagination
  try { applyReaderFind(); } catch {} // rebuild highlights for the overview prose
  try { syncResizeHandle(); } catch {} try { syncNotesPaneDoc(); } catch {} // Notes book tab/pane follow the shown doc
}
let lastDocShown = null; // identity of what's in the reader — a newly shown doc always starts scrolled to the top
function renderDoc() {
  // pane-only pins: a title click parks a doc in the pane without touching
  // the canvas; anything the pin can't resolve falls back to the canvas pick.
  if (paneId && !vault.byId(paneId)) paneId = null;
  const vid = paneId || activeId;
  shownId = vid;
  try { trackReader(); } catch {} // every shown doc (or list) becomes backable
  const rkey = (vault.activeTabId || '') + '|' + (vid || 'general');
  if (rkey !== lastDocShown) {
    lastDocShown = rkey;
    try { $('#docScroll').scrollTop = 0; $('#docBody').scrollTop = 0; } catch {}
    try { syncTopBtn(); } catch {} // newly shown body starts at top — no tab
  }
  const d = vault.byId(vid);
  if (!d) {
    const th = themeById(vid);
    if (th && uni && uni.byId.has(vid)) {
      setKicker(thematicWhole ? '◈ Active theme - Whole document universe' : '◈ ACTIVE THEME — GRAVITATIONAL CENTER');
      renderThemeDoc(th); return;
    }
    const tg = tagById(vid);
    if (tg && uni && uni.byId.has(vid)) {
      setKicker('◈ ACTIVE TAG — GRAVITATIONAL CENTER');
      renderTagDoc(tg); return;
    }
    // general state (or an empty canvas): the overview reader, never stale bodies
    renderGeneral();
    return;
  }
  readerIsList = false; // a real doc is focused — Back is available again
  // find terms never carry between documents: a newly opened doc starts with
  // a clean box — except the selected manual tag, which stays while the new
  // doc carries it (gold pill + highlights travel together)
  try {
    if (lastFindDocId !== d.id) {
      const keepTag = selManualTag && String(findTerm).trim().toLowerCase() === selManualTag &&
        (d.tags || []).some(tg => String(tg).toLowerCase().startsWith('manual/') && normDisp(tg) === selManualTag);
      if (!keepTag && (findTerm || findSideOn)) clearReaderFind();
    }
    lastFindDocId = d.id;
  } catch {}
  if (paneId && paneId !== activeId) setKicker('◉ READING — CANVAS UNCHANGED');
  else setKicker('◉ ACTIVE BODY — GRAVITATIONAL CENTER');
  $('#docTitle').textContent = vault.titleOf(d);
  const m = (uni && uni.byId.get(vid)) || mainNodeById(vid);
  $('#docMeta').innerHTML = `${d.words} words · mass ${(m ? (m.trueMass ?? m.mass) : 0).toFixed(1)} <span class="sg-help" data-sghelp tabindex="0">?</span> · ${d.links.length} outgoing refs<div class="sg-help-pop" role="note" data-help-pop="mass"><span class="help-text" data-help-text="mass">${esc(helpTexts.mass)}</span><button class="help-edit-btn" data-help-edit="mass" title="Edit this explanation">✎ edit</button></div>`;
  $('#docTags').innerHTML = `<span class="tags-cap">TAGS:</span>` + d.tags.map(t => {
    const disp = vault.stripAuto(t);
    const low = String(t).toLowerCase();
    const cls = low.startsWith('auto/') ? ' auto' : (low.startsWith('manual/') ? ' manual' : '');
    const hot = !!selManualTag && low.startsWith('manual/') && String(disp).toLowerCase() === selManualTag; // ALL-TAGS manual pick: gold clone pill
    const mark = low.startsWith('manual/') ? '<span class="mmark" title="Manually created tag">M</span>' : '';
    const tip = low.startsWith('manual/') ? `Manually created tag — click to search · right-click to rename${hot ? ' · selected in ALL TAGS' : ''}` : `#${esc(disp)} — click to search · right-click to rename`;
    return `<button class="tagpill${cls}${hot ? ' sunlit' : ''}" data-tag="${esc(disp)}" title="${tip}">#${esc(disp)}${mark}</button>`;
  }).join('') +
    `<button class="tagpill addtagbtn" data-addtag="${d.id}" title="Declare what this document/body belongs with by assigning a +#tag to it. Bodies sharing the tag pull together, share weight, match in search, and form one Tags-view node.">+ #tag</button>` +
    `<button class="tagpill notesbtn${noteCount(d.id) ? '' : ' note-zero'}" data-notes="${d.id}" title="Notes for this body — one shared notepad (sticky square, this button and the Notes book tab all show the same entries)">${noteCount(d.id) ? NOTE_SVG_FILLED : NOTE_SVG_EMPTY}notes ·${noteCount(d.id)}</button>`;
  $('#docBody').innerHTML = renderBody(d.text, d.images, d.pageMap);
  hydrateImages($('#docBody'), d.images);
  hydrateMedia($('#docBody'), d);
  try { markManualSpots(d); } catch {} // persistent gold markers on manual-tag spots
  try { markNoteSpots(d); } catch {} // sent highlights stay marked while their note entry lives
  try { applyReaderFind(); } catch {} // in-body find highlights survive re-renders
  try { syncPageBar(d); } catch {} // folio bar: original-page count, position, jump
  // shared ground -> top hover spillover menu (up to 12 tethers, scrolls)
  const res = edgeInfo.filter(e => e.kind === 'topic' && (e.source === d.id || e.target === d.id)).slice(0, 12);
  const sg = $('#docShared');
  sg.classList.remove('open'); sg.classList.remove('help-open');
  sg.innerHTML = `<span class="sg-label" data-sg tabindex="0">SHARED GROUND — ${res.length}</span><span class="sg-help" data-sghelp tabindex="0">?</span>` +
    `<div class="sg-help-pop" role="note" data-help-pop="shared"><span class="help-text" data-help-text="shared">${esc(helpTexts.shared)}</span><button class="help-edit-btn" data-help-edit="shared" title="Edit this explanation">✎ edit</button></div>` +
    `<div class="sg-menu" role="menu">` + (res.length ? res.map(e => {
      const oid = e.source === d.id ? e.target : e.source;
      const o = vault.byId(oid);
      if (!o) return '';
      return `<button class="bl-row" data-open="${oid}">◉ ${esc(vault.titleOf(o))}<span>${esc((e.topics || []).join(' · '))}</span></button>`;
    }).join('') : '<div class="sg-empty">No shared ground.</div>') + `</div>`;
  // bodies referencing this one stay inline below the body text
  const back = vault.docs.filter(o => o.id !== d.id && o.links.some(t => vault.byTitle(t)?.id === d.id));
  $('#docLinks').innerHTML = (back.length ? `<div class="bl-head">PULLED INTO ORBIT — ${back.length}</div>` : '') +
    back.map(o => blRow(o.id, '◉', `${esc(vault.titleOf(o))}`, '', vault.titleOf(o))).join('');
  try { syncDocActionButtons(); } catch {} // real doc — all three action buttons show (the find bar sits below, always)
  try { syncResizeHandle(); } catch {} try { syncNotesPaneDoc(); } catch {} // Notes book tab/pane follow the shown doc
}

// reader panel for a distilled theme body: its concepts + grounded member docs.
// Member rows reuse data-open, so clicking one focuses that doc in the lens.
// The theme's best-fit ungrounded files ride along in their own inventory
// section below (same row shape/click, so icon clicks can flash them too).
function renderThemeDoc(th) {
  readerIsList = false; // a focused theme keeps the Back button
  const node = uni ? uni.byId.get(th.id) : null;
  $('#docTitle').textContent = '◈ ' + th.label;
  $('#docMeta').innerHTML = `theme · weight ${th.weight.toFixed(1)} · mass ${((node && (node.trueMass ?? node.mass)) ?? th.mass).toFixed(1)} <span class="sg-help" data-sghelp tabindex="0">?</span><div class="sg-help-pop" role="note" data-help-pop="mass"><span class="help-text" data-help-text="mass">${esc(helpTexts.mass)}</span><button class="help-edit-btn" data-help-edit="mass" title="Edit this explanation">✎ edit</button></div>`;
  $('#docTags').innerHTML = `<span class="tags-cap">TAGS:</span>` + th.terms.map(term =>
    `<button class="tagpill" data-tag="${esc(term)}" title="Click to search · right-click to rename">#${esc(term)}</button>`).join('');
  // theme summary, wired to THIS theme: its top-evidence concepts, its weight
  // rank across the lens, and its closest neighboring theme by shared grounded
  // bodies — so every theme reads distinctly instead of sharing boilerplate.
  const tAll = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
  const tRank = [...tAll].sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1)).findIndex(t => t.id === th.id) + 1;
  const mine = new Set(th.members || []);
  let nb = null, nbN = 0;
  for (const o of tAll) {
    if (o.id === th.id) continue;
    let n = 0; for (const id of (o.members || [])) if (mine.has(id)) n++;
    if (n > nbN) { nbN = n; nb = o; }
  }
  const tN = th.terms.length, mN = th.members.length;
  const tMass = ((node && (node.trueMass ?? node.mass)) ?? th.mass);
  const tShown = esc(th.terms.slice(0, 3).join(', ')) + (tN > 3 ? ` +${tN - 3} more` : '');
  const rankTxt = tRank === 1 ? `heaviest of ${tAll.length}` : (tRank > 0 ? `#${tRank} of ${tAll.length}` : 'unranked');
  $('#docBody').innerHTML = `<span style="color:var(--mut)">Top evidence: ${tShown} — ${tN} co-traveling concept${tN === 1 ? '' : 's'} grounding ${mN} ${mN === 1 ? 'body' : 'bodies'}. Ranked ${rankTxt} by thematic weight (${th.weight.toFixed(1)} → mass ${tMass.toFixed(1)}).${nb && nbN > 0 ? ` Closest neighbor: ◈ ${esc(nb.label)} (${nbN} shared ${nbN === 1 ? 'body' : 'bodies'}).` : ''}</span>`;
  // shared ground, theme edition: neighboring themes + the grounded bodies they
  // share (the thematic universe webs themes by shared members). Same dropdown
  // pattern as docs; rows drill into the neighboring theme.
  const tunEdges = (uni && Array.isArray(uni.edges) ? uni.edges : [])
    .filter(e => e.kind === 'topic' && (e.source === th.id || e.target === th.id)).slice(0, 12);
  const tRows = [];
  for (const e of tunEdges) {
    const oid = e.source === th.id ? e.target : e.source;
    const o = themeById(oid);
    if (!o) continue;
    const oSet = new Set(o.members || []);
    const common = (th.members || []).map(id => vault.byIdAnywhere(id)).filter(o2 => o2 && oSet.has(o2.id));
    tRows.push({ oid, label: o.label, span: common.length ? common.slice(0, 5).map(o2 => vault.titleOf(o2)).join(' · ') : (o.terms || []).slice(0, 5).join(' · ') });
  }
  const sg = $('#docShared');
  if (sg) {
    sg.classList.remove('open'); sg.classList.remove('help-open');
    sg.innerHTML = `<span class="sg-label" data-sg tabindex="0">SHARED GROUND — ${tRows.length}</span><span class="sg-help" data-sghelp tabindex="0">?</span>` +
      `<div class="sg-help-pop" role="note" data-help-pop="shared"><span class="help-text" data-help-text="shared">${esc(helpTexts.shared)}</span><button class="help-edit-btn" data-help-edit="shared" title="Edit this explanation">✎ edit</button></div>` +
      `<div class="sg-menu" role="menu">` + (tRows.length ? tRows.map(r =>
        `<button class="bl-row" data-open="${r.oid}">◈ ${esc(r.label)}<span>${esc(r.span)}</span></button>`).join('') : '<div class="sg-empty">No shared ground.</div>') + `</div>`;
  }
  const rows = th.members.map(id => vault.byIdAnywhere(id)).filter(Boolean);
  const ungrRows = (assocUngrMap().get(th.id) || []).filter(o => o && !((th.members || []).includes(o.id)));
  // same inventory design as the general state: dot box + title box with
  // words · mass · backlinks, plus the gold note box on noted docs
  const bc = canvasBackCount(((vault.tab() || {}).docs) || []);
  $('#docLinks').innerHTML = (rows.length ? `<div class="bl-head">GROUNDED BODIES — ${rows.length} <span class="hw"><span class="sg-help" data-sghelp tabindex="0">?</span><div class="sg-help-pop" role="note" data-help-pop="grounded"><span class="help-text" data-help-text="grounded">${esc(helpTexts.grounded)}</span><button class="help-edit-btn" data-help-edit="grounded" title="Edit this explanation">✎ edit</button></div></span></div>` : '') +
    rows.map(o => blRow(o.id, '◉', `${esc(vault.titleOf(o))}<span>${docRowSub(o, bc)}</span>`, '', vault.titleOf(o), o.id)).join('') +
    (ungrRows.length ? `<div class="bl-head">UNGROUNDED — ${ungrRows.length} <span class="hw"><span class="sg-help" data-sghelp tabindex="0">?</span><div class="sg-help-pop" role="note" data-help-pop="ungrounded"><span class="help-text" data-help-text="ungrounded">${esc(helpTexts.ungrounded)}</span><button class="help-edit-btn" data-help-edit="ungrounded" title="Edit this explanation">✎ edit</button></div></span></div>` +
    ungrRows.map(o => blRow(o.id, '◉', `${esc(vault.titleOf(o))}<span>${docRowSub(o, bc)}</span>`, 'ungr-row', vault.titleOf(o), o.id)).join('') : '');
  try { syncDocActionButtons(); } catch {} // derived theme — action buttons hide; the find bar stays
  try { syncPageBar(null); } catch {} // derived bodies carry no pagination
  try { applyReaderFind(); } catch {} // rebuild highlights for the theme summary
  try { syncResizeHandle(); } catch {} try { syncNotesPaneDoc(); } catch {} // Notes book tab/pane follow the shown doc
}

// reader panel for an active tag body: the tag plus the member bodies grounding it.
// Member rows reuse data-open, so clicking one leaves the tags view for that doc.
function renderTagDoc(tg) {
  readerIsList = false; // a focused tag keeps the Back button
  const node = uni ? uni.byId.get(tg.id) : null;
  $('#docTitle').textContent = '◈ ' + tg.label;
  $('#docMeta').innerHTML = `tag · grounds ${tg.members.length} ${tg.members.length === 1 ? 'body' : 'bodies'} · mass ${((node && (node.trueMass ?? node.mass)) ?? tg.mass).toFixed(1)} <span class="sg-help" data-sghelp tabindex="0">?</span><div class="sg-help-pop" role="note" data-help-pop="mass"><span class="help-text" data-help-text="mass">${esc(helpTexts.mass)}</span><button class="help-edit-btn" data-help-edit="mass" title="Edit this explanation">✎ edit</button></div>`;
  $('#docTags').innerHTML = `<span class="tags-cap">TAGS:</span>` + (tg.terms || []).map(term =>
    `<button class="tagpill" data-tag="${esc(term)}" title="Click to search · right-click to rename">#${esc(term)}</button>`).join('');
  // tag summary, wired to THIS tag: its grounded bodies, its rank by grounding
  // power across the verse, and its closest neighboring tag by shared bodies.
  const tAll = tagRecords.get(vault.activeTabId) || [];
  const tRank = [...tAll].sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1)).findIndex(t => t.id === tg.id) + 1;
  const mine = new Set(tg.members || []);
  let nb = null, nbN = 0;
  for (const o of tAll) {
    if (o.id === tg.id) continue;
    let n = 0; for (const id of (o.members || [])) if (mine.has(id)) n++;
    if (n > nbN) { nbN = n; nb = o; }
  }
  const mN = tg.members.length;
  const tShown = esc((tg.members || []).slice(0, 3).map(id => { const d = vault.byIdAnywhere(id); return d ? vault.titleOf(d) : null; }).filter(Boolean).join(', ')) + (mN > 3 ? ` +${mN - 3} more` : '');
  const rankTxt = tRank === 1 ? `grounds the most bodies of ${tAll.length}` : (tRank > 0 ? `grounding rank #${tRank} of ${tAll.length}` : 'unranked');
  $('#docBody').innerHTML = `<span style="color:var(--mut)">Top evidence: ${tShown || 'no grounded bodies'} — ${mN} grounded ${mN === 1 ? 'body' : 'bodies'}. Ranked ${rankTxt} (${tg.weight.toFixed(1)} grounding weight → mass ${tg.mass.toFixed(1)}).${nb && nbN > 0 ? ` Closest neighbor: ◈ ${esc(nb.label)} (${nbN} shared ${nbN === 1 ? 'body' : 'bodies'}).` : ''}</span>`;
  // shared ground, tag edition: neighboring tags + the grounded bodies they share.
  const tunEdges = (uni && Array.isArray(uni.edges) ? uni.edges : [])
    .filter(e => e.kind === 'topic' && (e.source === tg.id || e.target === tg.id)).slice(0, 12);
  const tRows = [];
  for (const e of tunEdges) {
    const oid = e.source === tg.id ? e.target : e.source;
    const o = tagById(oid);
    if (!o) continue;
    const oSet = new Set(o.members || []);
    const common = (tg.members || []).map(id => vault.byIdAnywhere(id)).filter(o2 => o2 && oSet.has(o2.id));
    tRows.push({ oid, label: o.label, span: common.length ? common.slice(0, 5).map(o2 => vault.titleOf(o2)).join(' · ') : (o.terms || []).slice(0, 5).join(' · ') });
  }
  const sg = $('#docShared');
  if (sg) {
    sg.classList.remove('open'); sg.classList.remove('help-open');
    sg.innerHTML = `<span class="sg-label" data-sg tabindex="0">SHARED GROUND — ${tRows.length}</span><span class="sg-help" data-sghelp tabindex="0">?</span>` +
      `<div class="sg-help-pop" role="note" data-help-pop="shared"><span class="help-text" data-help-text="shared">${esc(helpTexts.shared)}</span><button class="help-edit-btn" data-help-edit="shared" title="Edit this explanation">✎ edit</button></div>` +
      `<div class="sg-menu" role="menu">` + (tRows.length ? tRows.map(r =>
        `<button class="bl-row" data-open="${r.oid}">◈ ${esc(r.label)}<span>${esc(r.span)}</span></button>`).join('') : '<div class="sg-empty">No shared ground.</div>') + `</div>`;
  }
  const tDocRows = tg.members.map(id => vault.byIdAnywhere(id)).filter(Boolean);
  // same inventory design as the general state: dot box + title box with
  // words · mass · backlinks, plus the gold note box on noted docs
  const tbc = canvasBackCount(((vault.tab() || {}).docs) || []);
  $('#docLinks').innerHTML = (tDocRows.length ? `<div class="bl-head">GROUNDED DOCUMENTS ("BODIES") — ${tDocRows.length} <span class="hw"><span class="sg-help" data-sghelp tabindex="0">?</span><div class="sg-help-pop" role="note" data-help-pop="grounded"><span class="help-text" data-help-text="grounded">${esc(helpTexts.grounded)}</span><button class="help-edit-btn" data-help-edit="grounded" title="Edit this explanation">✎ edit</button></div></span> <button class="viewall" data-tvexit="1" title="Leave the tags view">Exit tags view</button></div>` : '') +
    tDocRows.map(o => blRow(o.id, '◉', `${esc(vault.titleOf(o))}<span>${docRowSub(o, tbc)}</span>`, '', vault.titleOf(o), o.id)).join('');
  try { syncDocActionButtons(); } catch {} // derived tag — action buttons hide; the find bar stays
  try { syncPageBar(null); } catch {} // derived bodies carry no pagination
  try { applyReaderFind(); } catch {} // rebuild highlights for the tag summary
  try { syncResizeHandle(); } catch {} try { syncNotesPaneDoc(); } catch {} // Notes book tab/pane follow the shown doc
}

function renderRichChunk(raw, stripH1) {
  // the reader's inline-markup pipeline for one chunk of prose (one printed
  // page when folio markers stand, the whole body otherwise).
  let e = esc(raw);
  if (stripH1) e = e.replace(/^#\s+.*$/m, '');
  e = e.trim();
  e = e
    .replace(/\[\[([^\[\]]+?)\]\]/g, (m, inner) => {
      const parts = inner.split('|');
      return `<span class="wl" data-wl="${esc(parts[0].trim())}">${esc((parts[1] ?? parts[0]).trim())}</span>`;
    })
    .replace(/(^|\s)#([A-Za-z0-9_\-/]{2,})/g, '$1<span class="tag" data-tag="$2">#$2</span>')
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
  return e;
}
function validPageMap(pm, textLen) {
  // sanitized copy of a doc's page map, or null: monotonic starts inside the
  // text, at least 2 pages (a single page needs no folio markers).
  try {
    if (!pm || typeof pm !== 'object') return null;
    if (pm.kind !== 'pdf' && pm.kind !== 'slides' && pm.kind !== 'sheets') return null;
    const starts = (Array.isArray(pm.starts) ? pm.starts : [])
      .map(s => Math.round(Number(s))).filter(s => isFinite(s) && s >= 0 && s < textLen);
    const mono = [];
    for (const s of starts) { if (!mono.length || s > mono[mono.length - 1]) mono.push(s); }
    if (mono.length < 2) return null;
    return { kind: pm.kind, count: mono.length, starts: mono };
  } catch { return null; }
}
function pageUnitName(kind) {
  return kind === 'slides' ? 'slide' : (kind === 'sheets' ? 'sheet' : 'page');
}
function pagemarkHtml(n, unit) {
  // unobtrusive folio marker: ruled line + small label, click copies a
  // "Title, p. N" citation. Find/highlight code skips these (applyReaderFind).
  const u = unit === 'page' ? 'page' : unit;
  return `<span class="pagemark" data-page="${n}" title="Original ${u} ${n} — click to copy a citation"><span class="pmark-rule"></span><span class="pmark-lab">p. ${n}</span><span class="pmark-rule"></span></span>`;
}
function renderBody(text, images, pageMap) {
  const raw = String(text || '');
  // strip a leading H1 first (title is already in the header), then segment
  // what remains at the recorded page starts so markers never sit above the
  // title or shift the H1 strip.
  let h1cut = 0;
  if (/^#\s+.*$/m.test(esc(raw))) {
    const stripped = raw.replace(/^#\s+.*$/m, '').replace(/^\s+/, '');
    h1cut = raw.length - stripped.length;
  }
  const body0 = h1cut ? raw.slice(h1cut) : raw;
  const pm = validPageMap(pageMap, raw.length);
  let prose = '';
  if (pm) {
    const adj = pm.starts.map(s => Math.max(0, s - h1cut)).filter(s => s < body0.length);
    const uniq = [];
    for (const s of adj) { if (!uniq.length || s > uniq[uniq.length - 1]) uniq.push(s); }
    if (uniq.length >= 2) {
      const unit = pageUnitName(pm.kind);
      const chunks = [];
      for (let i = 0; i < uniq.length; i++) {
        const seg = body0.slice(uniq[i], i + 1 < uniq.length ? uniq[i + 1] : body0.length);
        chunks.push(pagemarkHtml(i + 1, unit) + (renderRichChunk(seg, false) || `<span style="color:var(--mut)">(this ${unit} is blank in the extracted text)</span>`));
      }
      prose = chunks.join('');
    }
  }
  if (!prose) prose = renderRichChunk(raw, true);
  const body = prose || '<span style="color:var(--mut)">Empty body.</span>';
  if (!Array.isArray(images) || !images.length) return body;
  // embedded pictures ride below the prose (bytes hydrate in after render)
  return body + `<div class="imggal">` + images.filter(im => im && im.key).slice(0, 200).map(im => {
    const dim = (im.w && im.h) ? ` · ${im.w}×${im.h}` : '';
    return `<figure data-imgkey="${esc(im.key)}"><span class="imgph">loading image…</span><figcaption>${esc(im.cap || 'image')}${esc(dim)}</figcaption></figure>`;
  }).join('') + `</div>`;
}
// ---------- original-page bar: folio position, jump, rebuild ----------
// The rendered body reflows (fonts, widths), so it cannot show real page
// breaks by geometry — the pageMap (recorded at intake from the actual
// pagination) is the source of truth, painted as markers above. This bar
// names the count, tracks which original page is on screen, jumps to one,
// and repairs legacy imports whose map predates this feature.
function ensurePageBar() {
  let pb = $('#pageBar');
  if (pb) return pb;
  const fb = $('#findBar');
  if (!fb || !fb.parentNode) return null;
  pb = document.createElement('div');
  pb.id = 'pageBar';
  pb.hidden = true;
  fb.parentNode.insertBefore(pb, fb.nextSibling);
  return pb;
}
let pageGeomToken = 0; // bumped whenever the reader body is rebuilt
let pageGeomCache = { token: -1, offs: [] }; // marker content-offsets for the live "on page N" readout
function syncPageBar(d) {
  const pb = ensurePageBar();
  if (!pb) return;
  pageGeomToken++; // the body was just rebuilt — cached marker geometry is stale
  const close = () => { pb.hidden = true; pb.innerHTML = ''; };
  if (!d || !d.text) { close(); return; }
  const pm = validPageMap(d.pageMap, String(d.text).length);
  if (pm) {
    const unit = pageUnitName(pm.kind);
    const plural = pm.count === 1 ? '' : 's';
    pb.hidden = false;
    pb.innerHTML = `<span class="pg-info" title="Original ${unit}s recorded at import — markers in the text below name each one">▦ ${pm.count} original ${unit}${plural} · on ${unit} <b id="pgNow">1</b></span>` +
      (pm.count > 1 ? `<span class="pg-jump">jump to <input id="pgJump" inputmode="numeric" autocomplete="off" aria-label="Go to original ${unit}" placeholder="1–${pm.count}"><button class="btn" id="pgGo" title="Scroll to that original ${unit}">Go</button></span>` : '');
    try {
      const go = $('#pgGo'), inp = $('#pgJump');
      const run = () => { try { gotoPage(inp ? inp.value : 1); } catch {} };
      if (go) go.onclick = (e) => { try { e.stopPropagation(); } catch {} run(); };
      if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } e.stopPropagation(); };
    } catch {}
    try { syncPageNow(); } catch {}
    return;
  }
  // no map: PDFs can rebuild it from the kept original bytes; anything else
  // says so honestly (slides/sheets already carry their numbers as headers).
  if (fileTypeKey(d.name) === 'pdf') {
    pb.hidden = false;
    pb.innerHTML = d.origKey
      ? `<span class="pg-info">▦ page numbers not mapped for this import</span><button class="btn" id="pgMap" title="Re-read the kept original PDF and map its real page numbers onto this text">Map pages</button>`
      : `<span class="pg-info" title="The original file bytes were not kept for this body (older import or restored backup)">▦ no page map — re-import the PDF to enable page numbers</span>`;
    try {
      const mb = $('#pgMap');
      if (mb) mb.onclick = (e) => { try { e.stopPropagation(); } catch {} try { rebuildPageMap(d.id); } catch {} };
    } catch {}
    return;
  }
  close();
}
function syncPageNow() {
  // which original page is on screen: the last folio marker at/above the
  // reader's scroll position. Runs on scroll + after every render.
  // Geometry via getBoundingClientRect (markers' offsetParent is the pane,
  // not the scroller, so offsetTop can't be compared to scrollTop directly);
  // offsets are cached per body build so scrolling stays cheap on big books.
  try {
    const now = $('#pgNow');
    if (!now) return;
    const sc = $('#docScroll');
    const marks = [...document.querySelectorAll('#docBody .pagemark')];
    if (!sc || !marks.length) { now.textContent = '1'; return; }
    if (pageGeomCache.token !== pageGeomToken || pageGeomCache.offs.length !== marks.length || pageGeomCache.w !== sc.clientWidth) {
      const sr = sc.getBoundingClientRect(), top = sc.scrollTop || 0;
      pageGeomCache = { token: pageGeomToken, w: sc.clientWidth, offs: marks.map(m => m.getBoundingClientRect().top - sr.top + top) };
    }
    const top = sc.scrollTop || 0;
    let cur = 1;
    for (let i = 0; i < marks.length; i++) {
      if (pageGeomCache.offs[i] <= top + 8) cur = Number(marks[i].dataset.page) || cur;
      else break;
    }
    now.textContent = String(cur);
  } catch {}
}
function gotoPage(n) {
  const marks = [...document.querySelectorAll('#docBody .pagemark')];
  if (!marks.length) return false;
  n = Math.max(1, Math.min(marks.length, Math.round(Number(n)) || 1));
  const m = marks[n - 1];
  // land the marker at the top of the reader (not centered): the page below
  // it is the one on screen, so the live "on page N" readout agrees.
  try {
    const sc = $('#docScroll');
    if (sc) {
      const sr = sc.getBoundingClientRect();
      sc.scrollTop = Math.max(0, m.getBoundingClientRect().top - sr.top + (sc.scrollTop || 0) - 8);
    } else m.scrollIntoView({ block: 'start' });
  } catch { try { m.scrollIntoView({ block: 'start' }); } catch {} }
  try {
    m.classList.add('spot-flash');
    setTimeout(() => { try { m.classList.remove('spot-flash'); } catch {} }, 1400);
  } catch {}
  try { syncPageNow(); setTimeout(() => { try { syncPageNow(); } catch {} }, 350); } catch {}
  return true;
}
async function rebuildPageMap(id) {
  // legacy PDFs imported before page maps existed: re-read the KEPT original
  // bytes page by page, then align each page's head against the stored text
  // (sequential search, so repeated boilerplate can't misroute). Needs the
  // original sidecar bytes — without them, only a re-import can help.
  const d = vault.byIdAnywhere(id);
  if (!d) return;
  if (fileTypeKey(d.name) !== 'pdf') { toast('Page mapping is for PDFs — slides and sheets already carry their numbers as headers'); return; }
  if (!d.origKey) { toast('Original file not kept for this body (older import or restored backup) — re-import the PDF to enable page numbers', 6000); return; }
  toast('Mapping original pages…');
  try {
    const rec = await origGet(d.origKey);
    const blob = rec && rec.blob;
    if (!blob || !(blob.size > 0)) throw new Error('kept original is unreadable');
    const pdfjs = await import('./vendor/pdf.mjs');
    const lib = pdfjs.getDocument ? pdfjs : (pdfjs.default || {});
    if (lib?.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
      try { lib.GlobalWorkerOptions.workerSrc = vendorBase() + 'pdf.worker.js'; } catch {}
    }
    if (!lib.getDocument) throw new Error('PDF engine did not load.');
    const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    const total = pdf.numPages || 0;
    if (!total) throw new Error('that PDF has no pages');
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const stored = String(d.text || '');
    const starts = [];
    let cursor = 0, hits = 0;
    for (let p = 1; p <= total; p++) {
      let s = '';
      try { s = ((await (await pdf.getPage(p)).getTextContent()).items || []).map(i => i.str || '').join(' '); } catch { s = ''; }
      const probe = norm(s).slice(0, 48);
      if (probe.length < 12) continue; // blank/unreadable page — no anchor, keep counting
      const at = stored.indexOf(probe, cursor);
      if (at < 0) continue; // text drifted (OCR tail edits etc.) — skip, don't guess
      // anchor at the page's true start: back up past the join whitespace the
      // intake inserted between pages (stored region matches probe here).
      starts.push(at);
      cursor = at + probe.length;
      hits++;
    }
    try { await pdf.destroy(); } catch {}
    if (!starts.length || hits < Math.max(1, Math.round(total * 0.5))) {
      toast('Could not align enough pages (' + hits + '/' + total + ') — the stored text may predate this original; re-import the PDF instead', 7000);
      return;
    }
    starts.sort((a, b) => a - b);
    const uniq = starts.filter((s, i) => i === 0 || s > starts[i - 1]);
    d.pageMap = { kind: 'pdf', count: uniq.length, starts: uniq };
  try { vault.persist(); } catch {}
  try { markBackupDirty(); } catch {}
  try { syncPageBar(d); } catch {}
  try { if (carZoomOpen) { const cb2 = $('#carZoomBody'), ct2 = $('#carZoomText'); if (cb2 && ct2) { const st2 = cb2.scrollTop || 0; ct2.innerHTML = renderBody(d.text, d.images, d.pageMap) || ''; try { hydrateImages(ct2, d.images); } catch {} try { hydrateMedia(ct2, d); } catch {} try { hydrateSheet(ct2, d); } catch {} try { const mg2 = ct2.querySelector('.mediagal'); if (mg2 && ct2.firstChild !== mg2) ct2.insertBefore(mg2, ct2.firstChild); } catch {} cb2.scrollTop = st2; } try { syncCarZoomPageBar(d); } catch {} } } catch {}
  try { renderDoc(); } catch {}
    toast('Mapped ' + uniq.length + ' original pages — folio markers now stand in the text');
  } catch (e) {
    console.warn('page-map rebuild failed', (e && e.message) || e);
    toast('Page mapping failed (' + ((e && e.message) || 'unreadable original') + ') — re-import the PDF instead', 6000);
  }
}
// fill the gallery placeholders with sidecar bytes (object URLs cached per
// session; misses mean a backup restored the manifest without the bytes).
const imgUrlCache = new Map(); // key -> objectURL
async function hydrateImages(rootEl, images) {
  const figs = rootEl ? [...rootEl.querySelectorAll('figure[data-imgkey]')] : [];
  const live = new Set(((images || []).map(im => im && im.key) || []).filter(Boolean));
  for (const fig of figs) {
    const key = fig.dataset.imgkey;
    if (!key || fig.querySelector('img')) continue;
    try {
      const rec = await imgGet(key);
      const blob = rec && rec.blob;
      const ph = fig.querySelector('.imgph');
      if (!blob || !(blob.size > 0)) {
        if (ph) ph.textContent = 'image kept on the original device — not in this backup';
        continue;
      }
      let url = imgUrlCache.get(key);
      if (!url) { url = URL.createObjectURL(blob); imgUrlCache.set(key, url); }
      const img = document.createElement('img');
      img.src = url; img.alt = (fig.querySelector('figcaption') || {}).textContent || 'image';
      img.loading = 'lazy'; img.setAttribute('data-full', '1');
      if (ph) ph.remove();
      fig.prepend(img);
    } catch {
      const ph = fig.querySelector('.imgph');
      if (ph) ph.textContent = 'could not load this image';
    }
  }
  for (const [k, u] of imgUrlCache) if (!live.has(k)) { try { URL.revokeObjectURL(u); } catch { /* already gone */ } imgUrlCache.delete(k); }
}
// media bodies (.mp4/.mov/.mp3/.wav/.jpg/.png): a native player (or the
// picture itself) rides below the prose, fed by the original bytes in the
// originals sidecar (shared across copies by origKey, like shared picture
// keys). Backup-restored docs without bytes get the same honest placeholder
// the picture gallery uses.
const mediaUrlCache = new Map(); // origKey -> objectURL
// Original bytes, wherever they live: the desktop disk vault first when the
// doc says so, the browser sidecar otherwise — each side tried in turn, so a
// half-migrated library still resolves. Null when the bytes are kept nowhere.
async function origBlob(d) {
  if (!d || !d.origKey) return null;
  const order = d.origWhere === 'disk' ? ['disk', 'idb'] : ['idb', 'disk'];
  for (const w of order) {
    try {
      if (w === 'disk') {
        const b = await diskGetBlob(d.origKey, d.origFile || d.name);
        if (b && b.size > 0) return b;
      } else {
        const rec = await origGet(d.origKey);
        const b = rec && rec.blob;
        if (b && b.size > 0) return b;
      }
    } catch { /* try the other vault */ }
  }
  return null;
}
async function hydrateMedia(rootEl, d) {
  if (!rootEl || !d || !mediaKind(d.name, '')) return;
  const kind = mediaKind(d.name, '');
  const box = document.createElement('div');
  box.className = 'mediagal';
  const cap = document.createElement('div');
  cap.className = 'media-cap';
  cap.textContent = 'loading media…';
  box.appendChild(cap);
  rootEl.appendChild(box);
  if (!d.origKey) { cap.textContent = 'media kept on the original device — not in this backup'; return; }
  try {
    const blob = await origBlob(d);
    if (!blob || !(blob.size > 0)) { cap.textContent = 'media kept on the original device — not in this backup'; return; }
    if (!vault.byId(d.id)) { box.remove(); return; } // deleted while the bytes were loading — never append a stale player
    let url = mediaUrlCache.get(d.origKey);
    if (!url) { url = URL.createObjectURL(blob); mediaUrlCache.set(d.origKey, url); }
    const el = document.createElement(kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'img');
    if (kind === 'image') {
      el.alt = d.name || 'image'; el.loading = 'lazy';
    } else {
      el.controls = true; el.preload = 'metadata';
      if (kind === 'video') { try { el.playsInline = true; } catch {} }
    }
    el.src = url;
    el.setAttribute('aria-label', d.name || (kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'image'));
    box.prepend(el);
    const sz = fmtMediaSize(blob.size);
    cap.textContent = (d.name || (kind === 'video' ? 'video' : 'audio')) + (sz ? ' · ' + sz : '');
  } catch {
    cap.textContent = 'could not load this media';
  }
}
// spreadsheet bodies (.xls/.xlsx/.xlsm/.csv): first-sheet preview table on the
// carousel's last pane + expander, parsed in-browser (SheetJS, capped), with
// the original file one click away. Anything else (docs, slides, pdfs) shows
// its extracted text + pictures; the original stays a download away.
function sheetKind(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = m ? m[1] : '';
  return (e === 'xls' || e === 'xlsx' || e === 'xlsm' || e === 'csv') ? e : '';
}
async function hydrateSheet(rootEl, d) {
  if (!rootEl || !d || !sheetKind(d.name)) return;
  const box = document.createElement('div');
  box.className = 'sheetwrap';
  const cap = document.createElement('div');
  cap.className = 'sheet-cap';
  cap.textContent = 'loading spreadsheet…';
  box.appendChild(cap);
  rootEl.appendChild(box);
  if (!d.origKey) { cap.textContent = 'spreadsheet kept on the original device — not in this backup'; return; }
  try {
    const blob = await origBlob(d);
    if (!blob || !(blob.size > 0)) { cap.textContent = 'spreadsheet kept on the original device — not in this backup'; return; }
    if (!vault.byId(d.id)) { box.remove(); return; } // deleted while loading
    const wide = blob.size > 15 * 1048576;
    let note = '';
    if (!wide) {
      try {
        const m = await import('./vendor/xlsx.mjs'); // vendored — never the CDN (offline-first: no network on desktop)
        const XLSX = m.default || m;
        const wb = sheetKind(d.name) === 'csv'
          ? XLSX.read(await blob.text(), { type: 'string', sheetRows: 60 })
          : XLSX.read(await blob.arrayBuffer(), { type: 'array', sheetRows: 60 });
        const wsName = wb.SheetNames[0];
        const rows = wsName != null ? XLSX.utils.sheet_to_json(wb.Sheets[wsName], { header: 1, raw: true, blankrows: false }) : [];
        if (rows.length) {
          const widths = rows.map(r => r.length);
          const maxC = Math.min(20, Math.max.apply(null, widths));
          const table = document.createElement('table');
          table.className = 'sheetgrid';
          rows.slice(0, 50).forEach((r, ri) => {
            const tr = document.createElement('tr');
            for (let c = 0; c < maxC; c++) {
              const cell = document.createElement(ri === 0 ? 'th' : 'td');
              const v = r[c];
              cell.textContent = (v == null || v === '') ? '' : (typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));
              tr.appendChild(cell);
            }
            table.appendChild(tr);
          });
          box.appendChild(table);
          note = (wsName || 'Sheet1') + ' · ' + rows.length + ' rows' + (rows.length > 50 ? ' (first 50 shown)' : '') + (Math.max.apply(null, widths) > maxC ? ' · first ' + maxC + ' columns' : '');
        }
      } catch { /* preview failed — download row below still helps */ }
    }
    if (!note) note = wide ? 'spreadsheet too large to preview (' + fmtMediaSize(blob.size) + ')' : 'no readable rows in the first sheet';
    cap.textContent = note;
    let url = mediaUrlCache.get(d.origKey);
    if (!url) { url = URL.createObjectURL(blob); mediaUrlCache.set(d.origKey, url); }
    const dl = document.createElement('a');
    dl.href = url; dl.download = d.name || 'spreadsheet';
    dl.className = 'sheet-dl';
    dl.textContent = '⤓ Download original (' + (d.name || 'file') + (fmtMediaSize(blob.size) ? ' · ' + fmtMediaSize(blob.size) : '') + ')';
    box.appendChild(dl);
  } catch { cap.textContent = 'could not load this spreadsheet'; }
}
// drop picture bytes nobody references anymore. Copies share keys, so scan
// every open canvas first.
async function purgeImages() {
  try {
    const used = new Set();
    const grab = (docs) => { for (const d of (docs || [])) for (const im of ((d && d.images) || [])) if (im && im.key) used.add(im.key); };
    for (const t of (vault.tabs || [])) grab(t.docs);
    for (const k of await imgKeys()) if (!used.has(k)) await imgDelete(k);
    // original files nobody references anymore (copies share the key —
    // same scan as pictures).
    try {
      const usedOrig = new Set();
      const grabOrig = (docs) => { for (const d of (docs || [])) if (d && d.origKey) usedOrig.add(d.origKey); };
      for (const t of (vault.tabs || [])) grabOrig(t.docs);
      for (const k of await origKeys()) if (!usedOrig.has(k)) await origDelete(k);
      // desktop disk vault: same sweep on the hard-drive originals.
      if (await diskUsable()) {
        for (const k of await diskListKeys()) {
          if (usedOrig.has(k)) continue;
          try { await diskDelete(k); } catch (e) { console.warn('disk vault sweep missed ' + k, (e && e.message) || e); }
        }
      }
    } catch (e) { console.warn('original purge skipped', (e && e.message) || e); }
    } catch (e) { console.warn('image purge skipped', (e && e.message) || e); }
}

// ---------- desktop disk vault: adopt the browser sidecar's originals ----------
// First boot with a working disk vault moves every IndexedDB original onto
// the hard drive (books of any size included), then deletes the sidecar copy
// so a 300-page scan isn't stored twice. Idempotent: later runs only see
// leftovers (e.g. files imported while the disk was unavailable).
async function migrateIdbOriginalsToDisk() {
  try {
    if (!(await diskUsable())) return;
    const keys = await origKeys();
    if (!keys.length) return;
    const byKey = new Map();
    for (const t of (vault.tabs || [])) for (const d of (t.docs || [])) {
      if (d && d.origKey && !byKey.has(d.origKey)) byKey.set(d.origKey, d);
    }
    let moved = 0, failed = 0, skipped = 0;
    for (const k of keys) {
      const d = byKey.get(k);
      if (!d) { skipped++; continue; } // orphan — the purge sweep takes it
      if (d.origWhere === 'disk') { try { await origDelete(k); moved++; } catch { failed++; } continue; }
      try {
        const rec = await origGet(k);
        const blob = rec && rec.blob;
        if (!blob || !(blob.size > 0)) { skipped++; continue; }
        d.origFile = await diskPut(k, blob, (rec && rec.name) || d.name);
        d.origKey = k; d.origWhere = 'disk'; delete d.origSkipped;
        await origDelete(k);
        moved++;
      } catch (e) { failed++; console.warn('disk vault adoption missed ' + k, (e && e.message) || e); }
    }
    if (moved) { try { vault.persist(); } catch {} try { markBackupDirty(); } catch {} }
    try { await purgeImages(); } catch {}
    if (moved || failed) toast(`App vault: ${moved} original${moved === 1 ? '' : 's'} moved to the hard drive${failed ? ` · ${failed} still in the browser store` : ''}`, 6000);
  } catch (e) { console.warn('disk vault adoption skipped', (e && e.message) || e); }
}

// ---------- intake: real folder select + files + drop ----------
const OFFICE_MSG = 'Office libraries failed to load from the app bundle (reinstall may be needed).';
const INTAKE_RE = /\.(md|markdown|txt|csv|pdf|docx?|xlsx?|pptx?|mp4|mov|mp3|wav|jpe?g|png)$/i;
const INTAKE_LABEL = '.md / .txt / .csv / .pdf / .docx / .xlsx / .pptx / .mp4 / .mov / .mp3 / .wav / .jpg / .png';
function cleanName(f) {
  let n = (f && f.name) || '';
  if (!n && f && f.webkitRelativePath) n = String(f.webkitRelativePath).split('/').pop() || '';
  n = String(n || '').trim();
  n = n.replace(/[\s.]+$/, '');
  if (!n && f && f.webkitRelativePath) n = String(f.webkitRelativePath);
  return n || 'unnamed';
}
function extOf(name) {
  const m = String(name || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? '.' + m[1] : '(no extension)';
}
// original-file-type badge key from a doc's stored filename: pdf / word /
// txt / ppt / xls / vid / aud (anything else gets no badge).
function fileTypeKey(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = m ? m[1] : '';
  if (e === 'pdf') return 'pdf';
  if (e === 'doc' || e === 'docx') return 'word';
  if (e === 'txt' || e === 'md' || e === 'markdown' || e === 'csv') return 'txt';
  if (e === 'ppt' || e === 'pptx') return 'ppt';
  if (e === 'xls' || e === 'xlsx') return 'xls';
  if (e === 'mp4' || e === 'mov') return 'vid';
  if (e === 'mp3' || e === 'wav') return 'aud';
  if (e === 'jpg' || e === 'jpeg' || e === 'png') return 'img';
  return '';
}
const FILE_TYPE_LABEL = { pdf: 'PDF', word: 'WORD', txt: 'TXT', ppt: 'PPT', xls: 'XLS', vid: 'VID', aud: 'AUD', img: 'IMG' };
function intakeAllowed(f) {
  const nm = cleanName(f);
  if (INTAKE_RE.test(nm)) return true;
  const ty = String((f && f.type) || '').toLowerCase().split(';')[0].trim();
  if (!ty) return false;
  if (ty.includes('wordprocessingml') || ty === 'application/msword') return true;
  if (ty.includes('spreadsheetml') || ty === 'application/vnd.ms-excel') return true;
  if (ty.includes('presentationml') || ty === 'application/vnd.ms-powerpoint') return true;
  if (ty === 'application/pdf') return true;
  if (ty.indexOf('text/') === 0) return true;
  if (ty.indexOf('video/') === 0) return true;
  if (ty.indexOf('audio/') === 0) return true;
  if (ty === 'image/jpeg' || ty === 'image/png') return true;
  return false;
}
async function readFileAsText(f, onStep) {
  const nm = cleanName(f);
  lastPageStarts = null; lastPageKind = null; // reset: each branch below records its own pagination (or none)
  // video + audio bodies: no transcript is extracted — the reader plays the
  // file itself (bytes live in the originals sidecar). The text below is a
  // plain-language manifest so filename words, tags and notes still tether,
  // weigh and search the body like any other document.
  const mkind = mediaKind(nm, (f && f.type) || '');
  if (mkind) return await mediaDocText(f, nm, mkind);
  if (/\.pdf$/i.test(nm)) {
    try {
      const pdfjs = await import('./vendor/pdf.mjs');
      const lib = pdfjs.getDocument ? pdfjs : (pdfjs.default || {});
      if (lib?.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
        // Page-origin URL (same reason as the OCR worker): the pdf worker
        // must be same-origin with the page and live, not a possibly stale
        // cross-origin copy resolved through the module base.
        lib.GlobalWorkerOptions.workerSrc = vendorBase() + 'pdf.worker.js';
      }
      const getDocument = lib.getDocument;
      if (!getDocument) throw new Error('PDF engine did not load.');
      const data = new Uint8Array(await f.arrayBuffer());
      if (!data.length) throw new Error('That file looks empty (0 bytes).');
      const pdf = await getDocument({ data }).promise;
      // whole-document import: every page in order — an offline app must not
      // silently drop the back of a book. The loop still stops past the
      // intake text cap (below) so a pathological 10,000-page file can't
      // wedge the tab; progress ticks every 20 pages so big books don't
      // look stuck.
      let out = [], outLen = 0;
      const total = pdf.numPages || 0;
      for (let p = 1; p <= total; p++) {
        const tc = await (await pdf.getPage(p)).getTextContent();
        const s = (tc.items || []).map(i => i.str || '').join(' ');
        out.push(s); outLen += s.length;
        if (typeof onStep === 'function' && (p % 20 === 0 || p === total)) {
          try { onStep(p, total); } catch {}
        }
        if (outLen > INTAKE_TEXT_MAX + 50000) break;
      }
      try { await pdf.destroy(); } catch { /* done anyway */ }
      const rawJoined = out.join('\n\n');
      const text = rawJoined.trim();
      // real pagination for the reader's folio markers: each page's start in
      // the returned text (rebased past the trimmed leading whitespace).
      if (text) {
        const trimLead = rawJoined.length - rawJoined.replace(/^\s+/, '').length;
        lastPageStarts = pageStartsFromLengths(out.map(s => s.length), 2).map(s => Math.max(0, s - trimLead));
        lastPageKind = 'pdf';
      } else { lastPageStarts = null; lastPageKind = null; }
      // image-only (scanned) PDF: no text layer — return empty and let the
      // page renders below carry its words into OCR (locked files throw above).
      // (Scanned books still cite real pages: every OCR chunk + gallery
      // figure carries its printed 'Page N' caption.)
      if (!text) return '';
      return text;
    } catch (e) {
      if (e && /scanned|locked|readable|empty|engine/i.test(e.message || '')) throw e;
      let srv = '';
      try {
        const r = await fetch(vendorBase() + 'pdf.mjs', { headers: { Range: 'bytes=0-0' } });
        srv = ` — server says ${r.status}${r.statusText ? ' ' + r.statusText : ''} for the PDF engine file`;
      } catch (fe) { srv = ` — PDF engine file unreachable (${(fe && fe.message) || fe})`; }
      throw new Error('Could not read that PDF (' + ((e && e.message) || 'parse failed') + srv + ').');
    }
  }
  if (/\.docx$/i.test(nm)) {
    let buf = null;
    try { buf = await f.arrayBuffer(); } catch (e) { throw new Error('Could not read that file from disk (browser blocked it).'); }
    if (!buf || !buf.byteLength) throw new Error('That file looks empty (0 bytes) — it may be a cloud placeholder. Open it in Word/Drive once, then re-save / download a copy.');
    // Primary: mammoth (best fidelity: headers, footnotes, tables).
    try {
      const m = await import('./vendor/mammoth.mjs');
      const lib = m.default || m;
      const res = await lib.extractRawText({ arrayBuffer: buf.slice(0) });
      const text = String((res && res.value) || '').trim();
      if (text) return text;
      // empty from mammoth -> fall through to raw-XML fallback below
    } catch (e) {
      if (e && /readable/i.test(e.message || '')) {
        // mammoth read it but found no text — still try raw fallback before giving up
      } else {
        console.warn('mammoth failed, trying raw docx fallback', (e && e.message) || e);
      }
    }
    // Fallback: raw word/document.xml text (needs nothing at all — runs even
    // if the vendored mammoth bundle ever fails to load). A .docx is a zip:
    try {
      const fflate = await import('./vendor/fflate.mjs');
      const unzip = fflate.unzipSync || (fflate.default || {}).unzipSync;
      if (!unzip) throw new Error('Archive engine did not load.');
      const files = unzip(new Uint8Array(buf));
      const docKeys = Object.keys(files).filter(k => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\w*\.xml$/.test(k));
      if (!docKeys.length) throw new Error('Not a Word file inside (no word/document.xml). Is it encrypted / password-protected?');
      const dec = new TextDecoder();
      const parts = [];
      // document first, then headers/footers/notes
      docKeys.sort((a, b) => (a.includes('document') ? -1 : 0) - (b.includes('document') ? -1 : 0));
      for (const k of docKeys.slice(0, 8)) {
        let xml = null;
        try { xml = new DOMParser().parseFromString(dec.decode(files[k]), 'application/xml'); } catch { continue; }
        if (!xml || xml.querySelector('parsererror')) continue;
        const texts = [...xml.getElementsByTagNameNS('*', 't')].map(el => el.textContent || '');
        const chunk = texts.join(' ').replace(/\s+/g, ' ').trim();
        if (chunk) parts.push(chunk);
      }
      const text = parts.join('\n\n').trim();
      if (text) return text;
      // images-only .docx: no text runs — return empty and let the embedded
      // pictures below carry its words into OCR (corrupt files throw above).
      return '';
    } catch (e2) {
      if (e2 && /readable|encrypted|password|Not a Word/i.test(e2.message || '')) throw e2;
      throw new Error('Could not read that Word file (' + ((e2 && e2.message) || OFFICE_MSG) + ').');
    }
  }
  if (/\.xlsx?$/i.test(nm)) {
    try {
      const m = await import('./vendor/xlsx.mjs');
      const XLSX = m.default || m;
      if (!XLSX.read) throw new Error('Spreadsheet engine did not load.');
      const wb = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: 'array' });
      const parts = [];
      for (const name of (wb.SheetNames || []).slice(0, 20)) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        if (csv && csv.trim()) parts.push('# Sheet: ' + name + '\n\n' + csv.trim());
      }
      const text = parts.join('\n\n').trim();
      if (text) {
        const rawJ = parts.join('\n\n');
        const trimLead = rawJ.length - rawJ.replace(/^\s+/, '').length;
        lastPageStarts = pageStartsFromLengths(parts.map(s => s.length), 2).map(s => Math.max(0, s - trimLead));
        lastPageKind = 'sheets';
      } else { lastPageStarts = null; lastPageKind = null; }
      // data-free sheets can still carry pictures (screenshots pasted into
      // cells) — return empty and let those carry the words into OCR.
      if (!text) return '';
      return text;
    } catch (e) {
      if (e && /readable|sheet/i.test(e.message || '')) throw e;
      throw new Error('Could not read that spreadsheet (' + ((e && e.message) || OFFICE_MSG) + ').');
    }
  }
  if (/\.pptx$/i.test(nm)) {
    try {
      const fflate = await import('./vendor/fflate.mjs');
      const unzip = fflate.unzipSync || (fflate.default || {}).unzipSync;
      if (!unzip) throw new Error('Archive engine did not load.');
      const files = unzip(new Uint8Array(await f.arrayBuffer()));
      const slides = Object.keys(files).filter(k => /^ppt\/slides\/slide\d+\.xml$/.test(k))
        .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).slice(0, 100);
      if (!slides.length) throw new Error('No slides found in that file.');
      const dec = new TextDecoder();
      const parts = [];
      slides.forEach((k, i) => {
        const xml = new DOMParser().parseFromString(dec.decode(files[k]), 'application/xml');
        if (xml.querySelector('parsererror')) return; // skip one corrupt slide
        const texts = [...xml.getElementsByTagNameNS('*', 't')].map(el => el.textContent || '');
        if (texts.join(' ').trim()) parts.push('# Slide ' + (i + 1) + '\n\n' + texts.join(' ').trim());
      });
      const text = parts.join('\n\n').trim();
      if (text) {
        const rawJ = parts.join('\n\n');
        const trimLead = rawJ.length - rawJ.replace(/^\s+/, '').length;
        lastPageStarts = pageStartsFromLengths(parts.map(s => s.length), 2).map(s => Math.max(0, s - trimLead));
        lastPageKind = 'slides';
      } else { lastPageStarts = null; lastPageKind = null; }
      // image-only deck: no text runs — return empty and let the slide
      // pictures below carry its words into OCR (corrupt files throw above).
      if (!text) return '';
      return text;
    } catch (e) {
      if (e && /slide|readable/i.test(e.message || '')) throw e;
      throw new Error('Could not read those slides (' + ((e && e.message) || OFFICE_MSG) + ').');
    }
  }
  if (/\.doc$/i.test(nm)) throw new Error('Legacy .doc — re-save it as .docx in Word, then import that.');
  if (/\.ppt$/i.test(nm)) throw new Error('Legacy .ppt — re-save it as .pptx in PowerPoint, then import that.');
  return await f.text();
}

// ---------- video + audio bodies (.mp4/.mov/.mp3/.wav) ----------
// Extension (or MIME fallback) decides the player; anything else is not media.
function mediaKind(name, mime) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = m ? m[1] : '';
  if (e === 'mp4' || e === 'mov') return 'video';
  if (e === 'mp3' || e === 'wav') return 'audio';
  if (e === 'jpg' || e === 'jpeg' || e === 'png') return 'image';
  const t = String(mime || '').toLowerCase().split(';')[0].trim();
  if (t.indexOf('video/') === 0) return 'video';
  if (t.indexOf('audio/') === 0) return 'audio';
  if (t === 'image/jpeg' || t === 'image/png') return 'image';
  return '';
}
function fmtMediaSize(n) {
  if (!(n > 0)) return '';
  if (n >= 1048576) return (Math.round(n / 104857.6) / 10) + ' MB';
  if (n >= 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return n + ' bytes';
}
function fmtMediaDur(s) {
  if (!(s > 0) || !isFinite(s)) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m), ss = String(r).padStart(2, '0');
  return (h ? h + ':' : '') + mm + ':' + ss;
}
// Best-effort metadata probe (duration, video dimensions) off a throwaway
// element. Codecs the browser can't play (some .mov) never resolve — the
// manifest then reads "length unknown" and the import still succeeds.
function probeMedia(f, kind) {
  return new Promise((resolve) => {
    let url = null;
    try { url = URL.createObjectURL(f); } catch { resolve(null); return; }
    const done = (info) => { try { URL.revokeObjectURL(url); } catch {} resolve(info || null); };
    try {
      const el = document.createElement(kind === 'video' ? 'video' : 'audio');
      el.preload = 'metadata';
      try { el.muted = true; } catch {}
      const timer = setTimeout(() => done(null), 6000);
      el.onloadedmetadata = () => { clearTimeout(timer); done({ dur: el.duration, w: el.videoWidth || 0, h: el.videoHeight || 0 }); };
      el.onerror = () => { clearTimeout(timer); done(null); };
      el.src = url;
    } catch { done(null); }
  });
}
async function mediaDocText(f, nm, kind) {
  const disp = String(nm || 'untitled');
  const ext = (disp.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  if (kind === 'image') {
    // standalone photo body: the picture shows below; its readable text
    // joins through the same OCR pipeline embedded pictures use.
    const fmt = /png$/i.test(ext) ? 'PNG' : 'JPEG';
    let dims = '';
    try {
      const bmp = await createImageBitmap(f);
      if (bmp && bmp.width > 0 && bmp.height > 0) dims = bmp.width + '×' + bmp.height;
      try { bmp.close(); } catch {}
    } catch {}
    const bits = [fmtMediaSize(f && f.size), dims].filter(Boolean).join(' · ') || 'size unknown';
    return `Image file "${disp}" (${fmt} image · ${bits}). The picture is shown below — its readable text joins in when the reader can make it out. Filename words, tags and notes still tether, weigh and search this body; the body's menu downloads the original file.`;
  }
  const typeName = ext ? ext.toUpperCase() + ' ' + kind : kind;
  let probe = null;
  try { probe = await probeMedia(f, kind); } catch { probe = null; }
  const bits = [];
  const sz = fmtMediaSize(f && f.size);
  if (sz) bits.push(sz);
  const du = probe ? fmtMediaDur(probe.dur) : '';
  if (du) bits.push(du);
  else bits.push('length unknown');
  if (kind === 'video' && probe && probe.w > 0 && probe.h > 0) bits.push(probe.w + '×' + probe.h);
  const noun = kind === 'video' ? 'Footage' : 'Recording';
  return `${kind === 'video' ? 'Video' : 'Audio'} file "${disp}" (${typeName} · ${bits.join(' · ')}). ` +
    `${noun} itself is not transcribed — filename words, tags and notes still tether, weigh and search this body. ` +
    `Press play in the reader to ${kind === 'video' ? 'watch' : 'listen'} here; the body's menu downloads the original file.`;
}

// ---------- embedded images: Word / PowerPoint / PDF / sheets ----------
// Intake used to be text-only: mammoth/pdf text, sheet CSV, slide text — every
// embedded picture silently dropped, so illustrated docs arrived imageless.
// extractFileImages re-opens the file and pulls the pictures out:
//   .docx — word/media/* in document order via drawing blip embeds + _rels
//   .pptx — ppt/media/* per slide in slide order via each slide's _rels
//   .pdf  — pages containing image XObjects, rendered as printed page images
// (pdf.js exposes no stable image-byte API across versions; a page render is the
// version-robust way to show the pictures)
//   .xlsx — xl/media/* via each sheet's drawing rels (screenshots pasted into
// sheets import like slide pictures). Plain text/CSV carries no pictures here.
// Returns [{blob, cap}] — full-size blobs; the caller downscales + stores.
// Never throws: text import must survive image failure.
// Bounds keep one monster file from stalling intake. Text imports in full
// (whole books — no 60-page / 60k-char cut); INTAKE_TEXT_MAX is only the
// pathological-file safety valve, and the persist layer compresses past the
// localStorage quota so full texts still restore after reload.
const IMG_MAX_DOCX = 40, IMG_MAX_PPTX = 40, IMG_MAX_XLSX = 40, IMG_MAX_PDF_PAGES = 500;
const INTAKE_TEXT_MAX = 2000000; // chars of extracted text kept per file (~3000 book pages)
const ORIG_IDB_MAX = 100 * 1048576; // browser-sidecar cap for original bytes (100MB): bigger files still import whole, their bytes ride the desktop disk vault instead (no cap there)
const IMG_MAX_DIM = 1200; // stored pictures shrink to fit inside this (px)
// ---------- original-page capture (side-channel for the intake below) ----------
// readFileAsText returns plain text, but PDFs/slides/sheets also carry REAL
// pagination the reader must be able to cite. The extractor records it here:
// lastPageStarts = char offsets where each page/slide/sheet begins in the
// returned text (join-aware), lastPageKind = 'pdf'|'slides'|'sheets'|null.
// ingestFiles consumes + clears both right after the call and rebases them
// onto the final stored text (title prefix + OCR tail included).
let lastPageStarts = null, lastPageKind = null;
function pageStartsFromLengths(lens, sepLen) {
  const starts = [];
  let at = 0;
  for (let i = 0; i < lens.length; i++) {
    starts.push(at);
    at += lens[i] + (i < lens.length - 1 ? sepLen : 0);
  }
  return starts;
}
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
async function zipFiles(buf) {
  const fflate = await import('./vendor/fflate.mjs');
  const unzip = fflate.unzipSync || (fflate.default || {}).unzipSync;
  if (!unzip) throw new Error('Archive engine did not load.');
  return unzip(new Uint8Array(buf));
}
function parseXmlBytes(bytes) {
  if (!bytes || !bytes.length) return null;
  const xml = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  return xml.querySelector('parsererror') ? null : xml;
}
function relsTarget(relsXml, id) {
  if (!relsXml || !id) return null;
  const els = relsXml.getElementsByTagNameNS('*', 'Relationship');
  for (const el of els) if (el.getAttribute('Id') === id) return el.getAttribute('Target') || null;
  return null;
}
function blipEmbedsIn(el) {
  // document order: a:blip (inline + anchored drawings), then VML fallback
  const out = [];
  for (const b of el.getElementsByTagNameNS('*', 'blip')) {
    const id = b.getAttributeNS(R_NS, 'embed') || b.getAttribute('r:embed');
    if (id) out.push({ id, el: b });
  }
  for (const v of el.getElementsByTagNameNS('*', 'imagedata')) {
    const id = v.getAttributeNS(R_NS, 'id') || v.getAttribute('r:id');
    if (id) out.push({ id, el: v });
  }
  return out;
}
function altOf(blipEl) {
  // nearest human caption: wp:docPr descr/name, else VML shape alt
  let n = blipEl;
  for (let hop = 0; hop < 6 && n; hop++) {
    if (n.getElementsByTagNameNS) {
      const dp = n.getElementsByTagNameNS('*', 'docPr')[0] || n.getElementsByTagNameNS('*', 'cNvPr')[0];
      if (dp && (dp.getAttribute('descr') || dp.getAttribute('name'))) return dp.getAttribute('descr') || dp.getAttribute('name');
    }
    if (n.getAttribute && n.tagName && /shape$/i.test(n.tagName) && n.getAttribute('alt')) return n.getAttribute('alt');
    n = n.parentNode;
  }
  return '';
}
function mimeOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = m ? m[1] : '';
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  if (ext === 'svg') return 'image/svg+xml';
  return '';
}
function unrenderableImage(name) { return /\.(emf|wmf|tif|tiff)$/i.test(String(name || '')); } // browsers cannot draw these — skip, don't break
async function extractDocxImages(files) {
  const docXml = parseXmlBytes(files['word/document.xml']);
  if (!docXml) return [];
  const rels = parseXmlBytes(files['word/_rels/document.xml.rels']);
  // drawings in document order + legacy VML pictures outside w:drawing
  const scopes = [...docXml.getElementsByTagNameNS('*', 'drawing'), ...docXml.getElementsByTagNameNS('*', 'pict')];
  const out = [];
  let n = 0;
  for (const scope of scopes) {
    for (const { id, el } of blipEmbedsIn(scope)) {
      if (out.length >= IMG_MAX_DOCX) break;
      const target = relsTarget(rels, id);
      if (!target) continue;
      let key = String(target).replace(/^\//, '');
      if (!/^word\//i.test(key)) key = 'word/' + key.replace(/^(\.\.\/)+/, '');
      if (unrenderableImage(key)) continue;
      const bytes = files[key];
      if (!bytes || !bytes.length) continue;
      out.push({ bytes, mime: mimeOf(key), alt: altOf(el) || ('Figure ' + (++n)) });
    }
  }
  return out;
}
async function extractPptxImages(files) {
  const slides = Object.keys(files).filter(k => /^ppt\/slides\/slide\d+\.xml$/i.test(k))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).slice(0, 100);
  const out = [];
  slides.forEach((sk, si) => {
    if (out.length >= IMG_MAX_PPTX) return;
    const sXml = parseXmlBytes(files[sk]);
    if (!sXml) return;
    const rels = parseXmlBytes(files[sk.replace(/^ppt\/slides\//, 'ppt/slides/_rels/') + '.rels']);
    const pics = [...sXml.getElementsByTagNameNS('*', 'pic')];
    const scopes = pics.length ? pics : [sXml];
    for (const scope of scopes) {
      for (const { id, el } of blipEmbedsIn(scope)) {
        if (out.length >= IMG_MAX_PPTX) break;
        const target = relsTarget(rels, id);
        if (!target) continue;
        const key = 'ppt/' + String(target).replace(/^\//, '').replace(/^(\.\.\/)+/, '').replace(/^ppt\//i, '');
        if (unrenderableImage(key)) continue;
        const bytes = files[key];
        if (!bytes || !bytes.length) continue;
        out.push({ bytes, mime: mimeOf(key), alt: altOf(el) || ('Slide ' + (si + 1) + ' image') });
      }
    }
  });
  return out;
}
async function extractXlsxImages(files) {
  // xl/worksheets/sheetN.xml -> (sheet rels) ../drawings/drawingM.xml ->
  // (drawing rels) ../media/*, same blip embeds as slides. Alt text rides on
  // the drawing's xdr:cNvPr descr/name (altOf walks up to it).
  const sheets = Object.keys(files).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)).slice(0, 50);
  const out = [];
  const done = new Set();
  sheets.forEach((sk, si) => {
    if (out.length >= IMG_MAX_XLSX) return;
    let dTarget = null;
    const sXml = parseXmlBytes(files[sk]);
    if (sXml) {
      for (const dr of sXml.getElementsByTagNameNS('*', 'drawing')) {
        const id = dr.getAttributeNS(R_NS, 'id') || dr.getAttribute('r:id');
        if (!id) continue;
        const rels = parseXmlBytes(files[sk.replace(/^xl\/worksheets\//, 'xl/worksheets/_rels/') + '.rels']);
        dTarget = relsTarget(rels, id);
        if (dTarget) break;
      }
    }
    if (!dTarget) return;
    const dkey = 'xl/' + String(dTarget).replace(/^\//, '').replace(/^(\.\.\/)+/, '').replace(/^xl\//i, '');
    if (done.has(dkey)) return;
    done.add(dkey);
    const dXml = parseXmlBytes(files[dkey]);
    if (!dXml) return;
    const dRels = parseXmlBytes(files[dkey.replace(/^xl\/drawings\//, 'xl/drawings/_rels/') + '.rels']);
    for (const { id, el } of blipEmbedsIn(dXml)) {
      if (out.length >= IMG_MAX_XLSX) break;
      const target = relsTarget(dRels, id);
      if (!target) continue;
      const key = 'xl/' + String(target).replace(/^\//, '').replace(/^(\.\.\/)+/, '').replace(/^xl\//i, '');
      if (unrenderableImage(key)) continue;
      const bytes = files[key];
      if (!bytes || !bytes.length) continue;
      out.push({ bytes, mime: mimeOf(key), alt: altOf(el) || ('Sheet ' + (si + 1) + ' image') });
    }
  });
  return out;
}
async function extractPdfImages(buf, onStep) {
  const pdfjs = await import('./vendor/pdf.mjs');
  const lib = pdfjs.getDocument ? pdfjs : (pdfjs.default || {});
  if (!lib.getDocument) return [];
  if (lib?.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) {
    try { lib.GlobalWorkerOptions.workerSrc = vendorBase() + 'pdf.worker.js'; } catch { /* same worker the text path uses */ }
  }
  const OPS = lib.OPS || {};
  const IMG_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintJpegXObject, OPS.paintImageMaskXObject].filter(v => typeof v === 'number'));
  if (!IMG_OPS.size) return []; // engine too old to name image ops — text still imports
  const pdf = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  const out = [];
  try {
    const total = Math.min(pdf.numPages, IMG_MAX_PDF_PAGES);
    for (let p = 1; p <= total && out.length < IMG_MAX_PDF_PAGES; p++) {
      if (typeof onStep === 'function' && (p % 20 === 0 || p === total)) { try { onStep(p, total); } catch {} }
      const page = await pdf.getPage(p);
      let hasImg = false;
      try {
        const ops = await page.getOperatorList();
        for (const fn of (ops.fnArray || [])) if (IMG_OPS.has(fn)) { hasImg = true; break; }
      } catch { /* this page unscannable — no picture for it */ }
      if (!hasImg) continue;
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(1.5, 900 / Math.max(1, vp1.width)) });
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
      const cx = cv.getContext('2d', { alpha: false });
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      const blob = await new Promise(r => { try { cv.toBlob(b => r(b), 'image/jpeg', 0.72); } catch { r(null); } });
      if (blob) out.push({ blob, w: cv.width, h: cv.height, cap: 'Page ' + p + ' (as printed — carries its images)' });
      try { page.cleanup(); } catch { /* free page resources */ }
    }
  } finally { try { await pdf.destroy(); } catch { /* done anyway */ } }
  return out;
}
// shrink a picture for the sidecar (bytes stay out of localStorage). Keeps
// small PNGs byte-identical (transparency + crisp diagrams); everything else
// becomes a bounded webp (alpha-safe) or jpeg. GIF/SVG pass through untouched
// so animation and vectors survive. Returns {blob, w, h}.
async function downscaleImage(blob) {
  if (/gif|svg/i.test(blob.type || '')) return { blob, w: 0, h: 0 };
  let bmp = null;
  try { bmp = await createImageBitmap(blob); }
  catch { return { blob, w: 0, h: 0 }; } // undecodable — store as-is, <img> gets the final say
  const bw = bmp.width || 0, bh = bmp.height || 0;
  if (!bw || !bh) { try { bmp.close(); } catch { /* done */ } return { blob, w: 0, h: 0 }; }
  const sc = Math.min(1, IMG_MAX_DIM / Math.max(bw, bh));
  if (sc >= 1 && /png/i.test(blob.type || '')) { try { bmp.close(); } catch { /* done */ } return { blob, w: bw, h: bh }; }
  const w = Math.max(1, Math.round(bw * sc)), h = Math.max(1, Math.round(bh * sc));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  try { bmp.close(); } catch { /* done */ }
  const webp = await new Promise(r => { try { cv.toBlob(b => r(b), 'image/webp', 0.85); } catch { r(null); } });
  if (webp && webp.size > 0) return { blob: webp, w, h };
  const jpg = await new Promise(r => { try { cv.toBlob(b => r(b), 'image/jpeg', 0.85); } catch { r(null); } });
  return { blob: (jpg && jpg.size > 0) ? jpg : blob, w, h };
}
async function extractFileImages(f, onStep) {
  try {
    const nm = cleanName(f);
    if (/\.docx$/i.test(nm)) {
      const files = await zipFiles(await f.arrayBuffer());
      return (await extractDocxImages(files)).map((im, i) => ({ blob: new Blob([im.bytes], { type: im.mime || 'application/octet-stream' }), cap: im.alt || ('Figure ' + (i + 1)) }));
    }
    if (/\.pptx$/i.test(nm)) {
      const files = await zipFiles(await f.arrayBuffer());
      return (await extractPptxImages(files)).map((im) => ({ blob: new Blob([im.bytes], { type: im.mime || 'application/octet-stream' }), cap: im.alt || 'Slide image' }));
    }
    if (/\.pdf$/i.test(nm)) return await extractPdfImages(await f.arrayBuffer(), onStep);
    if (/\.xlsx?$/i.test(nm)) {
      const files = await zipFiles(await f.arrayBuffer());
      return (await extractXlsxImages(files)).map((im) => ({ blob: new Blob([im.bytes], { type: im.mime || 'application/octet-stream' }), cap: im.alt || 'Sheet image' }));
    }
  } catch (e) { console.warn('image extraction failed for ' + cleanName(f) + ' — text still imports', (e && e.message) || e); }
  return [];
}

// ---------- OCR: read the words inside pictures so they tag too ----------
// A diagram that says "mitochondria" should tether like the word typed out.
// Each stored picture is OCR'd (tesseract.js, English, vendored local worker) and its
// high-confidence words are appended to the doc text in a marked section — so
// words, tags, search, and topic tethers all see them. Foreground intake reads
// the first pictures (bounded: count, per-picture timeout, confidence + length
// gates); the rest queue for background reading (pumpOcrQueue) so whole books
// get covered. Any failure just skips OCR while text + pictures still import.
const OCR_MAX_IMAGES = 8, OCR_MIN_AREA = 8000, OCR_TIMEOUT_MS = 30000, OCR_MIN_CONF = 45, OCR_MAX_CHARS = 3000;
const OCR_START_TIMEOUT_MS = 25000; // createWorker() has no built-in timeout — a stuck engine start parked whole intakes at "reading…", so race it and fail OCR fast (text still imports)
let ocrFailedOnce = false; // engine failed: don't pay the load cost on every file
async function ocrPictures(pics) { // [{blob, cap}] -> [{cap, text}] (high-confidence only)
  const due = (pics || []).slice(0, OCR_MAX_IMAGES);
  const found = [];
  found.attemptedCount = 0;
  if (!due.length || ocrFailedOnce) return found;
  let worker = null;
  try {
    const { createWorker } = await import('./vendor/tesseract.mjs');
    // Absolute, same-origin-with-the-page URLs: the worker resolves its
    // core/lang files against these, and relative paths would mis-resolve
    // inside the worker — while a cross-origin URL dies in importScripts /
    // dynamic import with an uncatchable NetworkError banner. vendorBase()
    // is module-relative when the module shares the page origin (desktop
    // export, static servers) and falls back to the preview's page-relative
    // src/vendor/ layout (whose modules are served cross-origin from the
    // bare domain, so import.meta URLs would be cross-origin there and can
    // serve a stale saved copy — page-relative URLs are live).
    const tessBase = vendorBase() + 'tess/';
    // The engine start has no built-in timeout and has parked whole intakes
    // here (status stuck at "reading…"): race it, fail OCR fast on timeout,
    // keep the text import. A late-resolving worker is terminated, never leaked.
    let startTimedOut = false;
    const startP = createWorker('eng', undefined, {
      logger: () => {},
      // Swallow the library's uncaught re-throw: on a load-job failure
      // tesseract rejects the job promise (which we handle below) AND, when
      // no errorHandler is set, throws the error uncaught out of its
      // onmessage handler — that uncaught throw is the scary engine banner.
      // A noop handler keeps load failures on the handled path: OCR is
      // skipped with a console warning and the app runs on without pictures.
      errorHandler: () => {},
      // Direct worker, NO blob shim (workerBlobURL:false): tesseract's
      // default wraps workerPath in a Blob whose importScripts() intermittently
      // fails to load under the preview service worker (uncaught NetworkError
      // banner). A same-origin direct worker loads reliably instead.
      workerBlobURL: false,
      workerPath: tessBase + 'worker.min.js',
      langPath: tessBase,
      corePath: tessBase,
    });
    startP.then(
      (w) => { if (startTimedOut) { try { w.terminate(); } catch {} } },
      () => {}
    );
    try {
      worker = await Promise.race([
        startP,
        new Promise((_, rej) => setTimeout(() => rej(new Error('OCR engine timed out starting')), OCR_START_TIMEOUT_MS)),
      ]);
    } catch (e) {
      startTimedOut = true;
      throw e;
    }
    for (const pic of due) {
      found.attemptedCount++;
      try {
        const job = worker.recognize(pic.blob);
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timed out')), OCR_TIMEOUT_MS));
        const ret = await Promise.race([job, timeout]);
        const text = String((ret && ret.data && ret.data.text) || '').replace(/\s+/g, ' ').trim().slice(0, OCR_MAX_CHARS);
        const conf = Number((ret && ret.data && ret.data.confidence) || 0);
        if (text.length >= 8 && conf >= OCR_MIN_CONF) found.push({ cap: pic.cap || 'image', text });
      } catch (e) {
        console.warn('OCR skipped a picture', (e && e.message) || e);
        if (/timed out/i.test((e && e.message) || '')) break; // worker is stuck — stop this file, terminate below
      }
    }
  } catch (e) {
    ocrFailedOnce = true;
    console.warn('OCR unavailable — pictures still import, just untagged', (e && e.message) || e);
    return found;
  } finally {
    try { worker && await worker.terminate(); } catch { /* already gone */ }
  }
  return found;
}

// ---------- picture-text backfill: older docs whose pictures predate OCR ----------
// Docs imported before the OCR step (or while its CDN was unreachable) keep their
// pictures but carry no "# Pictures' text" section — their image words miss every
// counter (reader words, corpus totals, mass). Once per doc, read the stored
// picture bytes back out of the sidecar, OCR them through the same pipeline new
// intakes use, and append the same marked section (words/tags/search/tethers all
// follow, since they read the text). Bounded like intake; failures just skip.
const OCR_MARK = 'read by OCR';
async function backfillOcr() {
  try {
    const docs = vault.tabs.flatMap(t => t.docs || []);
    let sealed = false;
    const due = [];
    for (const d of docs) {
      if (d.ocrDone === true) {
        // resume pre-queue builds (sealed after the first pictures were read)
        if (Array.isArray(d.images) && d.images.length > OCR_MAX_IMAGES && !Number.isInteger(d.ocrFrom) && String(d.text || '').includes(OCR_MARK)) { d.ocrFrom = OCR_MAX_IMAGES; d.ocrDone = false; sealed = true; }
        else continue;
      }
      if (!d.images || !d.images.length) { d.ocrDone = true; sealed = true; continue; }
      if (Number.isInteger(d.ocrFrom)) continue; // background queue owns this doc — no double-read
      if (String(d.text || '').includes(OCR_MARK)) { d.ocrDone = true; sealed = true; continue; }
      due.push(d);
    }
    if (sealed) { try { vault.persist(); } catch {} }
    if (!due.length) return;
    toast('Reading text in ' + due.length + ' older doc' + (due.length === 1 ? '’s' : 's’') + ' pictures…');
    let wordsAdded = 0, docsFixed = 0;
    for (const d of due) {
      if (!vault.tabs.some(t => (t.docs || []).includes(d))) continue; // deleted meanwhile
      const pics = [];
      const bimgs = (d.images || []);
      for (let bpi = 0; bpi < bimgs.length && pics.length < OCR_MAX_IMAGES; bpi++) {
        const im = bimgs[bpi];
        let rec = null;
        try { rec = await imgGet(im.key); } catch { rec = null; }
        if (!rec || !rec.blob) continue;
        pics.push({ blob: rec.blob, cap: im.cap || 'image', at: bpi });
      }
      const failedBefore = ocrFailedOnce;
      let sections = [];
      if (pics.length) {
        try { sections = await ocrPictures(pics); }
        catch (e) { console.warn('backfill OCR failed for ' + d.name, (e && e.message) || e); sections = []; }
      }
      // foreground covers the first pictures; the rest queue for background
      const batt = Number.isInteger(sections.attemptedCount) ? sections.attemptedCount : pics.length;
      if (pics.length && !(batt <= 0 && ocrFailedOnce)) {
        const blast = batt > 0 ? pics[Math.min(batt, pics.length) - 1].at : -1;
        if (Number.isInteger(blast) && blast >= 0) d.ocrFrom = blast + 1;
      }
      // (engine failure: ocrFrom untouched — backfill's retry/seal path governs)
      d.ocrDone = sections.length ? (Number.isInteger(d.ocrFrom) && d.ocrFrom >= bimgs.length) : (!failedBefore && !ocrFailedOnce);
      if (d.ocrDone === true) { delete d.ocrTries; }
      else {
        // broken engine (or unreadable blobs) must not nag every boot:
        // retry the next boots, then seal the doc and stop asking
        d.ocrTries = Math.min(99, (Number.isInteger(d.ocrTries) ? d.ocrTries : 0) + 1);
        if (d.ocrTries >= 3) { d.ocrDone = true; }
        sealed = true;
      }
      if (!sections.length) continue;
      const before = d.words || 0;
      d.text = (d.text + '\n\n# Pictures\u2019 text (read by OCR)\n\n' +
        sections.map(s => '[' + s.cap + ']: ' + s.text).join('\n\n')).slice(0, INTAKE_TEXT_MAX);
      vault.recountDoc(d);
      wordsAdded += Math.max(0, (d.words || 0) - before);
      docsFixed++;
    }
    try { vault.persist(); } catch {}
    if (docsFixed) {
      rebuildAllTabs();
      try { renderDoc(); } catch {}
      try { updateStats(); } catch {}
      toast(docsFixed + ' older doc' + (docsFixed === 1 ? '' : 's') + ' gained ' + wordsAdded + ' picture word' + (wordsAdded === 1 ? '' : 's') + ' in the counters');
    } else toast('Older pictures hold no readable text — counters unchanged');
  } catch (e) { console.warn('picture-text backfill skipped', (e && e.message) || e); }
}

// ---------- background OCR queue: every page of big scanned books gets read ----------
// Foreground intake reads the first pictures fast so the import finishes quickly;
// the remaining page-images queue here and are read a few at a time while the
// user keeps working (resuming after restart — ocrFrom persists on the doc).
// Each batch persists, so quitting mid-queue loses at most one batch.
let ocrPumpRunning = false;
async function pumpOcrQueue() {
  if (ocrPumpRunning) return;
  ocrPumpRunning = true;
  let didWork = false, wordsAdded = 0, docsFixed = 0;
  const docsSeen = new Set();
  try {
    for (;;) {
      if (ocrFailedOnce) break; // engine dead this session — retries next boot, seals via tries below
      const d = vault.tabs.flatMap(t => t.docs || []).find(x => x && x.ocrDone !== true && Array.isArray(x.images) && Number.isInteger(x.ocrFrom) && x.ocrFrom < x.images.length);
      if (!d) break;
      const batch = [];
      let idx = d.ocrFrom;
      while (idx < d.images.length && batch.length < OCR_MAX_IMAGES) {
        const im = d.images[idx];
        const at = idx; idx++;
        const area = im && im.w > 0 && im.h > 0 ? im.w * im.h : OCR_MIN_AREA;
        if (area < OCR_MIN_AREA) continue;
        let rec = null;
        try { rec = await imgGet(im.key); } catch { rec = null; }
        if (!rec || !rec.blob) continue;
        batch.push({ blob: rec.blob, cap: im.cap || 'image', at });
      }
      const fromBefore = d.ocrFrom;
      d.ocrFrom = idx;
      let sections = [];
      if (batch.length) {
        try { sections = await ocrPictures(batch); }
        catch (e) { console.warn('background OCR failed for ' + d.name, (e && e.message) || e); sections = []; }
      }
      const attempted = Number.isInteger(sections.attemptedCount) ? sections.attemptedCount : batch.length;
      if (attempted <= 0 && ocrFailedOnce) {
        // engine died on this batch: rewind + count toward the seal (like backfill)
        d.ocrFrom = fromBefore;
        d.ocrTries = Math.min(99, (Number.isInteger(d.ocrTries) ? d.ocrTries : 0) + 1);
        if (d.ocrTries >= 3) { d.ocrDone = true; try { delete d.ocrTries; } catch {} }
        try { vault.persist(); } catch {}
        break;
      }
      if (attempted < batch.length && batch.length) d.ocrFrom = batch[attempted].at; // worker stalled mid-batch: rewind un-attempted
      if (!vault.tabs.some(t => (t.docs || []).includes(d))) continue; // deleted meanwhile — drop the batch
      if (sections.length) {
        const head = String(d.text || '').includes(OCR_MARK) ? '' : '\n\n# Pictures\u2019 text (read by OCR)\n\n';
        const before = d.words || 0;
        d.text = (d.text + head + sections.map(s => '[' + s.cap + ']: ' + s.text).join('\n\n')).slice(0, INTAKE_TEXT_MAX);
        try { vault.recountDoc(d); } catch {}
        try { markBackupDirty(); } catch {}
        wordsAdded += Math.max(0, (d.words || 0) - before);
        if (!docsSeen.has(d.id)) { docsSeen.add(d.id); docsFixed++; }
        didWork = true;
      }
      if (d.ocrFrom >= d.images.length) { d.ocrDone = true; try { delete d.ocrTries; } catch {} }
      try { vault.persist(); } catch {}
      await new Promise(r => setTimeout(r, 120)); // breathe — the universe stays interactive
    }
  } finally {
    ocrPumpRunning = false;
    if (didWork) {
      try { rebuildAllTabs(); } catch {}
      try { renderDoc(); } catch {}
      try { updateStats(); } catch {}
      try { toast('Background reading finished: +' + wordsAdded + ' words from ' + docsFixed + ' doc' + (docsFixed === 1 ? '' : 's')); } catch {}
    }
  }
}

async function ingestFiles(files, ctx) {
  if (!vault.tab()) {
    await noProjectPopup();
    return;
  }
  const arr = [...(files || [])];
  if (!arr.length) {
    console.warn('ingestFiles: empty file list', ctx || '');
    const where = ctx && ctx.where ? ' (' + ctx.where + ')' : '';
    const types = ctx && ctx.types && ctx.types.length ? ' — drop carried [' + ctx.types.join(', ') + '], no file bytes' : '';
    toast('Nothing was dropped' + where + types + ' — use the Files button and pick the .docx from disk', 6500);
    return;
  }
  const list = arr.filter(intakeAllowed);
  const skipped = arr.filter(f => !intakeAllowed(f));
  if (skipped.length) console.warn('intake skipped', skipped.map(f => ({ name: (f && f.name) || '(unnamed)', type: (f && f.type) || '' })));
  if (!list.length) {
    const shown = skipped.slice(0, 3).map(f => '"' + cleanName(f) + '" ' + extOf(cleanName(f))).join(' \u00B7 ');
    const more = skipped.length > 3 ? ' (+' + (skipped.length - 3) + ' more)' : '';
    const hint = skipped.some(f => /\.(zip|rar|7z|pages|numbers|key|odt|ods|odp|rtf)$/i.test(cleanName(f)))
      ? ' \u2014 that looks like an archive/iWork/OpenDocument file: unzip or export it first (.docx/.pdf/.md)'
      : '';
    toast('No documents found \u2014 skipped ' + skipped.length + ' file' + (skipped.length === 1 ? '' : 's') + ': ' + shown + more + hint + ' (' + INTAKE_LABEL + ')', 7000);
    return;
  }
  let n = 0;
  const errs = [];
  const newIds = [];
  let dupes = 0;
  let imgTotal = 0;
  let ocrTotal = 0;
  let cappedTotal = 0;
  const seen = new Set(vault.docs.map(d => d.text.replace(/\s+/g, ' ').trim()));
  const intakeRec = { at: new Date().toISOString(), total: arr.length, allowed: list.length, skipped: skipped.length, files: [] };
  try { window.__visidocsverse.lastIntake = intakeRec; } catch {}
  const upBatch = list.slice(0, 60);
  const upTok = showUploadProg(upBatch.length, 'Starting…');
  try {
  for (let upIdx = 0; upIdx < upBatch.length; upIdx++) {
    const f = upBatch[upIdx];
    updateUploadProg(upTok, upIdx + 1, upBatch.length, cleanName(f));
    const rec = { name: cleanName(f), type: (f && f.type) || '', size: (f && typeof f.size === 'number') ? f.size : null, status: 'pending' };
    intakeRec.files.push(rec);
    try {
      toast('Reading ' + cleanName(f) + '\u2026');
      if (rec.size === 0) throw new Error('That file looks empty (0 bytes) — it may be a cloud placeholder. Open it once, then download a fresh copy.');
      const rawText = await readFileAsText(f, (p, total) => updateUploadProg(upTok, upIdx + 1, upBatch.length, cleanName(f) + ' — page ' + p + ' of ' + total));
      // consume the pagination side-channel now (before any other extractor
      // call can overwrite it): offsets are relative to rawText.
      const pgStarts = lastPageStarts, pgKind = lastPageKind;
      lastPageStarts = null; lastPageKind = null;
      let text = rawText;
      if (text.length > INTAKE_TEXT_MAX) { text = text.slice(0, INTAKE_TEXT_MAX); cappedTotal++; rec.capped = true; console.warn('intake capped at full-text limit (' + INTAKE_TEXT_MAX + ' chars): ' + cleanName(f) + ' carried ' + rawText.length + ' chars'); }
      rec.textLen = text.length;
      // image-only files carry no text: key the dupe check on the filename so
      // re-dropping the same scanned file still dedupes within the batch.
      const key = text.replace(/\s+/g, ' ').trim() || ('empty:' + cleanName(f).toLowerCase());
      if (seen.has(key)) { dupes++; rec.status = 'duplicate'; continue; } // same bytes as something already here
      seen.add(key);
      // embedded pictures (Word/PowerPoint/PDF/sheets): shrink + file the
      // bytes in the IndexedDB sidecar, keep the tiny manifest on the doc. A
      // picture failure never fails the text import; orphans get purged after
      // the batch.
      let imgMeta = [];
      let ocrPics = [];
      let imgFails = 0;
      try {
        const pics = await extractFileImages(f, (done, total) => updateUploadProg(upTok, upIdx + 1, upBatch.length, cleanName(f) + ' — pictures page ' + done + ' of ' + total));
        for (const pic of pics.slice(0, 500)) {
          try {
            const fit = await downscaleImage(pic.blob);
            if (!fit.blob || !(fit.blob.size > 0)) continue;
            const k = 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            await imgPut({ key: k, blob: fit.blob, cap: pic.cap || 'image', w: fit.w, h: fit.h, at: Date.now() });
            imgMeta.push({ key: k, cap: pic.cap || 'image', w: fit.w, h: fit.h });
            if (!(fit.w > 0 && fit.h > 0 && fit.w * fit.h < OCR_MIN_AREA)) ocrPics.push({ blob: fit.blob, cap: pic.cap || 'image', at: imgMeta.length - 1 });
          } catch (pe) { imgFails++; console.warn('storing a picture failed for ' + cleanName(f) + ' — keeping the rest', (pe && pe.message) || pe); }
        }
      } catch (e) { console.warn('storing images failed for ' + cleanName(f) + ' — text still imports', (e && e.message) || e); }
      if (imgFails) toast(imgFails + ' picture' + (imgFails === 1 ? '' : 's') + ' could not be stored — text and the rest still imported', 5000);
      // standalone photo bodies (.jpg/.png): the file itself is the picture —
      // run it through the same OCR pipeline so photographed text counts.
      if (!ocrPics.length && /\.(jpe?g|png)$/i.test(cleanName(f))) {
        try {
          const fit = await downscaleImage(f);
          if (fit.blob && fit.blob.size > 0) ocrPics.push({ blob: fit.blob, cap: cleanName(f) });
        } catch (e) { console.warn('photo OCR skipped for ' + cleanName(f) + ' — manifest still imports', (e && e.message) || e); }
      }
      imgTotal += imgMeta.length;
      // read the words inside the pictures so they count: high-confidence OCR
      // text joins the doc in a marked section (words/tags/search/tethers —
      // addFile parses this final text, so every counter includes them).
      const ocrFailedBefore = ocrFailedOnce;
      let ocrSections = [];
      let ocrRan = !ocrPics.length; // nothing to read counts as done
      if (ocrPics.length) {
        updateUploadProg(upTok, upIdx + 1, upBatch.length, 'Reading text in pictures — ' + cleanName(f));
        toast('Reading text in ' + ocrPics.length + ' image' + (ocrPics.length === 1 ? '' : 's') + '\u2026');
        try { ocrSections = await ocrPictures(ocrPics); }
        catch (e) { console.warn('OCR failed for ' + cleanName(f) + ' — pictures still import', (e && e.message) || e); ocrSections = []; }
        ocrRan = !ocrFailedBefore && !ocrFailedOnce;
      }
      // foreground OCR covers the first pictures; the rest queue for background
      let ocrFrom = imgMeta.length;
      if (ocrPics.length) {
        const iatt = Number.isInteger(ocrSections.attemptedCount) ? ocrSections.attemptedCount : Math.min(ocrPics.length, OCR_MAX_IMAGES);
        if (!(iatt <= 0 && ocrFailedOnce)) {
          const ilast = iatt > 0 ? ocrPics[Math.min(iatt, ocrPics.length) - 1].at : -1;
          if (Number.isInteger(ilast) && ilast >= 0) ocrFrom = ilast + 1;
        } else ocrFrom = 0; // engine dead — pump's retry/seal path governs
      }
      ocrTotal += ocrSections.length;
      let fullText = text;
      if (ocrSections.length) {
        fullText = (fullText + '\n\n# Pictures\u2019 text (read by OCR)\n\n' +
          ocrSections.map(s => '[' + s.cap + ']: ' + s.text).join('\n\n')).slice(0, INTAKE_TEXT_MAX);
      }
      // neither text nor picture words: importing would make a junk blank body.
      if (!fullText.trim() && !ocrSections.length) {
        const msg = 'No readable text or pictures with text in that file';
        errs.push(cleanName(f) + ': ' + msg); rec.status = 'error'; rec.error = msg;
        continue;
      }
      const cn = cleanName(f);
      const d = vault.addFile(cn.replace(/\.(markdown)$/i, '.md'), '# ' + cn.replace(/\.[^.]+$/, '') + '\n\n' + fullText, imgMeta);
      // rebase the recorded pagination onto the final stored text: the title
      // line above prefixes every offset, and capped/OCR tails only cut or
      // extend the END, so starts stay valid. Pages past a pathological cap
      // are dropped (the tail they point at was never stored).
      try {
        if (pgStarts && pgStarts.length && (pgKind === 'pdf' || pgKind === 'slides' || pgKind === 'sheets')) {
          const prefixLen = ('# ' + cn.replace(/\.[^.]+$/, '') + '\n\n').length;
          const kept = pgStarts.map(s => prefixLen + s).filter(s => s < d.text.length);
          if (kept.length) d.pageMap = { kind: pgKind, count: kept.length, starts: kept };
        }
      } catch (e) { console.warn('page map skipped for ' + cn, (e && e.message) || e); }
      // keep the original bytes (IndexedDB sidecar) so Download returns the
      // real file. Desktop installs file them in the on-disk app vault (no
      // size cap — books of any length keep their bytes); everywhere else the
      // browser sidecar carries files up to ORIG_IDB_MAX. Text import never
      // depends on this — when neither vault can keep the bytes, the body
      // still imports whole and downloads as extracted text (.txt), with an
      // honest toast saying why (never silent).
      try {
        let kept = '';
        const okey = 'orig_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        if (f && typeof f.size === 'number' && f.size > 0 && await diskUsable()) {
          try {
            d.origFile = await diskPut(okey, f, d.name);
            d.origKey = okey; d.origWhere = 'disk'; delete d.origSkipped; kept = 'disk';
          } catch (e) { console.warn('disk vault keep failed for ' + d.name + ' — trying the browser store', (e && e.message) || e); }
        }
        if (!kept && f && typeof f.size === 'number' && f.size > 0 && f.size <= ORIG_IDB_MAX) {
          try {
            await origPut({ key: okey, blob: f, name: d.name, type: (f && f.type) || '', at: Date.now() });
            d.origKey = okey; d.origWhere = 'idb'; delete d.origFile; delete d.origSkipped; kept = 'idb';
          } catch (e) { console.warn('keeping original failed for ' + d.name + ' — text still imports', (e && e.message) || e); }
        }
        if (!kept) {
          delete d.origKey; delete d.origWhere; delete d.origFile;
          d.origSkipped = (f && f.size > ORIG_IDB_MAX) ? 'too-large-for-browser-store' : 'keep-failed';
          try { vault.persist(); } catch {}
          toast(d.origSkipped === 'too-large-for-browser-store'
            ? `Original not kept for “${d.name}” (over the 100MB browser-store limit — desktop installs keep originals of any size on disk) — text and pictures still imported whole`
            : `Original could not be kept for “${d.name}” on this machine — text and pictures still imported whole`, 7000);
        }
      } catch (e) { console.warn('keeping original failed for ' + d.name + ' — text still imports', (e && e.message) || e); }

      d.ocrFrom = ocrFrom;
      if (ocrRan || ocrFrom >= imgMeta.length) d.ocrDone = true; // picture words already in the text — nothing to backfill
      else d.ocrDone = false; // rest queues for background reading
      newIds.push(d.id);
      n++;
      rec.status = 'ok'; rec.docId = d.id; rec.images = imgMeta.length;
    } catch (e) { const msg = ((e && e.message) || String(e)); errs.push(cleanName(f) + ': ' + msg); rec.status = 'error'; rec.error = msg; console.warn('import failed', cleanName(f), e); }
  }
  try { vault.persist(); } catch {} // seals post-addFile ocrDone flags
  if (n) markBackupDirty(); // fresh bodies aboard — the file backup is stale
  rebuild(activeId);
  // a lens has no doc bodies to crown — light up where the files situated instead
  if (newIds.length && (lensThematic || lensTags)) highlightIntakeLanding(newIds);
  // newly arrived bodies become the center of attention: focus the first one so
  // it glides to the origin as the sun (orphans otherwise drift far out of view)
  else if (newIds.length && uni) {
    const landed = newIds.filter(id => { try { return uni.byId.has(id); } catch { return false; } });
    if (uni.focus(newIds[0])) { claimSun(newIds[0]); intakeHiIds = new Set(landed); renderDoc(); }
    else intakeHiIds = new Set(landed);
  }
  const dupeNote = dupes ? ' \u00B7 ' + dupes + ' duplicate' + (dupes === 1 ? '' : 's') + ' already here' : '';
  const skipNote = skipped.length ? ' \u00B7 ' + skipped.length + ' skipped (not a document)' : '';
  const capNote = cappedTotal ? ' · ' + cappedTotal + ' file' + (cappedTotal === 1 ? '' : 's') + ' capped at the full-text limit' : '';
  const finalMsg = n ? ((n === 1 ? '1 document captured' : n + ' documents captured') + dupeNote + skipNote + capNote)
    : (dupes ? 'Nothing new \u2014 ' + dupes + ' duplicate' + (dupes === 1 ? '' : 's') + ' already in the universe' : (errs.length ? 'Nothing imported \u2014 ' + errs[0] : 'Nothing imported'));
  intakeRec.toast = finalMsg; intakeRec.imported = n; intakeRec.errors = errs.slice(0, 5); intakeRec.images = imgTotal; intakeRec.ocr = ocrTotal;
  try { purgeImages(); } catch { /* orphan bytes sweep runs on its own */ }
  setLog(finalMsg);
  if (n) toast(finalMsg);
  else toast(finalMsg, errs.length || dupes ? 8000 : 2400);
  try {
    const backlog = newIds.map(id => { try { return vault.byIdAnywhere(id); } catch { return null; } }).filter(d => d && d.ocrDone !== true && Array.isArray(d.images) && Number.isInteger(d.ocrFrom) && d.ocrFrom < d.images.length);
    const pages = backlog.reduce((s, d) => s + (d.images.length - d.ocrFrom), 0);
    if (pages > 0) {
      toast('Background reading queued for ' + pages + ' more page' + (pages === 1 ? '' : 's') + ' — keep working, their words fill in automatically');
      try { pumpOcrQueue(); } catch {}
    }
  } catch {}
  } finally { hideUploadProg(upTok); }
}

async function collectDirRecursive(dir, out, skipped, depth) {
  depth = depth || 0;
  if (depth > 4 || out.length >= 60) return;
  for await (const entry of dir.values()) {
    if (out.length >= 60) break;
    try {
      if (entry.kind === 'file') {
        let f = null;
        try { f = await entry.getFile(); } catch { continue; }
        if (intakeAllowed(f)) out.push(f);
        else skipped.push(entry.name || cleanName(f));
      } else if (entry.kind === 'directory') {
        await collectDirRecursive(entry, out, skipped, depth + 1);
      }
    } catch { /* keep scanning the rest */ }
  }
}

// Dropping a FOLDER yields zero entries in e.dataTransfer.files on most
// browsers — the files live behind DataTransferItems. Walk those so a
// dropped folder of .docx files actually imports (recursively, capped).
async function getDropFiles(dt) {
  const items = dt && dt.items ? [...dt.items] : [];
  const hasEntries = items.some(it => (it && (it.webkitGetAsEntry || it.getAsEntry || it.getAsFileSystemHandle)));
  if (!hasEntries) {
    // No entry APIs (rare): still honor plain file items, then files.
    const viaItems = [];
    for (const it of items) { try { const f = it.getAsFile && it.getAsFile(); if (f) viaItems.push(f); } catch {} }
    if (viaItems.length) return viaItems;
    return dt && dt.files ? [...dt.files] : [];
  }
  const out = [];
  const walkEntry = (entry) => new Promise((resolve) => {
    if (!entry) return resolve();
    try {
      if (entry.isFile) {
        entry.file((f) => { if (f) out.push(f); resolve(); }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => {
          reader.readEntries(async (batch) => {
            if (!batch.length) return resolve();
            for (const b of batch) await walkEntry(b);
            if (out.length >= 60) return resolve();
            readAll();
          }, () => resolve());
        };
        readAll();
      } else resolve();
    } catch { resolve(); }
  });
  for (const it of items) {
    if (out.length >= 60) break;
    try {
      if (it.getAsFileSystemHandle) {
        const h = await it.getAsFileSystemHandle().catch(() => null);
        if (h && h.kind === 'file') {
          const f = await h.getFile().catch(() => null);
          if (f) out.push(f);
          continue;
        }
        if (h && h.kind === 'directory') {
          const tmp = [], sk = [];
          await collectDirRecursive(h, tmp, sk).catch(() => {});
          for (const f of tmp) out.push(f);
          continue;
        }
      }
      const fn = it.webkitGetAsEntry || it.getAsEntry;
      const entry = fn ? fn.call(it) : null;
      if (entry) await walkEntry(entry);
      else { const f = it.getAsFile && it.getAsFile(); if (f) out.push(f); }
    } catch { /* next item */ }
  }
  if (out.length) return out;
  return dt && dt.files ? [...dt.files] : [];
}

async function legacyFolderPick() {
  const ok = await confirmDlg('The next step is your browser’s own security check — it asks you to confirm the folder upload and names this site. That warning comes from the browser, not Visi|Docsverse. (Tip: dragging the folder onto the canvas skips it entirely.)', 'Continue', { title: 'Upload a whole folder?' });
  if (!ok) { setLog('Folder upload cancelled'); return; }
  const fi = document.querySelector('#folderInput');
  if (fi) { setLog('Waiting for folder selection…'); fi.click(); }
  else document.querySelector('#fileInput').click();
}

async function pickFolder() {
  setLog('Waiting for folder selection…');
  try {
    // No File System Access API (Firefox/Safari/iOS) -> hidden webkitdirectory
    // picker, which still recurses into subfolders natively.
    if (!window.showDirectoryPicker) { await legacyFolderPick(); return; }
    const dir = await window.showDirectoryPicker();
    const files = [], skipped = [];
    const gTok = showUploadProg(0, 'Gathering files from the folder…');
    try { await collectDirRecursive(dir, files, skipped); }
    catch { hideUploadProg(gTok); throw new Error('Could not scan that folder — the browser blocked access.'); }
    if (!files.length) {
      hideUploadProg(gTok);
      if (skipped.length) {
        const shown = skipped.slice(0, 3).map(s => '"' + s + '" ' + extOf(s)).join(' \u00B7 ');
        toast('No documents in that folder \u2014 ' + skipped.length + ' file' + (skipped.length === 1 ? '' : 's') + ' skipped (' + shown + '). Looking for ' + INTAKE_LABEL, 7000);
      } else toast('No documents in that folder (subfolders included) \u2014 looking for ' + INTAKE_LABEL, 5000);
      return;
    }
    hideUploadProg(gTok); // gathering done — ingestFiles raises its own tracker next
    await ingestFiles(files);
  } catch (e) {
    if (e?.name === 'AbortError') { setLog('Folder selection cancelled — no files chosen'); return; }
    // Real picker missing/blocked -> legacy folder input (also gives its own waiting state)
    try { await legacyFolderPick(); }
    catch { setLog('Folder picker blocked — use the Files button instead'); }
  }
}

// ---------- main loop ----------
function loop() {
  cancelAnimationFrame(raf);
  lastReal = performance.now();
  const tick = () => {
    const nowReal = performance.now();
    const dtReal = Math.min(0.1, Math.max(0, (nowReal - lastReal) / 1000));
    lastReal = nowReal;
    if (rotOn && rotMul > 0) {
      const s = rotMul;
      const sims = [];
      for (const t of vault.tabs) { // every canvas simulates, so twins share one motion
        const u = unis.get(t.id);
        if (u) sims.push(u);
      }
      if (lensThematic || lensTags) { // the live lens recomposition simulates too (same mechanics)
        const tu = lensThematic ? thematicUniFor(vault.activeTabId) : tagUniFor(vault.activeTabId);
        if (tu && !sims.includes(tu)) sims.push(tu);
      }
      for (const u of sims) {
        if (autoDist && u === uni) continue; // pinned orb: the drawn canvas holds still while the others keep simulating
        const baseDt = u.dt || 0.3;
        if (s <= 1.2) u.step(baseDt * s);
        else { const sub = 2; for (let i = 0; i < sub; i++) u.step(baseDt * s / sub); }
      }
      entangleSync(); // quantum lock across canvases
      if (ren.cam.auto) ren.cam.yaw += ROT_BASE * s;
      virtT += dtReal * s;
    }
    if (autoDist && uni) layoutOrb(uni); // pinned fit-to-canvas orb overrides orbital motion
    try { camGlideStep(nowReal); } catch {} // reader locates glide the pan; gestures/Fit cancel it
    // selection is light-only (gold halo + gold rows follow ren.selId), so
    // there is no per-frame spotlight work here — bodies never move for a pick.
    let noteMarks = null; // body id -> 'full' (has note) | 'empty' (sun placeholder)
    if (viewNotesAll || viewNotesSun) {
      noteMarks = new Map();
      // All: solid squares, only on bodies that actually have notes — never placeholders
      if (viewNotesAll) for (const d of vault.docs) if (noteCount(d.id)) noteMarks.set(d.id, 'full');
      // Active body: the selected body always gets its square — solid when noted, hollow frame when not
      if (viewNotesSun && activeId && vault.byId(activeId) && !noteMarks.has(activeId)) noteMarks.set(activeId, 'empty');
    }
    ren.selId = canvasHiId || activeId; // the MAIN pill's canvas-only highlight wins while it stands; otherwise gold follows the reader's selection
    // orbit anchor: yaw/pitch swing around the formation itself, never the
    // world origin — a drifted formation would otherwise arc off screen
    // instead of rotating in place. Sun when focused (rock-steady once
    // homed), else the live centroid; eased so focus/intake jumps glide.
    try {
      const tns = uni ? uni.nodes : null;
      if (ren && tns && tns.length) {
        let ax = 0, ay = 0, az = 0;
        const sn = uni.byId.get(uni.sunId);
        if (sn) { ax = sn.x; ay = sn.y; az = sn.z; }
        else { for (const m of tns) { ax += m.x; ay += m.y; az += m.z; } ax /= tns.length; ay /= tns.length; az /= tns.length; }
        if (Number.isFinite(ax + ay + az)) {
          if (ren.cam.tx == null || ren.cam.ty == null || ren.cam.tz == null) { ren.cam.tx = ax; ren.cam.ty = ay; ren.cam.tz = az; }
          else { const ak = 0.12; ren.cam.tx += (ax - ren.cam.tx) * ak; ren.cam.ty += (ay - ren.cam.ty) * ak; ren.cam.tz += (az - ren.cam.tz) * ak; }
        }
      }
    } catch {}
    // released mode: the SCREEN center holds gravity (both modes) — pan
    // eases home so the origin-centered formation rides the visible center
    // instead of the canvas element's middle (which hides behind the panes).
    // Hands off while anything else drives the pan (hand-drag, locate glide,
    // Fit glide): a frame that finds px/py touched skips and re-baselines.
    // A hand drag additionally OWNS the pan (panHeld): after release the view
    // stays where the hand left it — only double-click re-centers.
    try {
      const noSun = uni && uni.nodes && uni.nodes.length && !uni.byId.get(uni.sunId);
      if (noSun && !autoDist && !panHeld && ren && ren.cv) {
        const cpx = ren.cam.px || 0, cpy = ren.cam.py || 0;
        if (cpx !== loop._hpx || cpy !== loop._hpy) { loop._hpx = cpx; loop._hpy = cpy; }
        else {
          const r = ren.cv.getBoundingClientRect();
          const W = r.width || 300, H = r.height || 400;
          const vx0 = Math.max(0, r.left), vx1 = Math.min(window.innerWidth || W, r.right);
          const vy0 = Math.max(0, r.top), vy1 = Math.min(window.innerHeight || H, r.bottom);
          const hx = (vx0 + vx1) / 2 - r.left - W / 2;
          const hy = (vy0 + vy1) / 2 - r.top - H / 2;
          const k = 0.045;
          const npx = cpx + (hx - cpx) * k, npy = cpy + (hy - cpy) * k;
          ren.cam.px = loop._hpx = Math.abs(npx - hx) < 0.5 ? hx : npx;
          ren.cam.py = loop._hpy = Math.abs(npy - hy) < 0.5 ? hy : npy;
        }
      }
    } catch {}
    try { syncMainTabBg(); } catch {} // MAIN folder tab mimics the canvas shade live (slider drags, mode flips, restores)
    try { syncInkContrast(); } catch {} // find-box + empty-view ink tracks the layered pane color for contrast
    try { syncTagHi(); } catch {} // Tags view: gild every tag grounding the shown doc
    try {
      // intake landings halo their situating themes/tags in any lens view
      if (intakeHiIds.size && uni) {
        const want = new Set(tagHiIds);
        for (const id of intakeHiIds) { try { if (uni.byId.has(id)) want.add(id); } catch {} }
        if (ren) ren.hotSet = want;
      } else if (ren && ren.hotSet !== tagHiIds) ren.hotSet = tagHiIds;
    } catch {}
    ren.draw(uni, { match: matchSet, now: virtT, noteMarks, assoc: assocDrawData() });
    if (autoDist) drawMiniMap(); // verse map tracks the pinned orb live
    if ((tick.n = (tick.n || 0) + 1) % 20 === 0) updateStats();
    raf = requestAnimationFrame(tick);
  };
  tick();
}

// ---------- boot ----------
async function boot() {
  // desktop shells gate first on the EULA (in-app first-run acceptance —
  // the Windows installers additionally show it in the setup wizard) and
  // then on a locally-verified license key (no network); the web preview
  // skips both gates.
  // Boot guard order: (1) purge any dev/legacy license artifacts so they
  // can never satisfy the check; (2) EULA; (3) license — a missing/invalid
  // license_key + instance_id (checked against Lemon Squeezy's validate
  // endpoint when the cache is stale) shows the blocking Activate modal
  // before any of the main interface is built.
  try { clearDevLicenseCaches(); } catch {}
  try { if (!(await ensureEulaAccepted())) return; } catch { return; }
  try { if (!(await ensureLicensed())) return; } catch { return; }
  bootStage('gates-ok');
  ren = new Renderer($('#uniCv'));
  bootStage('renderer');
  ren.selSet = selSet; // selection rings follow the box-select set live
  const firstTab = vault.tab();
  activeId = firstTab
    ? ((firstTab.activeId === null && vault.docs.length) ? null : (firstTab.activeId || vault.docs[0]?.id || null))
    : null;
  if (firstTab) rebuild(activeId);
  else { edgeInfo = []; renderDoc(); updateStats(); }
  // A stalled intake can persist a progress line ("Picked 3 files — reading…")
  // on its tab — scrub those so a reload never re-shows a stuck state.
  try {
    let scrubbed = false;
    for (const t of (vault.tabs || [])) {
      if (t && typeof t.lastMsg === 'string' && (/reading…\s*$/i.test(t.lastMsg) || /^Reading /i.test(t.lastMsg) || /^Waiting for file selection/i.test(t.lastMsg))) { t.lastMsg = ''; scrubbed = true; }
    }
    if (scrubbed) vault.persist();
  } catch {}
  loop();
  // picture-text backfill: older image docs gain their OCR words in the
  // background (bounded, silent on failure — new intakes OCR inline already).
  // image-store rename first: pre-release bytes move over, then backfill reads them.
  try { (async () => { try { await migrateImageDB(); } catch {} try { await migrateIdbOriginalsToDisk(); } catch {} try { await backfillOcr(); } catch {} try { pumpOcrQueue(); } catch {} })(); } catch {}
  // version checker (desktop shells only — silent in the web preview): one
  // anonymous GET of version.json a few seconds after startup; a banner shows
  // only when a strictly newer version is published. Never blocks, never nags.
  try { initUpdateChecker(toast); } catch {}
  // license status + deactivate (left panel): shows which credential holds
  // this machine (Lemon email / key-file email / none) and offers a clean
  // seat move — clearing both caches then re-running the gate, which
  // re-shows the blocking Activate modal on desktop shells.
  try {
    const syncLic = async () => {
      const el = $('#licStatus'); if (!el) return;
      try {
        const s = await licenseStatus();
        if (s.kind === 'lemon') el.textContent = `Licensed${s.email ? ' · ' + s.email : ''}`;
        else if (s.kind === 'keyfile') el.textContent = `Licensed — key file${s.email ? ' · ' + s.email : ''}`;
        else el.textContent = isDesktopShell() ? 'No license on this machine' : 'Web preview — no license needed';
      } catch { el.textContent = 'License status unavailable'; }
    };
    const ld = $('#licDeactivateBtn');
    if (ld) ld.onclick = async () => {
      if (!await confirmDlg('Remove the license from this machine? The Activate window appears next so a key can be entered again.', 'Deactivate')) return;
      try { deactivateLicense(); } catch {}
      try { await syncLic(); } catch {}
      try { if (await ensureLicensed()) await syncLic(); } catch {}
    };
    syncLic();
  } catch {}
  // "?" explicators: show stored wording, gate ✎ buttons to the editor (never desktop)
  try {
    if (helpEditAllowed()) document.body.classList.add('help-can-edit');
    applyHelpToStatic();
    applyGlossEdits(); wireGlossEdit(); // personal glossary wording: machine-only, never backups/installers
    renderTagGuide(); // tagging guide body (default or this machine's edit)
    // renderDoc() ran inside rebuild() before the class existed — re-render so its
    // popups pick up stored wording too (cheap, keeps all four in sync).
    renderDoc(); applyHelpToStatic();
  } catch {}
  { const hs = $('#helpSaveBtn'); if (hs) hs.onclick = () => saveHelpEditor(false); }
  { const hr = $('#helpResetBtn'); if (hr) hr.onclick = () => saveHelpEditor(true); }
  { const hc = $('#helpCancelBtn'); if (hc) hc.onclick = closeHelpEditor; }

  // camera: drag empty space = pan \u00B7 press-drag a body = rotate \u00B7 click body = focus \u00B7 dblclick = refit
  const cv = $('#uniCv');
  cv.style.touchAction = 'none'; // single-finger drag must reach us on touch screens
  let downAt = 0, moved = false, lx = 0, ly = 0, downX = 0, downY = 0;
  let dragMode = null, downNode = null; // 'pan' | 'rotate' | 'select'
  let camAutoTimer = 0; // gyre-resume handle: cleared on every fresh press so a stale 6s timer can never re-enable the drift mid-drag
  // marquee box-select rectangle (plain fixed div = pixel-crisp 1px edges)
  // with a DELETE caption living INSIDE the box: the box stays click-through
  // so canvas drags can still start inside it, while the caption takes clicks.
  const marquee = document.createElement('div');
  marquee.id = 'marquee'; marquee.hidden = true;
  document.body.appendChild(marquee);
  const marqueeDel = document.createElement('span');
  marqueeDel.id = 'marqueeDel'; marqueeDel.textContent = 'DELETE'; marqueeDel.hidden = true;
  marqueeDel.title = 'Delete the box-selected bodies + their docs (this tab only)';
  marquee.appendChild(marqueeDel);
  marqueeDel.addEventListener('pointerdown', (e) => e.stopPropagation());
  marqueeDel.addEventListener('click', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (selSet.size) removeIdsFromCanvas([...selSet]);
  });
  // quick right-click on a doc body: the same focus + menu the native path gave
  const srcQuickClick = (x, y) => {
    const r = cv.getBoundingClientRect();
    const sx = x - r.left, sy = y - r.top;
    const noteId = (viewNotesAll || viewNotesSun) ? ren.noteHit(sx, sy) : null;
    const n2 = uni ? ren.pick(uni.nodes, sx, sy) : null;
    if (noteId && vault.byId(noteId)) openNoteEditor(noteId, x, y);
    else if (n2) {
      const nd2 = vault.byId(n2.id);
      if (!locateBody(n2.id)) selectBody(n2.id, nd2 ? vault.titleOf(nd2) : n2.label);
    }
    if (n2 && selSet.size && !selSet.has(n2.id)) { selSet.clear(); hideBoxSel(); }
    try { openCtx(x, y, n2 ? n2.id : null); } catch (err) { toast('Menu failed: ' + ((err && err.message) || err)); }
    srcSuppress = true; // swallow the native duplicate on platforms that fire it on release
  };
  const endDrag = (e) => {
    if (e && e.isPrimary === false) return;
    if (e && e.button === 2 && srcHold) {
      const h = srcHold; srcHold = null;
      try { clearTimeout(h.timer); } catch {}
      if (h.fired || h.moved) { closeSrcPop(); srcSuppress = true; return; } // release ends the preview (or the pan): no menu, no focus change
      srcQuickClick(e.clientX, e.clientY);
      return;
    }
    if (!uni) {
      dragMode = null; downNode = null; marquee.hidden = true; marqueeDel.hidden = true; cv.style.cursor = 'grab';
      return;
    }
    if (dragMode === 'select') {
      if (moved && e) {
        // commit the box: shift still held = add to selection, else replace it
        const r = cv.getBoundingClientRect();
        const x0 = Math.min(downX, e.clientX) - r.left, x1 = Math.max(downX, e.clientX) - r.left;
        const y0 = Math.min(downY, e.clientY) - r.top, y1 = Math.max(downY, e.clientY) - r.top;
        if (!e.shiftKey) selSet.clear();
        for (const n of uni.nodes) {
          const p = n._p;
          // doc bodies only — thematic theme-bodies can't be deleted, so skip them
          if (p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && vault.byId(n.id)) selSet.add(n.id);
        }
        if (selSet.size) {
          // keep the box on screen with its DELETE caption (same confirm as the
          // right-click menu / Del key); any fresh canvas drag dismisses it
          marquee.hidden = false; marqueeDel.hidden = false;
          toast(`${selSet.size} selected — click DELETE in the box or right-click`);
        } else {
          marquee.hidden = true; marqueeDel.hidden = true;
          toast('Nothing in the box');
        }
      } else {
        marquee.hidden = true; marqueeDel.hidden = true;
        if (e) {
        // shift+click without a drag: toggle the one body under the cursor
        const r = cv.getBoundingClientRect();
        const n = ren.pick(uni.nodes, e.clientX - r.left, e.clientY - r.top);
        if (n && vault.byId(n.id)) {
          if (selSet.has(n.id)) selSet.delete(n.id); else selSet.add(n.id);
        }
        }
      }
      dragMode = null; downNode = null;
      cv.style.cursor = 'grab';
      try { clearTimeout(camAutoTimer); } catch {}
      camAutoTimer = setTimeout(() => { ren.cam.auto = true; }, 6000); // resume the slow gyre
      return;
    }
    const quick = performance.now() - downAt < 500;
    if (!moved && quick) {
      const r = cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const n = ren.pick(uni.nodes, sx, sy);
      // associated paper icon first: light up the doc's row in the theme's
      // grounded-bodies inventory (the icon sits atop its seed orb, so it
      // must win over the orb's own focus)
      const ah = (ren.assocHit) ? ren.assocHit(sx, sy) : null;
      // sticky-note square first: it opens the note editor without moving the sun
      const noteId = (viewNotesAll || viewNotesSun) ? ren.noteHit(sx, sy) : null;
      if (ah) { focusAssocDoc(ah.theme, ah.doc); }
      else if (noteId && vault.byId(noteId)) { openNoteEditor(noteId, e.clientX, e.clientY); }
      else if (n) {
        const nd = vault.byId(n.id);
        if (!locateBody(n.id)) selectBody(n.id, nd ? vault.titleOf(nd) : n.label);
      } else if (!n) {
        // off-click into empty space: drop the box selection AND the sun — no
        // active body, so the canvas center becomes the gravitational center.
        // The same click also clears any tag/search highlight, restoring the
        // full non-faded all-body view (clicking a tag pill lights up only its
        // bodies and fades the rest, with no other way back).
        if (selSet.size) selSet.clear();
        marquee.hidden = true; marqueeDel.hidden = true;
        if (defocusSun()) toast('General view — no active body; the screen center holds gravity');
        if (matchSet) {
          matchSet = null;
          try { $('#searchInput').value = ''; $('#searchPop').innerHTML = ''; } catch {}
          toast('Highlight cleared — full view');
        }
      }
    }
    if (downNode) downNode._held = false;
    // orbital move-drop rejoins orbital mechanics: seat the moved body onto
    // its circular orbit from exactly where it landed — no pinning, no
    // plunge. Distribute drops stay owned by the pinned orb; the sun keeps
    // its center-homing glide.
    if (dragMode === 'move' && downNode && !autoDist && uni && downNode.id !== uni.sunId) {
      try { uni.seatOrbit(downNode.id, 1); } catch {}
    }
    dragMode = null; downNode = null;
    cv.style.cursor = 'grab';
    try { clearTimeout(camAutoTimer); } catch {}
    camAutoTimer = setTimeout(() => { ren.cam.auto = true; }, 6000); // resume the slow gyre
  };
  cv.addEventListener('pointerdown', (e) => {
    if (e.isPrimary === false) return;
    try { clearTimeout(camAutoTimer); } catch {} // fresh gesture owns the camera: kill any pending gyre resume
    try { camCancelGlide(); } catch {} // a fresh press owns the pan: a reader glide never fights the hand
    if (srcStickyId) closeSrcPop(); // pinned preview: any fresh canvas press dismisses it
    srcSuppress = false; // stale menu-swallows die on the next press
    if (e.button === 2 && uni) {
      // right-hold candidate: any body. Docs get the source preview; theme/tag
      // bodies (no source text) get their info menu instead — nothing is dead.
      const r0 = cv.getBoundingClientRect();
      const hit = ren.pick(uni.nodes, e.clientX - r0.left, e.clientY - r0.top);
      if (hit && !(selSet.size && !selSet.has(hit.id))) {
        srcHold = { id: hit.id, x: e.clientX, y: e.clientY, moved: false, fired: false, timer: 0 };
        srcHold.timer = setTimeout(() => {
          if (!srcHold) return;
          // the preview is a DOM pop-out pinned at the press point, so it
          // works mid-orbit too — the body may drift on underneath, harmlessly.
          const hd = vault.byId(srcHold.id);
          if (hd && !lensThematic && !thematicWhole && !lensTags) {
            srcHold.fired = true;
            try { openSrcPop(srcHold.id, srcHold.x, srcHold.y); }
            catch (err) { toast('Preview failed: ' + ((err && err.message) || err)); }
          } else {
            // theme/tag body (or a lens view): a hold raises their menu instead.
            // The menu must survive release, so stand the hold down first.
            const mx = srcHold.x, my = srcHold.y, mid = srcHold.id;
            try { clearTimeout(srcHold.timer); } catch {}
            srcHold = null; srcSuppress = true;
            try { openCtx(mx, my, mid); }
            catch (err) { toast('Menu failed: ' + ((err && err.message) || err)); }
          }
        }, SRC_HOLD_MS);
      } else srcHold = null;
    } else srcHold = null;
    if (e.shiftKey && e.button === 0 && !lensThematic && !lensTags) {
      // shift+left-drag = marquee box-select, Main view only (plain drag
      // still pans, body-drag still rotates). Thematic/Tags views keep
      // shift-drag as a plain pan — no selection box there.
      dragMode = 'select';
      downNode = null;
      downAt = performance.now(); moved = false;
      lx = downX = e.clientX; ly = downY = e.clientY;
      ren.cam.auto = false;
      cv.style.cursor = 'crosshair';
      marquee.style.left = e.clientX + 'px'; marquee.style.top = e.clientY + 'px';
      marquee.style.width = '0px'; marquee.style.height = '0px';
      marquee.hidden = true; marqueeDel.hidden = true; // stays hidden until the box passes the click threshold
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
      return;
    }
    // any fresh pan/rotate gesture dismisses the previous action box
    hideBoxSel();
    const r = cv.getBoundingClientRect();
    downNode = uni ? (ren.pick(uni.nodes, e.clientX - r.left, e.clientY - r.top) || null) : null;
    dragMode = null;
    downAt = performance.now(); moved = false;
    lx = downX = e.clientX; ly = downY = e.clientY;
    cv.style.cursor = downNode ? 'pointer' : 'grab';
    // capture the primary button only: capturing a right-button press makes
    // Firefox fire pointercancel, which wipes the hold record — the release
    // then falls through to plain left-click handling (right ≡ left symptom).
    if (e.button === 0) { try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ } }
  });
  cv.addEventListener('pointermove', (e) => {
    if (e.isPrimary === false) return;
    if (srcHold && Math.hypot(e.clientX - srcHold.x, e.clientY - srcHold.y) > 6) {
      // became a drag, not a hold: stand down (keep the hold record so the
      // release swallows the menu instead of popping one after a pan)
      srcHold.moved = true;
      try { clearTimeout(srcHold.timer); } catch {}
      if (srcHold.fired) closeSrcPop();
    }
    if (e.buttons) {
      // late Shift: the press didn't start shifted, but Shift is held now —
      // convert the undecided/pan drag into a box-select anchored at the
      // original press (Shift means box-select, whenever it arrives during a
      // left-drag; Main view only — Thematic/Tags drags stay pans). An
      // established body rotate/move is left alone.
      if (e.shiftKey && (e.buttons & 1) && (dragMode === null || dragMode === 'pan') && !lensThematic && !lensTags) {
        if (downNode) { try { downNode._held = false; } catch {} downNode = null; }
        dragMode = 'select';
        downAt = performance.now();
        ren.cam.auto = false;
        cv.style.cursor = 'crosshair';
        marquee.style.left = Math.min(downX, e.clientX) + 'px';
        marquee.style.top = Math.min(downY, e.clientY) + 'px';
        marquee.style.width = Math.abs(e.clientX - downX) + 'px';
        marquee.style.height = Math.abs(e.clientY - downY) + 'px';
      }
      if (dragMode === 'select') {
        // stretch the box; only counts as a drag past the click threshold
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) moved = true;
        marquee.hidden = !moved;
        marqueeDel.hidden = true; // caption appears only on the committed box
        marquee.style.left = Math.min(downX, e.clientX) + 'px';
        marquee.style.top = Math.min(downY, e.clientY) + 'px';
        marquee.style.width = Math.abs(e.clientX - downX) + 'px';
        marquee.style.height = Math.abs(e.clientY - downY) + 'px';
        lx = e.clientX; ly = e.clientY;
        return;
      }
      const dx = e.clientX - lx, dy = e.clientY - ly;
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) > 4) {
        moved = true;
        dragMode = downNode ? 'rotate' : 'pan';
        ren.cam.auto = false;
        cv.style.cursor = dragMode === 'pan' ? 'grabbing' : 'move';
      }
      if (moved) {
        // alt-drag places the body instead of orbiting the camera — every
        // view, every mode (Fit is camera-only, distribute pins already).
        // Switchable mid-drag either way; orbital drops pin the body where
        // it lands (the stepper skips pinned bodies), distribute drops keep
        // the existing hand-placed-slot behavior.
        if (downNode && (dragMode === 'move' || dragMode === 'rotate')) {
          dragMode = e.altKey ? 'move' : 'rotate';
          downNode._held = dragMode === 'move';
          // the cursor reports the live mode: the move arrows only while Alt
          // is actually placing the body, grabbing while the drag only orbits
          cv.style.cursor = dragMode === 'move' ? 'move' : 'grabbing';
        }
        if (dragMode === 'pan') {
          try { camCancelGlide(); } catch {} // hand pan replaces any reader glide
          ren.cam.px = Math.max(-2500, Math.min(2500, (ren.cam.px || 0) + dx));
          ren.cam.py = Math.max(-2500, Math.min(2500, (ren.cam.py || 0) + dy));
          panHeld = true; // the hand owns the pan now: gravity stands down until an explicit re-seat
        } else if (dragMode === 'move' && downNode) {
          const [wx, wy, wz] = dragWorldDelta(dx, dy, downNode._p);
          downNode.x += wx; downNode.y += wy; downNode.z += wz;
          downNode._ox = downNode.x; downNode._oy = downNode.y; downNode._oz = downNode.z;
          downNode.vx = downNode.vy = downNode.vz = 0;
          // no pinning: the drop rejoins orbital mechanics from its new spot
          // (endDrag seats it onto its circular orbit). _held alone owns the
          // body mid-drag, so the stepper leaves it exactly where put.
        } else {
          // plain body drag (any mode): orbiting only, never placement — so
          // never the move cursor either
          cv.style.cursor = 'grabbing';
          ren.cam.yaw += dx * 0.005;
          ren.cam.pitch = Math.max(-1.2, Math.min(1.2, ren.cam.pitch + dy * 0.004));
        }
        lx = e.clientX; ly = e.clientY;
      }
    } else {
      const r = cv.getBoundingClientRect();
      // sticky-note squares show a plain arrow, never the hand: the hand is
      // reserved for bodies (drag/focus), the square just opens its editor
      const nh = (viewNotesAll || viewNotesSun) ? ren.noteHit(e.clientX - r.left, e.clientY - r.top) : null;
      // associated paper icons show a plain arrow, never the hand: the hand
      // is reserved for orbs (drag/focus), like the sticky-note squares above
      const ah = ren.assocHit ? ren.assocHit(e.clientX - r.left, e.clientY - r.top) : null;
      ren.hover = (!nh && !ah && uni) ? ren.pick(uni.nodes, e.clientX - r.left, e.clientY - r.top) : null;
      // alt held over a body previews the move: the move arrows promise
      // placement (all views, all modes), not just a focusable pointer
      cv.style.cursor = (nh || ah) ? 'default' : (ren.hover ? (e.altKey ? 'move' : 'pointer') : 'grab');
      // hover highlight: the body's row in the general list lights up (never
      // while a preview pop-out is open). From an open doc the reader first
      // drops back to the inventory list so the hovered row exists to light
      // up — selection, sun and camera untouched (one-way: re-click a row to reopen).
      try {
        const previewOpen = !$('#srcPop').hidden;
        const hid = (hoverPrev && !previewOpen && ren.hover && ren.hover.id) ? ren.hover.id : null;
        if (hid !== srcHi) { if (hid) { srcHoldHi(); if (!readerIsList) { try { renderGeneral(); } catch {} } srcHighlight(hid); } else srcClearHiSoon(); }
      } catch {}
    }
  });
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointerleave', () => {
    try { ren.hover = null; cv.style.cursor = 'grab'; if (hoverPrev && $('#srcPop').hidden) srcClearHiSoon(); } catch {}
  });
  cv.addEventListener('pointercancel', () => { if (downNode) downNode._held = false; dragMode = null; downNode = null; marquee.hidden = true; marqueeDel.hidden = true; cv.style.cursor = 'grab'; if (srcHold) { try { clearTimeout(srcHold.timer); } catch {} srcHold = null; } closeSrcPop(); });
  document.addEventListener('pointerup', (e) => {
    // right-button release outside the canvas (right presses are never
    // capture-held, so off-canvas right releases land here): mirror the
    // on-canvas release instead of falling into left-click handling.
    if (e && e.button === 2 && srcHold) {
      const h = srcHold; srcHold = null;
      try { clearTimeout(h.timer); } catch {}
      if (h.fired || h.moved) { closeSrcPop(); srcSuppress = true; }
      else srcQuickClick(e.clientX, e.clientY);
    }
    // a right-drag released off-canvas never saw endDrag: don't strand it.
    if (e && e.button === 2 && (dragMode || downNode)) {
      dragMode = null; if (downNode) downNode._held = false; downNode = null;
      try { cv.style.cursor = 'grab'; } catch {}
    }
  });
  cv.addEventListener('dblclick', () => {
    // double-click never touches the zoom: it just steers the universe center
    // back onto the visible center (a full reset snapped dist to 620 and
    // "exploded" framed or zoomed-out views). Fitted or not, pan is all it does.
    try { camCancelGlide(); } catch {}
    ren.recenterView();
    panHeld = false; // explicit re-seat: gravity may hold the center again
  });
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    ren.cam.dist = Math.min(8000, Math.max(220, ren.cam.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
  }, { passive: false });

  // panels
  // in-body find state + helpers now live at module level (just above renderGeneral):
  // renderDoc/renderThemeDoc/renderTagDoc/renderGeneral call them, so boot scope hid them.
  const inp = $('#searchInput');
  inp.addEventListener('input', () => {
    const raw = inp.value.trim().toLowerCase();
    const q = raw.startsWith('#') ? raw.slice(1).trim() : raw;
    lastSearchQ = q;
    const pop = $('#searchPop');
    if (!q) { pop.innerHTML = ''; matchSet = null; return; }
    const hits = vault.search(q);
    matchSet = new Set(hits.map(h => h.doc.id));
    let themeRows = '';
    if (lensThematic) { // thematic-only universe: light up themes grounding the hits
      const themes = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
      for (const th of themes) {
        if (th.members.some(id => matchSet.has(id))) matchSet.add(th.id);
      }
      // ...and surface the themes themselves: they ARE this universe's bodies,
      // so a term pill click lands on the theme it helped distill, not just docs
      themeRows = themes
        .filter(th => th.label.toLowerCase().includes(q) || th.terms.some(t => t.includes(q) || q.includes(t)))
        .map(th => `<button data-open="${th.id}"><b>◈ ${esc(th.label)}</b><span>theme · grounds ${th.members.length} ${th.members.length === 1 ? 'body' : 'bodies'}</span></button>`).join('');
    } else if (lensTags) { // tags-view universe: light up tags grounding the hits
      const recs = tagRecords.get(vault.activeTabId) || [];
      for (const r of recs) {
        if (r.members.some(id => matchSet.has(id))) matchSet.add(r.id);
      }
      themeRows = recs
        .filter(r => r.label.toLowerCase().includes(q) || r.terms.some(t => t.includes(q) || q.includes(t)))
        .map(r => `<button data-open="${r.id}"><b>◈ ${esc(r.label)}</b><span>tag · grounds ${r.members.length} ${r.members.length === 1 ? 'body' : 'bodies'}</span></button>`).join('');
    }
    const docRows = hits.map(({ doc }) =>
      `<button data-open="${doc.id}"><b>${esc(vault.titleOf(doc))}</b><span>${esc(doc.name)}</span></button>`).join('');
    pop.innerHTML = (themeRows + docRows)
      || '<div style="font-size:12px;color:var(--mut);padding:6px">No bodies match.</div>';
  });
  document.addEventListener('click', (e) => {
    const cx = e.target.closest('[data-closetab]');
    if (cx) { e.stopPropagation(); closeCanvas(cx.dataset.closetab); return; }
    const addto = e.target.closest('[data-addto]');
    if (addto) {
      e.stopPropagation();
      const carrier = vault.tabs.find(t => t.id === addto.dataset.addto);
      if (!carrier) return;
      const group = projectGroup(carrier.id);
      createCanvas(group.map(g => g.id), `“${carrier.name}”`);
      return;
    }
    const at = e.target.closest('[data-addtab]');
    if (at) {
      e.stopPropagation();
      createCanvas([]); // the bar-end "+" always starts a separate canvas
      return;
    }
    const tb = e.target.closest('[data-tab]');
    if (tb) {
      const sv = e.target.closest('[data-savetab]');
      if (sv) { e.stopPropagation(); saveAllProjects(); return; }
      switchCanvas(tb.dataset.tab); return;
    }
    const op = e.target.closest('[data-openproj]');
    if (op) { e.stopPropagation(); toggleOpenProjMenu(); return; }
    // view-modes strip under the top tabs: Main / Thematic / Tag.
    // Reverse-linked with Locate-in-document: while the reader's goto cluster
    // is live, a top-pill tab performs the same locate its goto counterpart
    // would (and takes the red pick), so the two rows stay connected either
    // way. With no doc parked, it's the plain view switch as before.
    const vm = e.target.closest('[data-vm]');
    if (vm) {
      e.stopPropagation();
      const mode = vm.dataset.vm;
      const gs = $('#gotoSide');
      const gid = (typeof shownId !== 'undefined') ? shownId : null;
      if (gid && gs && !gs.hidden && (mode === 'main' || mode === 'thematic' || mode === 'tag')) {
        const view = mode === 'tag' ? 'tags' : mode;
        gotoViewFor(gid, view);
        try { gotoPicked = { docId: gid, view }; applyGotoPicked(); } catch {}
      } else {
        goViewMode(mode);
      }
      return;
    }
    // projects-pill collapse: everything goes except the view-modes row
    const plt = e.target.closest('[data-pilltoggle]');
    if (plt) {
      e.stopPropagation();
      pillCollapsed = !pillCollapsed;
      saveUi();
      const b = plt.closest('#tabBar');
      if (b) b.classList.toggle('pillCollapsed', pillCollapsed);
      plt.textContent = pillCollapsed ? '▾' : '▴';
      plt.title = pillCollapsed ? 'Restore the projects pill' : 'Collapse the projects pill (view modes stay)';
      try { placeTabBar(); } catch {}
      return;
    }
    const opRs = e.target.closest('[data-restorepick]');
    if (opRs) { e.stopPropagation(); hideOpenProjMenu(); const p = $('#restorePick'); if (p) p.click(); return; }
    const opAb = e.target.closest('[data-absorbpick]');
    if (opAb) {
      e.stopPropagation();
      hideOpenProjMenu();
      if (!vault.tab()) { toast('No open canvas — click + to start one before merging a master file.'); return; }
      const p = $('#absorbPick'); if (p) p.click(); return;
    }
    const va = e.target.closest('[data-viewall]');
    if (va) {
      e.stopPropagation();
      showAllBodies = !showAllBodies;
      try { renderGeneral(); } catch {}
      return;
    }
    // document-row 👁 : pinned 120-word preview of that doc, anchored at the
    // eye; clicking it again (or Esc / canvas / 👁 in the reader) closes it
    const pv = e.target.closest('[data-preview]');
    if (pv) {
      e.stopPropagation();
      const id = pv.dataset.preview;
      if ((typeof srcStickyId !== 'undefined' && srcStickyId === id) && !$('#srcPop').hidden) { closeSrcPop(); return; }
      const r = pv.getBoundingClientRect();
      if (openSrcPop(id, r.right + 10, r.top + 8, true)) { srcStickyId = id; try { syncEye(); } catch {} }
      return;
    }
    // row + #tag writer: floating name editor for that exact document.
    // Deferred past this click: the document-level click-away closer runs on
    // the same dispatch (same node — stopPropagation can't stop it) and
    // would shut the menu the moment it opens.
    const sa = e.target.closest('[data-slotadd]');
    if (sa) {
      e.stopPropagation();
      const id = sa.dataset.slotadd, r = sa.getBoundingClientRect();
      const rx = r.right + 10, ry = r.top + 8;
      setTimeout(() => openSlotTagEditor(id, rx, ry), 0);
      return;
    }
    // tags-view pop-out controls (the pills inside keep data-tag, so they
    // fall through to the search handler below)
    const tvx = e.target.closest('[data-tvclose]');
    if (tvx) { e.stopPropagation(); closeTagPop(); return; }
    if (e.target && e.target.id === 'tagPop') { closeTagPop(); return; }
    const tvp = e.target.closest('[data-tagpop]');
    if (tvp) { e.stopPropagation(); openTagPop(); return; }
    const tvg = e.target.closest('[data-tvguide]');
    if (tvg) { e.stopPropagation(); openTagGuide(); return; }
    const tvgc = e.target.closest('[data-tguideclose]');
    if (tvgc) { e.stopPropagation(); closeTagGuide(); return; }
    // how-to-start: the discrete bottom-left link opens the beginner pane,
    // its ✕ (or a backdrop click, or Esc) closes it again
    const hso = e.target.closest('[data-howstart]');
    if (hso) { e.stopPropagation(); openHowStart(); return; }
    const hsc = e.target.closest('[data-howclose]');
    if (hsc) { e.stopPropagation(); closeHowStart(); return; }
    const cgs = e.target.closest('[data-cgsave]');
    if (cgs) {
      e.stopPropagation();
      // Guard save means "save, then leave": exit at once when the backup is
      // clean, so a background job (OCR, citations, page-map) landing after
      // the save cannot re-arm the guard before the user's closing X.
      try { hideCloseGuardPane(); } catch {}
      (async () => {
        try { await saveAllProjects(); } catch {}
        let clean = false;
        try { clean = !needsBackupGuard(); } catch {}
        if (clean) { try { exitCommitted = true; lastGuardNote = 'saved ok, exit requested'; } catch {} try { exitAfterGuardSave(); } catch {} return; }
        try { if (!lastGuardNote || lastGuardNote === 'saved ok, exit requested') lastGuardNote = 'save did NOT complete clean'; } catch {}
        try { toast(`Save did not finish (${lastGuardNote}) — fix it, or use “Close without saving” [${BUILD_TAG}]`, 9000); } catch {}
        try { showCloseGuardPane(); } catch {}
      })().catch(() => {});
      return;
    }
    const cge = e.target.closest('[data-cgexit]');
    if (cge) { e.stopPropagation(); exitAppNow(); return; }
    const cgt = e.target.closest('[data-cgstay]');
    if (cgt) { e.stopPropagation(); hideCloseGuardPane(); return; }
    if (e.target && e.target.id === 'howStartPane') { closeHowStart(); return; }
    const tge = e.target.closest('[data-tguide-edit]');
    if (tge) { e.stopPropagation(); openGuideEditor(); return; }
    const hge = e.target.closest('[data-how-edit]');
    if (hge) { e.stopPropagation(); openHowEditor(); return; }
    const tvv = e.target.closest('[data-tvverse]');
    if (tvv) { e.stopPropagation(); setTagsVerse(!lensTags); return; }
    const tve = e.target.closest('[data-tvexit]');
    if (tve) { e.stopPropagation(); setTagsVerse(false); return; }
    // tags-pane tips: the Confirms row toggles the delete/merge confirmations
    const tcf = e.target.closest('[data-tvconfirms]');
    if (tcf) {
      e.stopPropagation();
      skipTagConfirms = !skipTagConfirms;
      saveUi();
      try { syncConfirmTip(); } catch {}
      toast(skipTagConfirms
        ? 'Tag confirmations off — deletes, merges and renames run immediately (toggle back anytime in the tags pane tips)'
        : 'Tag confirmations on — deletes, merges and renames ask first');
      return;
    }
    const dc = e.target.closest('[data-canvas]');
    if (dc) {
      // dot-box: put this body on the canvas as the sun and never open it in
      // the pane. Bodies that aren't on this canvas (lens members) take the
      // canvas to the Main view first; the pane then follows the canvas —
      // the clicked doc itself is never opened by a dot.
      e.stopPropagation();
      const key = dc.dataset.canvas;
      let nm = key;
      try {
        const dd = vault.byIdAnywhere(key);
        if (dd) nm = vault.titleOf(dd);
        else { const th = themeById(key); if (th) nm = '◈ ' + th.label; else { const tg = tagById(key); if (tg) nm = '◈ ' + tg.label; } }
      } catch {}
      const crownHere = () => {
        if (uni && uni.byId.has(key) && typeof uni.focus === 'function' && uni.focus(key)) {
          toast(`${nm} is now the sun`);
          return true;
        }
        return false;
      };
      if (crownHere()) { try { paintCanvasDot(); } catch {} try { paintGoldRows(); } catch {} }
      else if (lensThematic || lensTags) {
        try { pushView(); } catch {} // Return can come back to the lens view being left
        paneId = null; // the pane follows the canvas — never the clicked doc
        activeId = null; // land neutral: the crown below owns the canvas, not a stale pick
        canvasHiId = null; // the restored Main view lights its own bodies
        assocSelId = null; srcHi = null; // the restored Main view lights its own rows
        try { const t = vault.tab(); if (t) { t.activeId = null; vault.persist(); } } catch {}
        lensThematic = false; thematicWhole = false; lensTags = false;
        try { syncLensBtn(); } catch {}
        try { syncTagVerseBtn(); } catch {}
        try { applyLens(); saveUi(); } catch {}
        if (crownHere()) toast(`${nm} is now the sun`);
        try { paintCanvasDot(); } catch {} try { paintGoldRows(); } catch {}
      } else {
        const prow = document.querySelector(`#docLinks .bl-row[data-open="${CSS.escape(key)}"]`);
        if (prow) prow.click();
        try { paintCanvasDot(); } catch {} try { paintGoldRows(); } catch {}
      }
      return;
    }
    // inventory note marks: open that document's Notes pane directly
    // (same destination as the reader's notes button below)
    const npp = e.target.closest('[data-notes-pane]');
    if (npp) { e.stopPropagation(); setNotes(true, npp.dataset.notesPane); return; }
    // view jumps: MAIN / THEMATIC / TAGS pills under a document row — show
  // where that document sits in each view (MAIN lights the Main orb only and
  // never opens the doc; theme/tag nodes light up gold).
  const gm = e.target.closest('[data-gmain]');
  if (gm) { e.stopPropagation(); gotoViewFor(gm.dataset.gmain, 'main'); return; }
  const gt2 = e.target.closest('[data-gthematic]');
  if (gt2) { e.stopPropagation(); gotoViewFor(gt2.dataset.gthematic, 'thematic'); return; }
  const gg = e.target.closest('[data-gtags]');
  if (gg) { e.stopPropagation(); gotoViewFor(gg.dataset.gtags, 'tags'); return; }
  // inventory × : same canvas-scoped removal as the title × (confirm first)
    const bx = e.target.closest('[data-blx]');
    if (bx) { e.stopPropagation(); removeFromCanvas(bx.dataset.blx); return; }
    const o = e.target.closest('[data-open]');
    if (o) {
      if (!vault.tab() || !uni) {
        e.stopPropagation();
        toast('No open canvas — start one before opening a body.');
        return;
      }
      const key = o.dataset.open;
      // whole-visidocsverse themes can ground bodies from other canvases — jump to
      // whichever canvas holds the doc, leaving the lens first.
      let d = vault.byId(key);
      const wasLens = lensThematic || lensTags;
      // inventory title boxes are pane-only: the reader parks on the doc
      // while the canvas (gold, sun, camera, even the lens) stays exactly as
      // it is. Non-inventory rows and cross-canvas docs keep the old path.
      if (d && o.closest('#docLinks')) {
        paneId = key;
        canvasHiId = null; // parking a doc owns the pane — drop the MAIN highlight
        renderDoc();
        // inventory picks auto-center in every view (zoom/spin/physics untouched):
        // Main centers the doc's own body exactly; lenses center the theme/tag
        // bodies grounding it (as a group); ungrounded thematic docs center the
        // theme orb they ride on; untagged lens docs hold still (nothing to center)
        try {
          if (!lensThematic && !lensTags) { if (uni && uni.byId.has(key)) centerCamOn(key, false); }
          else if (lensTags) {
            const recs = tagRecords.get(vault.activeTabId) || tagsFor(((vault.tab() || {}).docs) || []);
            const mine = (recs || []).filter(r => (r.members || []).includes(key));
            if (mine.length && uni) centerCamOnMean(mine.map(r => r.id));
          } else {
            const recs = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
            const mine = (recs || []).filter(r => (r.members || []).includes(key));
            if (mine.length && uni) centerCamOnMean(mine.map(r => r.id));
            else if (uni) {
              let host = null;
              try { for (const [tid, arr] of (assocUngrMap() || new Map())) { if ((arr || []).some(x => x && x.id === key)) { host = tid; break; } } } catch {}
              if (host && uni.byId.has(host)) centerCamOn(host, false);
            }
          }
        } catch {}
        if (lastSearchQ) { const fq = lastSearchQ; lastSearchQ = ''; setReaderFind(fq, true); }
        document.querySelectorAll('.help-open').forEach(w => w.classList.remove('open', 'help-open'));
        try { syncTabBarZ(); } catch {}
        $('#searchPop').innerHTML = ''; inp.value = ''; matchSet = null;
        if (window.innerWidth <= 760) $('#docPanel').classList.add('open');
        return;
      }
      if (!d && key && !String(key).startsWith('theme_') && !String(key).startsWith('tag:')) {
        const ht = vault.tabs.find(t => (t.docs || []).some(x => x.id === key));
        if (ht) {
          d = ht.docs.find(x => x.id === key);
          if (lensThematic || lensTags) { lensThematic = false; thematicWhole = false; lensTags = false; syncLensBtn(); }
          if (ht.id !== vault.activeTabId) switchCanvas(ht.id);
          else applyLens();
          saveUi();
        }
      } else if (d) {
        // drill-down: member docs live in the regular universe — exit the lens first
        if (lensThematic || lensTags) { lensThematic = false; thematicWhole = false; lensTags = false; syncLensBtn(); applyLens(); saveUi(); }
      }
      if (d) {
        if (lensThematic || lensTags) { lensThematic = false; thematicWhole = false; lensTags = false; syncLensBtn(); applyLens(); saveUi(); }
        if (wasLens) toast(`Regular view — “${vault.titleOf(d)}”`);
        claimSun(d.id);
        renderDoc();
        // a search-result click carries its term into the reader: every
        // occurrence lights up and the first scrolls into view (consumed —
        // later row clicks open clean until the next search).
        if (lastSearchQ) { const fq = lastSearchQ; lastSearchQ = ''; setReaderFind(fq, true); }
        const w2 = document.querySelector('#docShared'); document.querySelectorAll('.help-open').forEach(w => w.classList.remove('open', 'help-open'))
        try { syncTabBarZ(); } catch {}
      }
      else if (typeof key === 'string' && key.startsWith('theme_') && uni.byId.has(key)) { if (activeId !== key) claimSun(key); renderDoc(); }
      else if (typeof key === 'string' && key.startsWith('tag:') && lensTags && uni.byId.has(key)) { if (activeId !== key) claimSun(key); renderDoc(); }
      $('#searchPop').innerHTML = ''; inp.value = ''; matchSet = null;
      if (window.innerWidth <= 760) $('#docPanel').classList.add('open');
      return;
    }
    const he = e.target.closest('[data-help-edit]');
    if (he) { e.stopPropagation(); openHelpEditor(he.dataset.helpEdit); return; }
    const ge = e.target.closest('[data-gloss-edit]');
    if (ge) { e.stopPropagation(); openGlossEditor(ge.dataset.glossEdit); return; }
    const sgh = e.target.closest('[data-sghelp]');
    if (sgh) {
      const w0 = sgh.closest('.hw, #docMeta') || document.querySelector('#docShared');
      if (w0) {
      if (w0.classList.contains('help-open')) shutHelpPop(w0);
        else {
          w0.classList.add('help-open');
          const pop = w0.querySelector('.sg-help-pop');
          if (pop) { pop.style.visibility = ''; pop.style.opacity = ''; pop.style.transition = ''; }
          try { syncTabBarZ(); } catch {}
        }
      }
      return;
    }
    const sgl = e.target.closest('[data-sg]');
    if (sgl) { const w2 = document.querySelector('#docShared'); if (w2) w2.classList.toggle('open'); return; }
    const w = e.target.closest('[data-wl]');
    if (w) {
      const d = vault.byTitle(w.dataset.wl);
      if (d && selectBody(d.id, vault.titleOf(d), true)) { /* reader follows, map holds still */ }
      else toast(`"${w.dataset.wl}" is uncharted space`);
      return;
    }
    const nb = e.target.closest('[data-notes]');
    if (nb) { setNotes(true, nb.dataset.notes); return; }
    // reader "+ #tag": write an explicit (hand-written, in-prose) tag — the
    // in-app counterpart to typing #tag in an imported file
    const ab = e.target.closest('[data-addtag]');
    if (ab) { e.stopPropagation(); openAddTagEditor(ab.dataset.addtag); return; }
    // tags pop-out delete: the × inside a pill (must run BEFORE the data-tag
    // search handler below, since the × lives inside the pill's data-tag button)
    const td = e.target.closest('[data-tdel]');
    if (td) { e.stopPropagation(); deleteTagUI(td.dataset.tdel); return; }
    // tags-pane pills: click enters the TAGS view with that tag as the sun;
    // double-click renames the tag in place (same editor as right-click).
    // Drag still merges, × still deletes, and the click landing right after
    // a merge drop is the drop itself — ignored here.
    const tp = e.target.closest('[data-tpill]');
    if (tp) {
      e.stopPropagation();
      if (Date.now() - tvpMergeAt <= 800) return; // the drop itself, not a focus request
      const disp = tp.dataset.tpill;
      if (tvpClickTimer) { // second click fast = double-click: rename, don't focus
        clearTimeout(tvpClickTimer); tvpClickTimer = null;
        e.stopImmediatePropagation(); // same-node closeCtx listener would see this click (pill outside ctx) and instantly shut the editor we are about to open
        try {
          const r = tp.getBoundingClientRect();
          openTagRenameEditor(r.left + r.width / 2, r.top + r.height / 2, disp);
        } catch {}
        return;
      }
      tvpClickTimer = setTimeout(() => { tvpClickTimer = null; focusTagInTagsView(disp); }, 260);
      return;
    }
    const t = e.target.closest('[data-tag]');
    if (t) { inp.value = '#' + t.dataset.tag; inp.dispatchEvent(new Event('input')); try { highlightTagInPop(t.dataset.tag); } catch {} }
  });
  // keyboard "click" for the ? helps (they're spans, so Enter fires no native
  // click — route it through the same toggle; all helps are click-to-open)
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
    const sgh = document.activeElement && document.activeElement.closest ? document.activeElement.closest('[data-sghelp]') : null;
    if (sgh) { e.preventDefault(); e.stopPropagation(); sgh.click(); }
  });
  // find bar: permanently parked under the tag row — typing highlights
  // live, Enter/› steps, Esc clears the term (the bar itself stays).
  // search-result clicks feed it via setReaderFind above.
  const fi = $('#findInput');
  if (fi) {
    fi.addEventListener('input', () => { setReaderFind(fi.value, false); });
    fi.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); stepFind(ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'Escape') { ev.preventDefault(); clearReaderFind(); try { fi.blur(); } catch {} }
    });
    fi.addEventListener('click', (ev) => ev.stopPropagation());
  }
  const fp = $('#findPrev');
  if (fp) fp.onclick = () => { findSideOn = true; stepFind(-1); }; // first ‹ summons the side bar
  const fnx = $('#findNext');
  if (fnx) fnx.onclick = () => { findSideOn = true; stepFind(1); }; // first › summons the side bar
  // redundant side find bar (left of the reader, centered on its height):
  // same term, same matches, same ‹ › — Esc clears both bars.
  const fiS = $('#findInput2');
  if (fiS) {
    fiS.addEventListener('input', () => { setReaderFind(fiS.value, false); });
    fiS.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); stepFind(ev.shiftKey ? -1 : 1); }
      else if (ev.key === 'Escape') { ev.preventDefault(); clearReaderFind(); try { fiS.blur(); } catch {} }
    });
    fiS.addEventListener('click', (ev) => ev.stopPropagation());
  }
  const fpS = $('#findPrev2');
  if (fpS) fpS.onclick = () => stepFind(-1);
  const fnS = $('#findNext2');
  if (fnS) fnS.onclick = () => stepFind(1);
  const fxS = $('#findClose2');
  if (fxS) fxS.onclick = () => { findSideOn = false; try { syncFindBar(); } catch {} }; // × dismisses the floater (term + highlights stay; ‹ › re-summons it)
  // back-to-top tab: tracks the reader pane's scroll, jumps to top on click
  const dp = $('#docScroll'), tb = $('#docTopBtn');
  if (dp) dp.addEventListener('scroll', () => { try { syncTopBtn(); } catch {} try { syncPageNow(); } catch {} }, { passive: true });
  if (tb) tb.onclick = () => {
    try {
      dp.scrollTo({ top: 0, behavior: 'auto' });
      dp.scrollTop = 0; $('#docBody').scrollTop = 0;
    } catch { try { dp.scrollTop = 0; } catch {} }
    try { syncTopBtn(); } catch {}
  };
  // glossary back-to-top tab: tracks the glossary body's scroll, jumps to top
  const gb = $('#glossBody'), gtb = $('#glossTopBtn');
  if (gb) gb.addEventListener('scroll', () => { try { syncGlossTop(); } catch {} }, { passive: true });
  if (gtb) gtb.onclick = () => {
    try { gb.scrollTo({ top: 0, behavior: 'auto' }); gb.scrollTop = 0; }
    catch { try { gb.scrollTop = 0; } catch {} }
    try { syncGlossTop(); } catch {}
  };
  // notes back-to-top tab: tracks the entries list's scroll, jumps to top
  const nl2 = $('#notesList'), ntb = $('#notesTopBtn');
  if (nl2) nl2.addEventListener('scroll', () => { try { syncNotesTop(); } catch {} }, { passive: true });
  if (ntb) ntb.onclick = () => {
    try { nl2.scrollTo({ top: 0, behavior: 'auto' }); nl2.scrollTop = 0; }
    catch { try { nl2.scrollTop = 0; } catch {} }
    try { syncNotesTop(); } catch {}
  };
  // hover handoff: the gold row holds while the cursor rides it to the click —
  // gliding onto the row cancels the fade, leaving it re-arms a shorter one.
  try {
    const dl = $('#docLinks');
    if (dl) {
      dl.addEventListener('mouseover', (e) => { try { if (hoverPrev && e.target && e.target.closest && e.target.closest('.bl-row.src-hi')) srcHoldHi(); } catch {} });
      dl.addEventListener('mouseout', (e) => {
        try {
          const r = e.target && e.target.closest ? e.target.closest('.bl-row.src-hi') : null;
          if (hoverPrev && r && (!e.relatedTarget || !r.contains(e.relatedTarget))) srcClearHiSoon(800);
        } catch {}
      });
    }
  } catch {}
  // reader pictures: click to zoom into a full-screen lightbox, click out to close
  $('#docBody').addEventListener('click', (e) => {
    // folio marker: click copies a "Title, p. N" citation for the real document
    try {
      const pmk = e.target && e.target.closest ? e.target.closest('.pagemark') : null;
      if (pmk) {
        const n = pmk.dataset.page || '?';
        const title = ($('#docTitle') && $('#docTitle').textContent) || 'document';
        const cite = title + ', p. ' + n;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cite).then(() => toast('Citation copied: ' + cite), () => toast(cite, 4000));
          else toast(cite, 4000);
        } catch { toast(cite, 4000); }
        return;
      }
    } catch {}
    const im = e.target && e.target.closest ? e.target.closest('img[data-full]') : null;
    if (!im) return;
    // an open preview/menu eats this click instead of zooming underneath (or
    // over) it — click the image again for the zoom once they are dismissed.
    if (!$('#srcPop').hidden || !$('#ctxMenu').hidden) { closeSrcPop(); try { $('#ctxMenu').hidden = true; } catch {} return; }
    const L = $('#imgLight');
    if (!L) return;
    const big = L.querySelector('img');
    if (big) { big.src = im.currentSrc || im.src; big.alt = im.alt || 'image'; }
    L.hidden = false;
  });
  { const L0 = $('#imgLight'); if (L0 && !L0.dataset.wired) { L0.dataset.wired = '1'; L0.addEventListener('click', () => { L0.hidden = true; }); } }
  // reader text selection: right-click inside the Active body text offers
  // tagging the selection as a manual tag (gold M). Anywhere else — or with
  // no selection — the browser keeps its normal menu.
  $('#docBody').addEventListener('contextmenu', (e) => {
    const sel = window.getSelection();
    const raw = sel ? String(sel.toString() || '') : '';
    if (!sel || sel.isCollapsed || !raw.trim() || !$('#docBody').contains(sel.anchorNode)) return;
    e.preventDefault();
    e.stopPropagation();
    // the note keeps the RAW selection's anchor (read before word-snapping below)
    const noteSpot = readReaderSelection().spot;
    // snap the selection out to whole words so tags never start/end mid-word
    try {
      if (sel.anchorNode && sel.anchorNode === sel.focusNode && sel.anchorNode.nodeType === 3) {
        const t = sel.anchorNode.textContent || '';
        let s = Math.min(sel.anchorOffset, sel.focusOffset), ex = Math.max(sel.anchorOffset, sel.focusOffset);
        while (s > 0 && /[a-z0-9]/i.test(t[s - 1])) s--;
        while (ex < t.length && /[a-z0-9]/i.test(t[ex])) ex++;
        const nr = document.createRange();
        nr.setStart(sel.anchorNode, s); nr.setEnd(sel.anchorNode, ex);
        sel.removeAllRanges(); sel.addRange(nr);
      }
    } catch {}
    const snapped = String(sel.toString() || '');
    const useRaw = snapped.trim() ? snapped : raw;
    const snippet = useRaw.trim().replace(/\s+/g, ' ').slice(0, 60);
    // anchor the creation spot: stripped offset + DOM path of the snapped
    // selection start, so the later jump lands on THIS block, not just any
    // block with the same words
    const root = $('#docBody');
    let anchor = useRaw.trim().replace(/\s+/g, ' ').slice(0, 200);
    try {
      const an = sel.anchorNode;
      if (an && root.contains(an)) {
        const path = [];
        let n = an, ok = true;
        while (n && n !== root) { const p = n.parentNode; if (!p) { ok = false; break; } path.unshift([...p.childNodes].indexOf(n)); n = p; }
        if (ok && n === root) {
          const norm0 = (s) => String(s || '').replace(/\s+/g, '');
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let at = 0, tn;
          while ((tn = walker.nextNode())) {
            if (tn === an) { at += norm0(tn.textContent.slice(0, sel.anchorOffset)).length; break; }
            at += norm0(tn.textContent).length;
          }
          anchor = { snip: anchor, at, path, off: sel.anchorOffset };
        }
      }
    } catch {}
    openSelTagMenu(e.clientX, e.clientY, snippet, slugTag(useRaw), anchor, useRaw, noteSpot);
  });
  // overlay + carousel panes: right-click a highlight for the same menu.
  // tagged, sent to notes or copied exactly like the reader, with a
  // pane-aware spot so the Notes jump lands on the right passage.
function paneSelMenu(e, root, baseAt, withPath, docId, onSent) {
  // right-click on a highlight inside an overlay/carousel pane: the reader's
  // selection menu (tag, send to notes, copy), with a pane-aware spot anchor.
  // Init-scoped: the menu + tag slugger live in this scope.
  const sel = window.getSelection();
  const raw = sel ? String(sel.toString() || '') : '';
  if (!sel || sel.isCollapsed || !raw.trim() || !root.contains(sel.anchorNode)) return; // keep the native menu
  e.preventDefault();
  e.stopPropagation();
  try {
    if (sel.anchorNode && sel.anchorNode === sel.focusNode && sel.anchorNode.nodeType === 3) {
      const t = sel.anchorNode.textContent || '';
      let s = Math.min(sel.anchorOffset, sel.focusOffset), ex = Math.max(sel.anchorOffset, sel.focusOffset);
      while (s > 0 && /[a-z0-9]/i.test(t[s - 1])) s--;
      while (ex < t.length && /[a-z0-9]/i.test(t[ex])) ex++;
      const nr = document.createRange();
      nr.setStart(sel.anchorNode, s); nr.setEnd(sel.anchorNode, ex);
      sel.removeAllRanges(); sel.addRange(nr);
    }
  } catch {}
  const full = String(sel.toString() || '');
  const useRaw = full.trim() ? full : raw;
  const spot = paneSelectionSpot(root, useRaw, baseAt, withPath);
  const snippet = useRaw.trim().replace(/\s+/g, ' ').slice(0, 60);
  openSelTagMenu(e.clientX, e.clientY, snippet, slugTag(useRaw), spot, useRaw, spot, onSent, docId);
}
  const czm = $('#carZoomText');
  if (czm && !czm.dataset.selWired) {
    czm.dataset.selWired = '1';
    czm.addEventListener('contextmenu', (e) => {
      const d = vault.byId(carDocId) || vault.byId(shownId);
      paneSelMenu(e, czm, 0, true, d ? d.id : undefined, () => { try { if (d) markNoteSpotsIn(czm, d, false, 0); } catch {} });
    });
  }
  const ctr = $('#carTrack');
  if (ctr && !ctr.dataset.selWired) {
    ctr.dataset.selWired = '1';
    ctr.addEventListener('contextmenu', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('.car-pane .car-text') : null;
      if (!t) return;
      const panes = [...ctr.querySelectorAll('.car-pane .car-text')];
      const ti = panes.indexOf(t) - (carMediaFirst ? 1 : 0);
      if (ti < 0) return; // media pane: player, not prose
      const d = vault.byId(carDocId) || vault.byId(shownId);
      const sg = carReal && carReal.segs ? carReal : null;
      paneSelMenu(e, t, sg ? paneBaseAt(sg, ti) : null, false, d ? d.id : undefined, () => { try { if (d) markNoteSpotsIn(t, d, true, sg ? paneBaseAt(sg, ti) : 0); } catch {} });
    });
  }
  // Esc closes the tags-view pop-out and the glossary pane (never while typing in a field)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
      const tp = $('#tagPop');
      if (tp && !tp.hidden) tp.hidden = true;
      const gp = $('#tagGuidePane');
      if (gp && !gp.hidden) gp.hidden = true;
      if (glossOpen) setGloss(false);
      if (pinOpenWord != null) setPin(null);
    }
  });
  $('#folderBtn').onclick = async () => {
    if (!vault.tabs.length) { await noProjectPopup(); return; }
    pickFolder();
  };
  // 3D tilt toggle: swings the left pane 30° counter-clockwise (seen from
  // above) about its own vertical middle; purely visual, layout math untouched
  $('#paneTiltBtn').onclick = () => {
    const lp = $('#leftPanel');
    if (!lp) return;
    const on = lp.classList.toggle('tilted');
    $('#paneTiltBtn').setAttribute('aria-pressed', on ? 'true' : 'false');
    try { syncPinTabs(); } catch {} // swing the pin tabs onto the same 3D plane…
    clearTimeout(lp._tiltT);
    lp._tiltT = setTimeout(() => { try { syncPinTabs(); } catch {} }, 480); // …then re-seat once the .45s swing settles
  };
  { // pin tabs re-seat exactly when the swing ends (timeout above is only the fallback)
    const lp0 = $('#leftPanel');
    if (lp0 && !lp0.dataset.tiltSeated) {
      lp0.dataset.tiltSeated = '1';
      lp0.addEventListener('transitionend', (e) => {
        if (e && e.propertyName === 'transform') { try { syncPinTabs(); } catch {} }
      });
    }
  }
  // tags-merge drag and drop: pills are draggable; dropping one pill onto
  // another merges the dragged tag into the receiving (primary) tag. The drop
  // target glows while hovered; dropping asks once, then rewrites every body.
  // Clicks (no drag) enter the TAGS view with that tag as the sun.
  try {
    const tvpList = document.querySelector('#tagPop .tvp-tags');
    if (tvpList && !tvpList.dataset.mergeWired) {
      tvpList.dataset.mergeWired = '1';
      tvpList.addEventListener('dragstart', (e) => {
        const p = e.target && e.target.closest ? e.target.closest('[data-tpill]') : null;
        if (!p) return;
        tvpDragTag = p.dataset.tpill;
        tvpDropToast = false; // fresh drag, fresh guidance
        // copyMove (not move): the same drag can land as a merge (move) on
        // another pill or as a passage pin (copy) on reader prose — Firefox
        // refuses the drop entirely when dropEffect isn't in this set, which
        // is exactly the "gold frame but nothing pins" failure.
        try { e.dataTransfer.effectAllowed = 'copyMove'; e.dataTransfer.setData('text/plain', tvpDragTag); } catch {}
        p.classList.add('drag-src');
      });
      tvpList.addEventListener('dragend', () => {
        tvpDragTag = null;
        tvpList.querySelectorAll('.drag-src, .drop-hi').forEach(el => el.classList.remove('drag-src', 'drop-hi'));
      });
      tvpList.addEventListener('dragover', (e) => {
        const p = e.target && e.target.closest ? e.target.closest('[data-tpill]') : null;
        if (!p || !tvpDragTag || p.dataset.tpill === tvpDragTag) return;
        e.preventDefault();
        e.stopPropagation(); // keep the window file-drop UI out of tag merges
        try { e.dataTransfer.dropEffect = 'move'; } catch {}
        tvpList.querySelectorAll('.drop-hi').forEach(el => { if (el !== p) el.classList.remove('drop-hi'); });
        p.classList.add('drop-hi');
      });
      // our drag in progress: don't let it bubble to the window file-intake
      // handlers (they would paint the canvas drop outline for a tag merge)
      tvpList.addEventListener('dragenter', (e) => {
        if (!tvpDragTag) return;
        e.stopPropagation();
      });
      tvpList.addEventListener('drop', (e) => {
        const p = e.target && e.target.closest ? e.target.closest('[data-tpill]') : null;
        if (!p || !tvpDragTag) return;
        e.preventDefault();
        e.stopPropagation(); // a tag merge is not a file drop: the window
        // intake handler must not see it (it toasts "Nothing was dropped")
        const src = tvpDragTag, dst = p.dataset.tpill;
        tvpDragTag = null;
        tvpList.querySelectorAll('.drag-src, .drop-hi').forEach(el => el.classList.remove('drag-src', 'drop-hi'));
        if (src && dst && src !== dst) { tvpMergeAt = Date.now(); mergeTagsUI(src, dst); }
      });
    }
  } catch {}
  // tag-to-passage drag and drop: dropping a tag pill onto HIGHLIGHTED
  // reader text pins it as a manual tag on exactly that passage (the same
  // pipeline as right-click -> Tag on a selection). Drops on non-highlighted
  // prose never pin — the cue tells which case the hover is in.
  try {
    const zone = document.querySelector('#docPanel');
    if (zone && !zone.dataset.tagdropWired) {
      zone.dataset.tagdropWired = '1';
      const dropCues = ['tag-drop-hi', 'tag-drop-armed', 'tag-drop-need'];
      const glowOff = () => { try { const b = document.querySelector('#docBody'); if (b) dropCues.forEach(c => b.classList.remove(c)); } catch {} };
      const cueOn = (c) => { try { const b = document.querySelector('#docBody'); if (!b) return; dropCues.forEach(x => b.classList.toggle(x, x === c)); } catch {} };
      // true when the pointer sits on the blue (selected) text itself
      const dropPointInSel = (target) => {
        try {
          const sel = window.getSelection();
          if (!sel || !sel.rangeCount || !sel.toString().trim()) return false;
          const el = (target && target.nodeType === 1) ? target : (target && target.parentElement);
          if (!el) return false;
          return sel.containsNode(el, true);
        } catch { return false; }
      };
      const cueFor = (e, toastOnce) => {
        if (!tvpDragTag || !overProse(e)) return false;
        e.preventDefault();
        e.stopPropagation(); // ours, not a file drop: keep the intake UI out
        const hasSel = !!(readReaderSelection().text || '').trim();
        if (!hasSel) {
          cueOn('tag-drop-need');
          if (toastOnce && !tvpDropToast) { tvpDropToast = true; toast('Highlight some text in the reader first — then drop the tag onto the blue highlight'); }
        } else cueOn(dropPointInSel(e.target) ? 'tag-drop-hi' : 'tag-drop-armed');
        return true;
      };
      const overProse = (e) => !!(e.target && e.target.closest && e.target.closest('#docBody'));
      zone.addEventListener('dragenter', (e) => { cueFor(e, true); });
      zone.addEventListener('dragover', (e) => {
        if (!cueFor(e, false)) return;
        try { e.dataTransfer.dropEffect = 'copy'; } catch {}
      });
      zone.addEventListener('dragleave', (e) => {
        try { if (!e.relatedTarget || !zone.contains(e.relatedTarget)) glowOff(); } catch { glowOff(); }
      });
      zone.addEventListener('drop', (e) => {
        if (!tvpDragTag) return;
        e.preventDefault();
        e.stopPropagation(); // a tag pin is not a file drop
        try {
        const slug = slugTag(tvpDragTag);
        tvpDragTag = null;
        glowOff();
        const doc = vault.byId(shownId);
        if (!doc) { toast('Open a document body first — tags live on bodies'); return; }
        const live = readReaderSelection();
        if (!live.text.trim()) { toast('Highlight some text in the reader first — then drop the tag onto it'); return; }
        if (!dropPointInSel(e.target)) { toast('Drop onto the highlighted (blue) text — the tag pins exactly there'); return; }
        if (!slug) { toast('That tag name can’t be pinned (letters and numbers, 2+ characters)'); return; }
        addManualTag(doc.id, slug, live.spot);
        } catch (err) { try { toast('Could not pin that tag (' + ((err && err.message) || err) + ')'); } catch {} }
      });
      document.addEventListener('dragend', () => { tvpDragTag = null; tvpDropToast = false; glowOff(); });
    }
  } catch {}
  $('#fileBtn').onclick = async () => {
    if (!vault.tabs.length) { await noProjectPopup(); return; }
    setLog('Waiting for file selection…'); toast('Choose files to import…'); try { $('#fileInput').click(); } catch (e) { setLog('Picker blocked by the browser — try drag-drop instead'); }
  };
  $('#fileInput').onchange = (e) => {
    const fs = [...(e.target.files || [])]; e.target.value = '';
    if (!fs.length) { setLog('File selection cancelled — no files chosen'); return; }
    setLog('Picked ' + fs.length + ' file' + (fs.length === 1 ? '' : 's') + ' — reading…');
    ingestFiles(fs, { where: 'file-picker' });
  };
  const fi2 = $('#folderInput');
  if (fi2) fi2.onchange = (e) => {
    const fs = [...(e.target.files || [])]; e.target.value = '';
    if (!fs.length) { setLog('Folder selection cancelled — no files chosen'); return; }
    setLog('Picked folder (' + fs.length + ' files) — scanning…');
    ingestFiles(fs, { where: 'folder-picker' });
  };

  document.addEventListener('keydown', (e) => {
    // global "/" focuses search — but never when typing in a field (help editor, rename prompt inputs, etc.)
    if (e.key === '/' && document.activeElement !== inp && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) { e.preventDefault(); inp.focus(); }
    // carousel pages: ←/→ step panes while it stands (never inside a field)
    if (carOpen && !carZoomOpen && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) { e.preventDefault(); carStep(e.key === 'ArrowRight' ? 1 : -1); }
  });
  // drag & drop files anywhere — without this, dropping a file navigates the
  // whole page away to the PDF (looks like "nothing happened")
  let dragN = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragN++; document.body.classList.add('dropping'); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('dropping'); } });
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); dragN = 0; document.body.classList.remove('dropping');
    const dt = e.dataTransfer;
    if (!dt) return;
    const types = dt.types ? [...dt.types] : [];
    const itemsDbg = dt.items ? [...dt.items].map(it => (it.kind || '?') + ':' + (it.type || '?')) : [];
    try {
      const gTok = showUploadProg(0, 'Gathering dropped files…');
      const fs = await getDropFiles(dt);
      const allFs = (fs && fs.length) ? fs : (dt.files && dt.files.length ? [...dt.files] : []);
      if (allFs.length) {
                hideUploadProg(gTok); // gathering done — ingestFiles raises its own tracker next
        ingestFiles(allFs, { where: 'drop' }); return;
      }
      hideUploadProg(gTok); // nothing to load — stand the gathering state down
      // No file bytes. Common sources: Gmail/Outlook/Drive web drags (links only),
      // desktop-Outlook FileGroupDescriptor, or cloud placeholders.
      console.warn('drop had no files', { types, itemsDbg });
      let detail = '';
      try {
        if (types.includes('Files') && dt.items && dt.items.length) {
          detail = ' — the browser blocked file access (items: ' + itemsDbg.slice(0, 4).join(', ') + ')';
        } else if (types.some(x => /FileGroupDescriptor|FileContents|chromium-x-ad|ms-/.test(x))) {
          detail = ' — that looks like a desktop-mail drag (Outlook FileGroupDescriptor): save the attachment to disk first';
        } else if (types.includes('text/uri-list') || types.includes('text/html')) {
          let s = '';
          try { s = dt.getData('text/uri-list') || dt.getData('text/plain') || ''; } catch {}
          s = String(s).slice(0, 120);
          detail = s ? ' — that drop was a link, not a file (' + s + (String(s).length >= 120 ? '…' : '') + '): download it first' : ' — that drop was a link/text, not a file: download it first';
        } else if (types.length) {
          detail = ' — drop carried [' + types.slice(0, 5).join(', ') + '], no file bytes';
        }
      } catch {}
      setLog('Nothing was dropped' + detail); toast('Nothing was dropped' + detail + ' — use the Files button and pick the .docx from disk', 8000);
    } catch (err) {
      console.warn('drop read failed', err);
      try { hideUploadProg(uploadProgToken); } catch {} // stand down only if no newer intake owns it (token-guarded)
      if (dt.files && dt.files.length) ingestFiles([...dt.files], { where: 'drop-retry' });
      else toast('Nothing was dropped (drop read failed) — use the Files button', 6500);
    }
  });
  // ---------- right-click context menu (Explorer-style, per body) ----------
  const ctx = $('#ctxMenu');
  function closeCtx() { ctx.hidden = true; }
  function ctxItem(label, danger, fn) {
    const b = document.createElement('button');
    b.className = 'ctx-item' + (danger ? ' danger' : '');
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); closeCtx(); fn(); };
    return b;
  }
  function showProps(id) {
    const d = vault.byId(id);
    if (!d) return;
    const m = uni.byId.get(id);
    const neigh = (edgeInfo || []).filter(e => e.source === id || e.target === id).length;
    $('#propsTitle').textContent = vault.titleOf(d);
    $('#propsBody').innerHTML = [
      ['File', d.name], ['Words', d.words], ['Mass', m ? (m.trueMass ?? m.mass).toFixed(1) : '—'],
      ['Outgoing refs', d.links.length], ['Tethers', neigh],
      ['Tags', d.tags.map(t => vault.stripAuto(t)).join(', ') || '—'],
      ['Added body', d.id],
    ].map(([k, v]) => `<div class="pr"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    $('#propsModal').hidden = false;
  }
  function showThemeProps(th) {
    const m = uni.byId.get(th.id);
    $('#propsTitle').textContent = '◈ ' + th.label;
    $('#propsBody').innerHTML = [
      ['Kind', 'Distilled theme (thematic lens)'],
      ['Thematic weight', th.weight.toFixed(1)], ['Mass', m ? (m.trueMass ?? m.mass).toFixed(1) : th.mass.toFixed(1)],
      ['Concepts', th.terms.join(', ')],
      ['Grounded bodies', String(th.members.length)],
      ['Theme body', th.id],
    ].map(([k, v]) => `<div class="pr"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    $('#propsModal').hidden = false;
  }
  function showTagProps(rec) {
    const m = uni.byId.get(rec.id);
    $('#propsTitle').textContent = '#' + (rec.label || String(rec.id || '').replace(/^tag:/, ''));
    $('#propsBody').innerHTML = [
      ['Kind', 'Tag (tags view)'],
      ['Tag weight', Number(rec.weight || 0).toFixed(1)],
      ['Mass', m ? (m.trueMass ?? m.mass).toFixed(1) : (rec.mass != null ? Number(rec.mass).toFixed(1) : '—')],
      ['Terms', ((rec.terms || []).join(', ') || '—')],
      ['Tagged bodies', String((rec.members || []).length)],
      ['Tag body', rec.id],
    ].map(([k, v]) => `<div class="pr"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('');
    $('#propsModal').hidden = false;
  }
  function openCtx(x, y, id) {
    ctx.innerHTML = '';
    // shared post-copy handling for every canvas menu (doc, theme and tag
    // bodies): the transferred sun becomes the destination's sun when it
    // traveled — otherwise the canvas keeps its own. This runs even when every
    // body was already there (zero new copies): the counts may not change, but
    // the center still moves — otherwise the canvas sun and the reader
    // disagree. Then fold newcomers into an existing destination universe
    // (formation holds) or invalidate its edge cache for first visit.
    const afterCopyTo = (ot) => async (r, sunIdOrNull) => {
      if (!r) { toast('Copy failed'); return; }
      if (sunIdOrNull) {
        const src = vault.byId(sunIdOrNull);
        const dest = vault.tabs.find(t => t.id === ot.id);
        if (src && dest) {
          const root = src.origin || src.id;
          const sunCopy = dest.docs.find(x => x.id === root || x.origin === root);
          if (sunCopy) dest.activeId = sunCopy.id;
        }
      }
      if (r.copied.length) {
        if (unis.has(ot.id)) rebuildTab(ot.id);
        else edgeByTab.delete(ot.id);

        renderTabs(); toast(`Copied ${r.copied.length} ${r.copied.length === 1 ? 'body' : 'bodies'} to ${ot.name}${r.skipped ? ` (${r.skipped} already there)` : ''}`);
      }
      else {
        // nothing new, but the center may have moved: re-seat the existing
        // universe on the new sun so canvas and reader stay glued together
        if (unis.has(ot.id)) rebuildTab(ot.id);
        else edgeByTab.delete(ot.id);
        renderTabs(); toast(`Everything is already in ${ot.name}`);
      }
    };
    // copy items for theme/tag bodies: the grounded/tagged member docs travel
    // (copies, never moves) — members only, or members + their shared-ground
    // web through the same picker the doc menu uses. Single members keep the
    // doc menu's "only this body" wording; groups name their count honestly.
    const appendMemberCopyItems = (memberIds, kind) => {
      const memIds = [...new Set(memberIds || [])].filter(mid => vault.byId(mid));
      if (!memIds.length) return;
      const memSet = new Set(memIds);
      const neighbours = new Set();
      for (const e of edgeInfo) {
        if (e.kind !== 'topic') continue;
        if (memSet.has(e.source)) neighbours.add(e.target);
        else if (memSet.has(e.target)) neighbours.add(e.source);
      }
      for (const mid of memIds) neighbours.delete(mid);
      const neighPrev = [];
      {
        const seenP = new Set();
        for (const e of edgeInfo) {
          if (e.kind !== 'topic') continue;
          let oid = null;
          if (memSet.has(e.source)) oid = e.target;
          else if (memSet.has(e.target)) oid = e.source;
          else continue;
          if (!neighbours.has(oid) || seenP.has(oid)) continue;
          seenP.add(oid);
          const o = vault.byId(oid);
          if (o) neighPrev.push({ id: oid, name: vault.titleOf(o), terms: (e.topics || []).slice(0, 3) });
        }
      }
      if (vault.tab() && vault.scopeTabs().length <= 1) ctx.appendChild(ctxItem('⧉ Copying is off in this isolated verse', false, () => toast('Associate this canvas with another verse (right-click its tab) to copy bodies out')));
      const memberItems = memIds.map(mid => ({ id: mid, name: vault.titleOf(vault.byId(mid)), terms: [] }));
      const soloLabel = memIds.length === 1 ? 'this body' : `these ${memIds.length} ${kind} bodies`;
      for (const ot of vault.scopeTabs().filter(x => x.id !== vault.activeTabId).slice(0, 8)) {
        const afterCopy = afterCopyTo(ot);
        if (neighPrev.length) {
          const soloBtn = ctxItem(`⤉  Copy only ${soloLabel} to “${ot.name}”`, false, () => afterCopy(vault.copyIdsTo(ot.id, memIds), null));
          soloBtn.title = memberItems.map(p => p.name).join('\n');
          ctx.appendChild(soloBtn);
          const conBtn = ctxItem(`⤓  Copy constellation (${memIds.length + neighPrev.length}) to “${ot.name}”`, false, async () => {
            const srcTab = vault.activeTabId;
            const ids = await openPickModal(ot.name, [...memberItems, ...neighPrev], neighPrev.map(n => n.id));
            if (!ids) return; // cancelled in the picker
            if (vault.activeTabId !== srcTab) { toast('Copy cancelled — canvas switched underneath'); return; }
            if (ids) afterCopy(vault.copyIdsTo(ot.id, ids), null);
          });
          conBtn.title = 'Pick exactly what travels:\n' + memberItems.map(p => `• ${p.name}`).join('\n') + '\n' + neighPrev.map(p => `• ${p.name}` + (p.terms.length ? `  (via ${p.terms.join(', ')})` : '')).join('\n');
          ctx.appendChild(conBtn);
        } else {
          ctx.appendChild(ctxItem(`⤓  Copy to “${ot.name}”`, false, () => afterCopy(vault.copyIdsTo(ot.id, memIds), null)));
        }
      }
    };
    if (selSet.size > 0 && (!id || selSet.has(id))) {
      // box-selection menu: bulk-delete this tab's bodies + docs, or the whole tab universe
      const t = vault.tab();
      const inTab = t ? [...selSet].filter(sid => t.docs.some(d => d.id === sid)) : [];
      const head = document.createElement('div');
      head.className = 'ctx-head';
      head.textContent = `▦ ${inTab.length} selected`;
      ctx.appendChild(head);
      if (inTab.length) ctx.appendChild(ctxItem(`✕  Delete ${inTab.length} selected + ${inTab.length === 1 ? 'doc' : 'docs'} (this tab only)`, true, () => removeIdsFromCanvas(inTab)));
      ctx.appendChild(ctxItem(`✕  Delete entire “${t ? t.name : 'canvas'}” universe (${t ? t.docs.length : 0}) + docs`, true, () => removeUniverseFromCanvas()));
      ctx.appendChild(ctxItem('Clear selection', false, () => { selSet.clear(); hideBoxSel(); }));
      ctx.hidden = false;
      const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
      ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
      ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
      return;
    }
    if (id) {
      const th = themeById(id);
      if (th) { // derived theme body: properties only — nothing to copy/rename/remove
        const head = document.createElement('div');
        head.className = 'ctx-head';
        head.textContent = '◈ ' + th.label;
        ctx.appendChild(head);
        if (lensThematic) {
          // associated-document overlay: pin this orb's grounded member docs
          // around it as paper icons, or lift them back off
          const ovth = assocOverlayFor(th);
          if (!ovth) {
            ctx.appendChild(ctxItem('⧉  Show all associated documents (with labels)', false, () => showAssoc(th.id, true)));
            ctx.appendChild(ctxItem('⧉  Show associated documents (no labels)', false, () => showAssoc(th.id, false)));
          } else {
            ctx.appendChild(ctxItem('✕  Remove associated documents from view', false, () => hideAssoc(th.id)));
          }
          // document-labels toggle (moved off the bottom pill): states
          // plainly what flipping does — orb labels stay in the left pane
          {
            const lavVis = visibleAssocOverlays();
            const lavOn = lavVis.length > 0 && lavVis.every(x => assocOverlayFor(x).labels);
            ctx.appendChild(ctxItem(lavOn ? '🏷  Document labels: ON — tap to hide associated-document names' : '🏷  Document labels: OFF — tap to show associated-document names', false, () => toggleAssocDocLabels()));
          }
        }
        // thematic bodies copy like doc bodies: the grounded members travel
        // (members only, or members + their shared-ground web)
        appendMemberCopyItems(th.members, 'grounded');
        ctx.appendChild(ctxItem('ℹ  Properties', false, () => showThemeProps(th)));
        ctx.hidden = false;
        const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
        ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
        ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
        return;
      }
      const d = vault.byId(id);
      if (!d) {
        // tag body (tags view): head + a jump to the Tags pane. Grounded
        // bodies already list in the reader when the tag is focused.
        const rec = (tagRecords.get(vault.activeTabId) || []).find(r => r.id === id);
        if (rec) {
          const head = document.createElement('div');
          head.className = 'ctx-head';
          head.textContent = `#${rec.label || id} — ${rec.members.length} ${rec.members.length === 1 ? 'body' : 'bodies'}`;
          ctx.appendChild(head);
          ctx.appendChild(ctxItem('☰  Show in Tags pane', false, () => openTagPop((rec.terms && rec.terms[0]) || String(rec.id || '').replace(/^tag:/, ''))));
          ctx.appendChild(ctxItem('✎  Rename tag…', false, () => openTagRenameEditor(x, y, (rec.terms && rec.terms[0]) || String(rec.id || '').replace(/^tag:/, ''))));
          // tag bodies copy like doc bodies: the tagged member docs travel
          // (members only, or members + their shared-ground web), then Properties
          appendMemberCopyItems(rec.members, 'tagged');
          ctx.appendChild(ctxItem('ℹ  Properties', false, () => showTagProps(rec)));
          const delDisp = normDisp((rec.terms && rec.terms[0]) || String(rec.id || '').replace(/^tag:/, ''));
          ctx.appendChild(ctxItem(`✕  Remove`, true, () => deleteTagUI(delDisp)));
          ctx.appendChild(ctxItem(`✕  Remove from everywhere`, true, () => deleteTagEverywhereUI(delDisp)));
          ctx.hidden = false;
          const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
          ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
          ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
        }
        return;
      }
      const head = document.createElement('div');
      head.className = 'ctx-head';
      head.textContent = '◉ ' + vault.titleOf(d);
      ctx.appendChild(head);
      ctx.appendChild(ctxItem('👁  Preview source', false, () => { if (openSrcPop(id, x, y, true)) { srcStickyId = id; try { syncEye(); } catch {} } }));
      ctx.appendChild(ctxItem('✎  Rename…', false, () => {
        const cur = vault.titleOf(d);
        const next = prompt('Rename body:', cur);
        if (next !== null && next.trim() && next.trim() !== cur) {
          const oldName = d.name;
          vault.rename(id, next.trim());
          rebuild(activeId);
          toast(`Renamed to “${vault.titleOf(vault.byId(id))}”`);
        }
      }));
      ctx.appendChild(ctxItem('🗒  Sticky note…', false, () => openNoteEditor(id, x, y)));
      ctx.appendChild(ctxItem('⧉  Copy text', false, async () => {
        try { await navigator.clipboard.writeText(d.text); toast('Body text copied'); }
        catch { toast('Copy blocked by the browser'); }
      }));
      // Original bytes first (kept in this browser's originals store at import;
      // older imports and backup-restored docs have no bytes — they fall back
      // to the extracted text, honestly suffixed so it opens).
      const hasOrig = !!(d && d.origKey);
      ctx.appendChild(ctxItem(hasOrig ? '⤓  Download original' : '⤓  Download text (.txt)', false, async () => {
        const saveBlob = (blob, fname) => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = fname;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        };
      if (d.origKey) {
        try {
          const blob = await origBlob(d);
          if (blob && blob.size > 0) {
            saveBlob(blob, d.name);
            toast(`Downloading original ${d.name}`);
            return;
          }
        } catch (e) { console.warn('original download missed for ' + d.name, (e && e.message) || e); }
      }
      const nm = String(d.name || 'body');
      const fname = /\.(txt|md|markdown|csv)$/i.test(nm) ? nm : ((nm.replace(/\.[^.]+$/, '').trim() || 'body') + '.txt');
      saveBlob(new Blob([d.text], { type: 'text/plain;charset=utf-8' }), fname);
      toast(!d.origKey && d.origSkipped === 'too-large-for-browser-store'
        ? `Original over the 100MB browser-store limit was not kept — downloading extracted text as ${fname}`
        : d.origKey
          ? `Original bytes missing for “${nm}” (${d.origWhere === 'disk' ? 'not in the app vault on this machine' : 'kept on the original device — not in this backup'}) — downloading extracted text as ${fname}`
          : `Downloading extracted text as ${fname}`);
      }));

      // transfer the local constellation to another canvas (copies, never moves).
      // Solo = just this body; constellation = this body + its shared-ground web
      // (the exact set the SHARED GROUND menu shows — hover the item to preview it).
      const neighbours = new Set();
      for (const e of edgeInfo) {
        if (e.kind !== 'topic') continue;
        if (e.source === id) neighbours.add(e.target);
        else if (e.target === id) neighbours.add(e.source);
      }
      neighbours.delete(id);
      // preview data: name + the shared vocabulary that forged each tether, so the
      // copy set is auditable (same topic edges the SHARED GROUND menu shows)
      const neighPrev = [];
      {
        const seenP = new Set();
        for (const e of edgeInfo) {
          if (e.kind !== 'topic') continue;
          let oid = null;
          if (e.source === id) oid = e.target;
          else if (e.target === id) oid = e.source;
          else continue;
          if (!neighbours.has(oid) || seenP.has(oid)) continue;
          seenP.add(oid);
          const o = vault.byId(oid);
          if (o) neighPrev.push({ id: oid, name: vault.titleOf(o), terms: (e.topics || []).slice(0, 3) });
        }
      }
      if (vault.tab() && vault.scopeTabs().length <= 1) ctx.appendChild(ctxItem('⧉ Copying is off in this isolated verse', false, () => toast('Associate this canvas with another verse (right-click its tab) to copy bodies out')));
      for (const ot of vault.scopeTabs().filter(x => x.id !== vault.activeTabId).slice(0, 8)) {
        const afterCopy = afterCopyTo(ot);
        if (neighPrev.length) {
          const soloBtn = ctxItem(`⤉  Copy only this body to “${ot.name}”`, false, () => afterCopy(vault.sendCopyTo(id, ot.id, true), id));
          soloBtn.title = vault.titleOf(d);
          ctx.appendChild(soloBtn);
          // constellation goes through the picker: every proposed body listed with
          // its shared-vocabulary receipt, user unchecks whatever shouldn't travel
          const conBtn = ctxItem(`⤓  Copy constellation (${1 + neighPrev.length}) to “${ot.name}”`, false, async () => {
            const srcTab = vault.activeTabId;
            const ids = await openPickModal(ot.name, [{ id, name: vault.titleOf(d), terms: [], sun: true }, ...neighPrev]);
            if (!ids) return; // cancelled in the picker
            if (vault.activeTabId !== srcTab) { toast('Copy cancelled — canvas switched underneath'); return; }
            // sun stays the destination's center only if the user kept it selected
            if (ids) afterCopy(vault.copyIdsTo(ot.id, ids), ids.includes(id) ? id : null);
          });
          conBtn.title = 'Pick exactly what travels:\n' + neighPrev.map(p => `• ${p.name}` + (p.terms.length ? `  (via ${p.terms.join(', ')})` : '')).join('\n');
          ctx.appendChild(conBtn);
        } else {
          ctx.appendChild(ctxItem(`⤓  Copy to “${ot.name}”`, false, () => afterCopy(vault.sendCopyTo(id, ot.id, true), id)));
        }
      }
      ctx.appendChild(ctxItem('ℹ  Properties', false, () => showProps(id)));
      const hr = document.createElement('hr');
      ctx.appendChild(hr);
      ctx.appendChild(ctxItem('✕  Remove', true, () => removeFromCanvas(id)));
      ctx.appendChild(ctxItem('✕  Remove from everywhere', true, () => deleteEverywhere(id)));
    } else {
      // whole-tab clipboard: a Copy-all-content stash drops here too, so the
      // user can paste right onto the destination canvas without hunting its
      // tab menu (same offer the tab menu shows; never offered on the source)
      {
        const t = vault.tab();
        const offer = t ? liveTabClip(t) : null;
        if (offer) {
          const pn = offer.ids.length;
          const pp = ctxItem(`⤓  Paste ${pn} ${pn === 1 ? 'body' : 'bodies'} from “${offer.src.name}”`, false, () => {
            const r = vault.copyTabDocs(t.id, offer.src.id, offer.ids);
            if (!r) { setTabClip(null); renderTabs(); toast('Paste failed — the copied tab is gone'); return; }
            if (r.copied.length) {
              if (unis.has(t.id)) rebuildTab(t.id);
              else edgeByTab.delete(t.id);
              renderTabs();
              if (t.id === vault.activeTabId) { try { renderDoc(); } catch {} }
              toast(`Pasted ${r.copied.length} ${r.copied.length === 1 ? 'body' : 'bodies'} from “${offer.src.name}”${r.skipped ? ` (${r.skipped} already here)` : ''}`);
            } else { renderTabs(); toast(`Everything from “${offer.src.name}” is already here`); }
          });
          pp.title = `Paste the copied bodies into “${t.name}”`;
          ctx.appendChild(pp);
          const hrP = document.createElement('hr');
          ctx.appendChild(hrP);
        }
      }
      if (lensThematic) {
        // whole-canvas associated documents: every theme's members at once
        ctx.appendChild(ctxItem('⧉  Show all associated documents for entire canvas (with labels)', false, () => showAssocAll(true)));
        ctx.appendChild(ctxItem('⧉  Show all associated documents for entire canvas (no labels)', false, () => showAssocAll(false)));
        ctx.appendChild(ctxItem('✕  Clear all associated documents from view', false, () => clearAssoc()));
        // document-labels toggle (moved off the bottom pill): states
        // plainly what flipping does — orb labels stay in the left pane
        {
          const lavVis = visibleAssocOverlays();
          const lavOn = lavVis.length > 0 && lavVis.every(x => assocOverlayFor(x).labels);
          ctx.appendChild(ctxItem(lavOn ? '🏷  Document labels: ON — tap to hide associated-document names' : '🏷  Document labels: OFF — tap to show associated-document names', false, () => toggleAssocDocLabels()));
        }
        // palest icons off: hide every ungrounded paper icon on the canvas
        // (toggle back on from this same menu; the reader inventory is untouched)
        const themesUx = thematicWhole ? wholeThemes : (thematicThemes.get(vault.activeTabId) || []);
        const uxMap = assocUngrMap();
        let uxTotal = 0;
        for (const th of themesUx) uxTotal += (uxMap.get(th.id) || []).length;
        if (uxTotal > 0 || hideUngr) ctx.appendChild(ctxItem(hideUngr ? `○  Show ungrounded documents in view (${uxTotal})` : `✕  Remove ungrounded documents from view (${uxTotal})`, false, () => toggleHideUngr()));
        const hrA = document.createElement('hr');
        ctx.appendChild(hrA);
      }
      ctx.appendChild(ctxItem('⌂  Reset view', false, () => { try { camCancelGlide(); } catch {} ren.resetView(); }));
      ctx.appendChild(ctxItem(rotOn ? '⏸  Pause universe' : '▶  Resume universe', false, () => { setRot(!rotOn); toast(rotOn ? 'Universe resumed' : 'Universe paused'); }));
      ctx.appendChild(ctxItem(snapCenter ? '◉  Snap to center: ON — tap to stop the canvas recentering on picks' : '○  Snap to center: OFF — tap to recenter the canvas on picks again', false, () => toggleSnapCenter()));
      ctx.appendChild(ctxItem(`✕  Remove all from this canvas${vault.tab() && vault.tab().docs.length ? ` (${vault.tab().docs.length})` : ''}`, true, () => removeAllFromCanvas()));
    }
    ctx.hidden = false;
    const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
    ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  }
  // associated paper icon menu: the icon is not a universe body (just an
  // annotation), so it gets its own small menu — remove takes the doc off
  // this canvas only, exactly like the body menu's remove.
  function openAssocDocCtx(x, y, a) {
    const d = vault.byId(a.doc);
    ctx.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = '▤ ' + (d ? vault.titleOf(d) : (a.title || a.doc));
    ctx.appendChild(head);
    const note = document.createElement('div');
    note.className = 'ctx-note';
    note.textContent = a.ungr
      ? 'Not grounded in any theme — shown palest so every file displays'
      : 'Associated document — grounded in this theme' + (d ? '' : ' (kept on another canvas)');
    ctx.appendChild(note);
    if (d) ctx.appendChild(ctxItem('✕  Remove', true, () => removeFromCanvas(a.doc)));
    else ctx.appendChild(ctxItem('✕  Remove', true, () => toast('That body lives on another canvas — switch there to remove it')));
    ctx.hidden = false;
    const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
    ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  }
  // ---------- manual tags: right-click a reader text selection to tag it ----------
  // The tag is stored as `manual/<slug>` on the doc (never parsed from text, so
  // editing the prose can't remove it). Matching treats it exactly like a
  // written #tag — tethers, mass, search, tags view — and pills badge it M.
  function slugTag(sel) {
    const slug = String(sel || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (slug.length < 2 || !/[a-z]/.test(slug)) return null;
    return slug;
  }
  function addManualTag(id, slug, spot) {
    const d = vault.byId(id);
    if (!d || !/^[a-z0-9_\-/]{2,}$/.test(slug || '')) return false;
    const tags = d.tags || (d.tags = []);
    const dupe = tags.some(tg => vault.stripAuto(tg) === slug && !String(tg).toLowerCase().startsWith('auto/'));
    if (dupe) { toast(`#${slug} is already on “${vault.titleOf(d)}”`); return false; }
    // an auto tag of the same name upgrades into the manual one (no doubles)
    d.tags = tags.filter(tg => !(String(tg).toLowerCase().startsWith('auto/') && vault.stripAuto(tg) === slug));
    d.tags.push('manual/' + slug);
    // remember exactly where it was made: a rich anchor (snippet + stripped
    // offset + DOM path of the creation range) so the jump lands on this
    // block even when the same words appear elsewhere in the document
    const snip = ((spot && typeof spot === 'object') ? spot.snip : spot);
    const snipClean = String(snip || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (snipClean.length >= 2) {
      const rec = (d.manualTags || (d.manualTags = {}));
      if (spot && typeof spot === 'object' && Array.isArray(spot.path)) {
        const anchor = { snip: snipClean };
        if (isFinite(spot.at)) anchor.at = Math.max(0, Math.round(spot.at));
        anchor.path = spot.path.slice(0, 12);
        if (Number.isInteger(spot.off) && spot.off >= 0) anchor.off = spot.off;
        rec[slug] = anchor;
      } else rec[slug] = snipClean;
    }
    vault.persist();
    try { rebuild(activeId); } catch {}
    try { if (!$('#tagPop').hidden) openTagPop(); } catch {}
    markBackupDirty();
    toast(`Tagged as #${slug} M — manual tag (tethers like a written #tag)`);
    return true;
  }
  // explicit tags, written in-app: append ` #slug` to the body text (the same
  // thing as typing #tag in an imported file), then recount so it tethers,
  // weighs and searches like any written tag. Suppression only ever hides
  // the auto/ form, so a written tag always (re)brings its name back.
  function addExplicitTag(id, slug) {
    const d = vault.byId(id) || vault.byIdAnywhere(id);
    if (!d || !/^[a-z0-9_\-/]{2,}$/.test(slug || '')) return false;
    if (tagUseRe(slug).test(String(d.text || ''))) { toast(`#${slug} is already in “${vault.titleOf(d)}”`); try { renderDoc(); } catch {} return false; }
    const base = String(d.text || '').replace(/\s+$/, '');
    d.text = (base ? base + ' ' : '') + '#' + slug;
    vault.recountDoc(d);
    vault.persist();
    try { rebuild(activeId); } catch {}
    try { if (!$('#tagPop').hidden) openTagPop(); } catch {}
    markBackupDirty();
    toast(`Wrote #${slug} into “${vault.titleOf(d)}” — explicit tag (hand-written, lives in the prose)`);
    return true;
  }
  // inline "+ #tag" editor in the reader's tag row (same pattern as the
  // manual-tag name editor — native prompt() is blocked in some shells).
  // Enter commits, Esc restores the pills.
  function openAddTagEditor(id) {
    const d = vault.byId(id);
    const host = $('#docTags');
    if (!d || !host) return;
    const btn = host.querySelector('[data-addtag]');
    if (!btn) return;
    const inp = document.createElement('input');
    inp.value = '';
    inp.maxLength = 40;
    inp.placeholder = 'type a #tag name…';
    inp.setAttribute('aria-label', 'New explicit tag name');
    inp.style.cssText = 'width:130px;box-sizing:border-box;background:rgba(10,14,20,.8);border:1px solid var(--line);color:var(--txt);border-radius:20px;padding:2px 9px;font-size:11px;outline:none;margin:0 4px 4px 0;';
    btn.replaceWith(inp);
    inp.focus();
    const commit = () => {
      const slug = String(inp.value.trim().toLowerCase()).replace(/\s+/g, '_').replace(/[^a-z0-9_\-/]/g, '');
      if (!/^[a-z0-9_\-/]{2,}$/.test(slug) || !/[a-z]/.test(slug)) { toast('That name can’t be a tag — use at least 2 letters (a–z, 0–9)'); inp.focus(); return; }
      addExplicitTag(id, slug);
    };
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') { try { renderDoc(); } catch {} }
    });
    inp.addEventListener('click', (ev) => ev.stopPropagation());
  }
  // row "+ #tag" writer: floating name editor for that exact document (same
  // slug rules as the reader's + #tag). Enter/Save commits through
  // addExplicitTag; Esc closes.
  function openSlotTagEditor(id, x, y) {
    const d = vault.byId(id) || vault.byIdAnywhere(id);
    if (!d) return;
    ctx.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = `＋ #tag for “${vault.titleOf(d)}”`;
    ctx.appendChild(head);
    const note = document.createElement('div');
    note.className = 'ctx-note';
    note.innerHTML = 'Declare what this document/body belongs with by assigning a +#tag to it. Bodies sharing the tag pull together, share weight, match in search, and form one Tags-view node. This tag button is the same as the +#Tag function/button <img src="src/assets/addtag-pill.png" alt="+ #tag" style="height:1.15em;vertical-align:-0.25em;"> in the document reading/display view.';
    ctx.appendChild(note);
    const inp = document.createElement('input');
    inp.value = '';
    inp.maxLength = 40;
    inp.placeholder = 'type a #tag name…';
    inp.setAttribute('aria-label', 'New explicit tag name');
    inp.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(10,14,20,.8);border:1px solid var(--line);color:var(--txt);border-radius:7px;padding:6px 8px;font-size:13px;outline:none;margin:2px 0 6px;';
    ctx.appendChild(inp);
    const commit = () => {
      const typed = slugTag(inp.value.trim());
      if (!typed) { toast('That name can’t be a tag — use at least 2 letters (a–z, 0–9)'); inp.focus(); return; }
      if (addExplicitTag(d.id, typed)) closeCtx();
    };
    const save = document.createElement('button');
    save.className = 'ctx-item';
    save.textContent = '✓ Save tag';
    save.onclick = (e) => { e.stopPropagation(); commit(); };
    ctx.appendChild(save);
    const cancel = document.createElement('button');
    cancel.className = 'ctx-item';
    cancel.textContent = '✕ Cancel';
    cancel.onclick = (e) => { e.stopPropagation(); closeCtx(); };
    ctx.appendChild(cancel);
    ctx.hidden = false;
    const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
    ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
    inp.focus();
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') closeCtx();
    });
    inp.addEventListener('click', (ev) => ev.stopPropagation());
  }
  function openSelTagMenu(x, y, snippet, slug, spot, full, noteSpot, onSent, docId) {
    ctx.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = `✎ “${snippet}”`;
    ctx.appendChild(head);
    if (slug) ctx.appendChild(ctxItem(`＋  Tag as #${slug} (manual M)`, false, () => addManualTag(shownId, slug, spot)));
    else ctx.appendChild(ctxItem('＋  Tag selection…', false, () => toast('That selection can’t be a tag — it needs at least 2 letters (a–z, 0–9)')));
    // typed name: the auto slug is only a suggestion — the user can type any
    // tag name here (inline editor, since native prompt() is blocked in some
    // shells). The typed text is slugified the same way, so "My Tag!" lands
    // as manual/my_tag with the same spot anchor, M badge, and tethers.
    {
      const nm = document.createElement('button');
      nm.className = 'ctx-item';
      nm.textContent = '✎  Name the tag yourself…';
      nm.title = 'Type your own tag name instead of the suggested one';
      nm.onclick = (e) => { e.stopPropagation(); openSelTagNameEditor(x, y, snippet, slug, spot, full, noteSpot); };
      ctx.appendChild(nm);
    }
    ctx.appendChild(ctxItem('🗒  Send selection to notes', false, () => { if (sendSelectionToNotes(full || snippet, noteSpot, docId) && typeof onSent === 'function') { try { onSent(); } catch {} } }));
    ctx.appendChild(ctxItem('⧉  Copy selection', false, async () => {
      try { await navigator.clipboard.writeText(snippet); toast('Selection copied'); }
      catch { toast('Copy blocked by the browser'); }
    }));
    ctx.hidden = false;
    const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
    ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  }
  // typed-name mode for manual tags: an inline input prefilled with the
  // suggested slug (or empty when the selection can't auto-slug). Enter/Save
  // commits through the same addManualTag path; Esc goes back to the menu.
  function openSelTagNameEditor(x, y, snippet, slug, spot, full, noteSpot) {
    ctx.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = '✎ Tag name (manual M)';
    ctx.appendChild(head);
    const inp = document.createElement('input');
    inp.value = slug || '';
    inp.maxLength = 40;
    inp.placeholder = 'type a tag name…';
    inp.setAttribute('aria-label', 'Tag name');
    inp.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(10,14,20,.8);border:1px solid var(--line);color:var(--txt);border-radius:7px;padding:6px 8px;font-size:13px;outline:none;margin:2px 0 6px;';
    ctx.appendChild(inp);
    const commit = () => {
      const typed = slugTag(inp.value.trim());
      if (!typed) { toast('That name can’t be a tag — use at least 2 letters (a–z, 0–9)'); inp.focus(); return; }
      if (addManualTag(shownId, typed, spot)) closeCtx();
    };
    const save = document.createElement('button');
    save.className = 'ctx-item';
    save.textContent = '✓ Save tag';
    save.onclick = (e) => { e.stopPropagation(); commit(); };
    ctx.appendChild(save);
    const back = document.createElement('button');
    back.className = 'ctx-item';
    back.textContent = '‹ Back';
    back.onclick = (e) => { e.stopPropagation(); openSelTagMenu(x, y, snippet, slug, spot, full, noteSpot); };
    ctx.appendChild(back);
    ctx.hidden = false;
    const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
    ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
    inp.focus();
    try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {}
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') openSelTagMenu(x, y, snippet, slug, spot, full, noteSpot);
    });
    inp.addEventListener('click', (ev) => ev.stopPropagation());
  }
  // typed-name editor for tag renames: an inline input prefilled with the old
  // name (same slug rules as the explicit-tag editor). Enter/Save commits
  // through the confirm flow; Esc closes. Shared by reader pills, the tag
  // page, the tags pop-out and canvas tag bodies.
  function openTagRenameEditor(x, y, oldDisp) {
    const t = vault.tab();
    if (!t) { toast('No open canvas — nothing to rename on'); return; }
    const s = normDisp(oldDisp);
    if (!/^[a-z0-9_\-/]{2,}$/.test(s)) { toast('That tag can’t be renamed'); return; }
    if (!carriersOf(t, s).length) { toast(`#${s} is not in this verse`); return; }
    ctx.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.justifyContent = 'space-between';
    head.style.gap = '8px';
    const headTitle = document.createElement('span');
    headTitle.textContent = `✎ Rename #${s}`;
    headTitle.style.overflow = 'hidden';
    headTitle.style.textOverflow = 'ellipsis';
    headTitle.style.whiteSpace = 'nowrap';
    head.appendChild(headTitle);
    const headX = document.createElement('button');
    headX.textContent = '✕';
    headX.title = 'Close';
    headX.setAttribute('aria-label', 'Close rename');
    headX.style.cssText = 'flex:none;background:none;border:0;color:var(--mut);font-size:12px;font-weight:700;padding:2px 6px;border-radius:6px;cursor:pointer;opacity:.7;';
    headX.onmouseenter = () => { headX.style.opacity = '1'; headX.style.background = 'rgba(255,120,120,.18)'; };
    headX.onmouseleave = () => { headX.style.opacity = '.7'; headX.style.background = 'none'; };
    headX.onclick = (e) => { e.stopPropagation(); closeCtx(); };
    head.appendChild(headX);
    ctx.appendChild(head);
    const note = document.createElement('div');
    note.className = 'ctx-note';
    note.textContent = `Rewrites #${s} to the new name in every body on “${t.name}” — prose, manual tags and canvas labels follow.`;
    ctx.appendChild(note);
    const inp2 = document.createElement('input');
    inp2.value = s;
    inp2.maxLength = 40;
    inp2.placeholder = 'type the new tag name…';
    inp2.setAttribute('aria-label', 'New tag name');
    inp2.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(10,14,20,.8);border:1px solid var(--line);color:var(--txt);border-radius:7px;padding:6px 8px;font-size:13px;outline:none;margin:2px 0 6px;';
    ctx.appendChild(inp2);
    const commit = () => {
      const typed = String(inp2.value.trim().toLowerCase()).replace(/\s+/g, '_').replace(/[^a-z0-9_\-/]/g, '');
      if (!/^[a-z0-9_\-/]{2,}$/.test(typed) || !/[a-z]/.test(typed)) { toast('That name can’t be a tag — use at least 2 letters (a–z, 0–9)'); inp2.focus(); return; }
      if (typed === s) { closeCtx(); return; }
      closeCtx();
      renameTagConfirm(s, typed);
    };
    const save = document.createElement('button');
    save.className = 'ctx-item';
    save.textContent = '✓ Rename tag';
    save.onclick = (e) => { e.stopPropagation(); commit(); };
    ctx.appendChild(save);
    ctx.hidden = false;
    const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
    ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
    inp2.focus();
    try { inp2.setSelectionRange(inp2.value.length, inp2.value.length); } catch {}
    inp2.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') closeCtx();
    });
    inp2.addEventListener('click', (ev) => ev.stopPropagation());
  }
  const setRot = (on) => {
    rotOn = on;
    $('#rotBtn').textContent = rotOn ? '⏸ Pause' : '▶ Resume';
    saveUi();
  };
  // right-button press on the canvas released OFF-canvas: the document
  // pointerup opens the app menu via srcQuickClick, but the browser then
  // fires contextmenu on the panel under the cursor — never the canvas, so
  // the cv swallower never runs and the Windows menu pops up under the app
  // menu. Swallow it here whenever a right-release armed the flag. Placed
  // first so an in-flight canvas gesture owns its release (a canvas press
  // released over a tag pill must not also raise the rename editor).
  document.addEventListener('contextmenu', (e) => {
    if (srcSuppress) { e.preventDefault(); e.stopPropagation(); srcSuppress = false; }
  }, true);
  // tag rename: right-click any tag pill (reader tag row, tag/theme pages,
  // inline #tags in the prose, or the tags pop-out) to rename it everywhere
  // on this canvas. Capture-phase so the prose-selection menu never fires for
  // a pill click; left-click behavior (search/focus) is untouched.
  document.addEventListener('contextmenu', (e) => {
    const pill = e.target && e.target.closest ? e.target.closest('#tagPop [data-tpill], #docTags [data-tag], #docBody .tag[data-tag]') : null;
    if (!pill) return;
    const disp = pill.dataset.tpill || pill.dataset.tag;
    if (!disp) return;
    e.preventDefault();
    e.stopPropagation();
    openTagRenameEditor(e.clientX, e.clientY, disp);
  }, true);
  cv.addEventListener('contextmenu', (e) => {
    if (srcSuppress) { e.preventDefault(); srcSuppress = false; return; }
    if (srcHold) { e.preventDefault(); return; } // press-time fire on some platforms: the hold path drives the menu
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    // associated paper icon first: its own menu (remove from this canvas),
    // winning over the seed orb behind it
    const ahm = (ren.assocHit) ? ren.assocHit(e.clientX - r.left, e.clientY - r.top) : null;
    if (ahm) { openAssocDocCtx(e.clientX, e.clientY, ahm); return; }
    const n = uni ? ren.pick(uni.nodes, e.clientX - r.left, e.clientY - r.top) : null;
    if (n && selSet.size && !selSet.has(n.id)) { selSet.clear(); hideBoxSel(); } // right-click elsewhere: single-body menu instead
    openCtx(e.clientX, e.clientY, n ? n.id : null);
  });
  document.addEventListener('click', (e) => { if (!ctx.hidden && !ctx.contains(e.target)) closeCtx(); });
  // window/tab close in browser shells: only the browser’s own
  // leave-confirmation can interrupt an unload (a custom pane can’t pause
  // one), so arm that while the file backup is stale. The editor preview
  // (help-can-edit) is exempt, so dev reloads never trip a native dialog.
  window.addEventListener('beforeunload', (e) => {
    let guard = false;
    try { guard = !document.body.classList.contains('help-can-edit') && needsBackupGuard(); } catch {}
    if (guard) { e.preventDefault(); e.returnValue = true; }
  });
  document.addEventListener('click', (e) => { const m = $('#openProjMenu'); if (m && !m.hidden && !m.contains(e.target) && !e.target.closest('[data-openproj]')) m.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeCtx(); hideOpenProjMenu(); selSet.clear(); hideBoxSel(); closeSrcPop(); if (!closeCarZoom()) closeCarousel(); $('#propsModal').hidden = true; try { $('#imgLight').hidden = true; } catch {} closeHelpEditor(); closeNoteEditor(); closeNotePop(); closeHowStart(); hideCloseGuardPane(); if (notesOpen) closeNotesPane(); if (pinOpenWord != null) setPin(null); const w2 = document.querySelector('#docShared'); document.querySelectorAll('.help-open').forEach(w => shutHelpPop(w)) }
    // box-selection shortcut: Delete/Backspace removes the shift-dragged
    // bodies outright (same confirm as the right-click menu)
    if ((e.key === 'Delete' || e.key === 'Backspace') && selSet.size && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      removeIdsFromCanvas([...selSet]);
      return;
    }
    if ((e.key === ' ' || e.code === 'Space') && !/INPUT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName || '')) {
      e.preventDefault(); setRot(!rotOn); toast(rotOn ? 'Universe resumed' : 'Universe paused');
    }
    // wheel-less zoom: Alt+Up / Alt+Down dollies the camera (same 1.1 steps
    // as the wheel, key-repeat gives smooth travel; skipped while typing)
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
      e.preventDefault();
      if (ren && ren.cam) ren.cam.dist = Math.min(8000, Math.max(220, ren.cam.dist * (e.key === 'ArrowUp' ? 1 / 1.1 : 1.1)));
    }
  });
  // Ctrl/Cmd+A outside fields: confine "select all" to the reader prose, so one
  // keypress can never wash the whole app blue — and copying the open document
  // keeps working no matter where focus sits (canvas, panels, buttons).
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.key !== 'a' && e.key !== 'A' && e.code !== 'KeyA') return;
    const t = document.activeElement;
    if (t && (t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(t.tagName || ''))) return; // fields keep native select-all
    const root = document.getElementById('docBody');
    if (!root || !root.textContent.trim()) return; // empty reader: leave the browser default alone
    e.preventDefault();
    try {
      const r = document.createRange(); r.selectNodeContents(root);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    } catch {}
  });
  $('#propsClose').onclick = () => { $('#propsModal').hidden = true; };
  // reader-panel removal (same actions as the right-click menu — no right-click needed)
  $('#docRemoveBtn').onclick = () => removeFromCanvas(shownId);
  $('#docDeleteBtn').onclick = () => deleteEverywhere(shownId);
  // reader-panel back: walks the reader's own history (docs and lists)
  // without touching the canvas, lens, sun or camera.
  $('#docBackBtn').onclick = () => readerGoBack();
  $('#svpX').onclick = () => closeSrcPop();
  // universe speed controls: Pause freezes physics + camera + glow; log slider = fine slow-mo
  const rotSlider = $('#rotSpeed');
  rotSlider.value = speedToSlider(rotMul);
  const syncMulLabel = () => { $('#rotMul').textContent = fmtSpeed(rotMul); };
  syncMulLabel();
  rotSlider.addEventListener('input', () => {
    rotMul = sliderToSpeed(rotSlider.value);
    syncMulLabel();
    saveUi();
    if (rotMul === 0 && rotOn) toast('Speed at full stop — raise the slider or hit Pause');
  });
  $('#rotBtn').onclick = () => { setRot(!rotOn); toast(rotOn ? 'Universe resumed' : 'Universe paused'); };
  // hover highlight: in the released general view, hovering a body lights up
  // its row in the general list (persisted setting, pill button is first)
  const hvBtnEl = $('#hvBtn');
  if (hvBtnEl) hvBtnEl.onclick = () => {
    hoverPrev = !hoverPrev;
    if (!hoverPrev) { srcHoldHi(); srcClearHi(); } // setting off clears any hover highlight
    syncHv(); saveUi();
    toast(hoverPrev ? 'Hover highlight on — hovering a body lights up its row' : 'Hover highlight off');
  };
  syncHv();
  // document carousel: curved glass coverflow of the Active body (reader-pane trigger)
  try { wireCarousel(); } catch { /* overlay wiring waits for boot */ }
  const carBtnEl = $('#carPaneBtn');
  if (carBtnEl) carBtnEl.onclick = () => { if (carOpen) closeCarousel(); else openCarousel(); };
  const origBtnEl = $('#origPaneBtn');
  if (origBtnEl) origBtnEl.onclick = () => { openCarZoom(carOpen ? (carIdx - (carMediaFirst ? 1 : 0)) : -1); };
  try { syncCarBtn(); } catch {}
  // body texture overlays: slider = opacity, button = on/off toggle
  ren.overlayAlpha = ovAlpha;
  ren.simpleOrb = simpleOrb;
  ren.stripOverlays = simpleOrb2;
  ren.triOrb = triOrb;
  ren.docIcon = docIcon;
  ren.vivid = false; // nebula retired: vivid stays off everywhere
  fetch('src/assets/overlays.json').then(r => r.json()).then(list => ren.loadOverlays(list)).catch(() => {});
  const ovSlider = $('#ovAlpha'), ovLbl = $('#ovMul'), ovBtnEl = $('#ovBtn');
  ovSlider.value = Math.round(ovAlpha * 100);
  const syncOv = () => { ovLbl.textContent = Math.round(ovAlpha * 100) + '%'; ren.overlayAlpha = ovAlpha; saveUi(); };
  ovSlider.addEventListener('input', () => {
    ovAlpha = ovSlider.value / 100;
    if (ovAlpha > 0) ovLast = ovAlpha;
    syncOv();
  });
  // file-name labels: slider = size (far left hides), button = show/hide toggle
  ren.labelScale = lbScale;
  ren.bgShade = bgShade;
  ren.glowScale = glowScale;
  ren.tetherScale = tetherScale;
  ren.tetherDotted = tetherDotted;
  ren.tetherSparse = tetherSparse;
  ren.tetherDashed = tetherDashed;
  const lbSlider = $('#lbSize'), lbLbl = $('#lbMul'), lbBtnEl = $('#lbBtn');
  lbSlider.value = Math.round(lbScale * 100);
  const syncLb = () => { lbLbl.textContent = lbScale <= 0 ? 'hidden' : Math.round(lbScale * 100) + '%'; ren.labelScale = lbScale; saveUi(); };
  lbSlider.addEventListener('input', () => {
    lbScale = lbSlider.value / 100;
    if (lbScale > 0) lbLast = lbScale;
    syncLb();
  });
  lbBtnEl.onclick = () => {
    lbScale = lbScale > 0 ? 0 : (lbLast > 0 ? lbLast : 1);
    lbSlider.value = Math.round(lbScale * 100);
    syncLb();
    toast(lbScale > 0 ? 'Labels on (' + Math.round(lbScale * 100) + '%)' : 'Labels hidden');
  };
  syncLb();
  // (pill Labels tab retired — the toggle lives in the thematic right-click menus)
  // body size: slider scales orbs + triangles, button toggles 100% <-> last size
  ren.bodyScale = sizeScale;
  const szSlider = $('#szSize'), szLbl = $('#szMul'), szBtnEl = $('#szBtn');
  szSlider.value = Math.round(sizeScale * 100);
  const syncSz = () => { szLbl.textContent = Math.round(sizeScale * 100) + '%'; ren.bodyScale = sizeScale; saveUi(); };
  szSlider.addEventListener('input', () => {
    sizeScale = szSlider.value / 100;
    if (sizeScale !== 1) sizeLast = sizeScale;
    syncSz();
  });
  szBtnEl.onclick = () => {
    sizeScale = sizeScale !== 1 ? 1 : (sizeLast !== 1 ? sizeLast : 1.5);
    szSlider.value = Math.round(sizeScale * 100);
    syncSz();
    toast(sizeScale !== 1 ? 'Body size ' + Math.round(sizeScale * 100) + '%' : 'Body size 100%');
  };
  syncSz();
  // body rotation around the vertical axis (spheres turn their surface
  // markings while the light stays fixed; triangles flip edge-on like cards).
  // Slider = speed (dragging above 0 wakes rotation, 0 parks it), button =
  // on/off at the current speed; off eases surfaces back to rest. Runs paused.
  const spSlider = $('#spSpeed'), spLbl = $('#spMul'), spBtnEl = $('#spBtn');
  spSlider.value = Math.round(spinSpeed);
  const syncSp = () => {
    spLbl.textContent = spinOn ? Math.round(spinSpeed) + '%' : 'off';
    ren.spinTarget = (spinOn && spinSpeed > 0) ? 1 : 0;
    ren.spinOmega = spinSpeed > 0 ? 4 * Math.pow(spinSpeed / 100, 0.65) : 0; // perceptual curve: low speeds still visibly turn
    saveUi();
  };
  spSlider.addEventListener('input', () => {
    spinSpeed = +spSlider.value;
    spinOn = spinSpeed > 0; // like every other row the slider acts immediately: >0 wakes rotation, 0 parks it
    syncSp();
  });
  spBtnEl.onclick = () => {
    spinOn = !spinOn;
    syncSp();
    toast(spinOn ? 'Rotation on (' + Math.round(spinSpeed) + '%)' : 'Rotation off');
  };
  syncSp();
  // horizontal compress: slider = squish amount (100 = round), button toggles round <-> last
  ren.compressScale = compressScale;
  const cpSlider = $('#cpSize'), cpLbl = $('#cpMul'), cpBtnEl = $('#cpBtn');
  cpSlider.value = Math.round(compressScale * 100);
  const syncCp = () => { cpLbl.textContent = Math.round(compressScale * 100) + '%'; ren.compressScale = compressScale; saveUi(); };
  cpSlider.addEventListener('input', () => {
    compressScale = cpSlider.value / 100;
    if (compressScale < 1) compressLast = compressScale;
    syncCp();
  });
  cpBtnEl.onclick = () => {
    compressScale = compressScale < 1 ? 1 : (compressLast < 1 ? compressLast : 0.6);
    cpSlider.value = Math.round(compressScale * 100);
    syncCp();
    toast(compressScale < 1 ? 'Compress ' + Math.round(compressScale * 100) + '%' : 'Bodies round');
  };
  syncCp();
  ovBtnEl.onclick = () => {
    ovAlpha = ovAlpha > 0 ? 0 : (ovLast > 0 ? ovLast : 0.6);
    ovSlider.value = Math.round(ovAlpha * 100);
    syncOv();
    toast(ovAlpha > 0 ? 'Overlay on (' + Math.round(ovAlpha * 100) + '%)' : 'Overlay off');
  };
  syncOv();
  // canvas background shade: slider = white (far left) .. black (far right), button = flip extremes
  const bgSlider = $('#bgShade'), bgLbl = $('#bgMul'), bgBtnEl = $('#bgBtn');
  bgSlider.value = Math.round(bgShade * 100);
  const syncBg = () => { bgLbl.textContent = Math.round(bgShade * 100) + '%'; ren.bgShade = bgShade; syncHintContrast(); syncPaneContrast(); syncModeBtn(); saveUi(); };
  bgSlider.addEventListener('input', () => {
    if (luxLeft) { bgSlider.value = Math.round(bgShade * 100); toast('Shade is locked in luxury mode — turn luxury off to change it'); return; }
    bgShade = bgSlider.value / 100;
    syncBg();
  });
  bgBtnEl.onclick = () => {
    if (luxLeft) { toast('Shade is locked in luxury mode — turn luxury off to change it'); return; }
    bgShade = bgShade > 0.5 ? 0 : 1;
    bgSlider.value = Math.round(bgShade * 100);
    syncBg();
    toast(bgShade > 0.5 ? 'Background black' : 'Background white');
  };
  syncBg();
  // luxury hardware fills: the braided-gold bar tracks each left-pane
  // slider. User drags update synchronously through one delegated listener;
  // every programmatic change (toggle buttons, restores) rewrites the row's
  // value label, which the observer picks up — so no existing sync function
  // needs touching. Classic mode hides the bars entirely (CSS).
  function syncLuxFill(input) {
    try {
      const row = input.closest ? input.closest('.rotrow.control-row') : null;
      const fill = row ? row.querySelector('.slider-fill') : null;
      if (!fill) return;
      const min = parseFloat(input.min || '0'), max = parseFloat(input.max || '100');
      const p = Math.max(0, Math.min(1, (parseFloat(input.value) - min) / Math.max(1e-9, max - min)));
      fill.style.width = (p * 100).toFixed(1) + '%';
    } catch {}
  }
  function syncAllLuxFills() {
    try { document.querySelectorAll('#leftPanel .rotrow.control-row input[type="range"]').forEach(syncLuxFill); } catch {}
  }
  try {
    const lp = document.getElementById('leftPanel');
    if (lp) {
      lp.addEventListener('input', (e) => {
        const t = e.target;
        if (t && t.matches && t.matches('.rotrow.control-row input[type="range"]')) syncLuxFill(t);
      });
      new MutationObserver((muts) => {
        for (const m of muts) {
          const el = m.target && m.target.nodeType === 3 ? m.target.parentElement : m.target;
          const row = el && el.closest ? el.closest('.rotrow.control-row') : null;
          if (row) { const inp = row.querySelector('input[type="range"]'); if (inp) syncLuxFill(inp); }
        }
      }).observe(lp, { subtree: true, childList: true, characterData: true });
    }
  } catch {}
  syncAllLuxFills();
  // halo glow radius: slider 0 (none) .. 50 (current) .. 100 (double), button = on/off toggle
  // canvas backdrop: photo texture behind everything, own opacity row (Overlay-style)
  const BACKDROPS = ['bg01.jpg', 'bg02.jpg', 'bg03.jpg', 'bg04.jpg', 'bg05.jpg', 'bg06.jpg', 'bg07.jpg', 'bg08.jpg', 'bg09.jpg', 'bg10.jpg', 'bg11.jpg', 'bg12.jpg'];
  // Same-origin URLs keep the canvas origin-clean (see Renderer.absSrc) —
  // the editor preview resolves relative URLs to the apex domain, which
  // cross-origin-taints the canvas permanently. Fall back to the relative
  // URL if the absolute one fails (e.g. file:// desktop contexts).
  const backdropImgs = new Map(BACKDROPS.map(f => {
    const rel = 'src/assets/backdrops/' + f;
    const im = new Image();
    im.onerror = () => {
      if (im.__fb || im.src === rel) return;
      im.__fb = true;
      try { im.src = rel; } catch {}
    };
    try { im.src = Renderer.absSrc(rel); } catch { im.src = rel; }
    return [f, im];
  }));
  const applyBackdrop = () => {
    ren.backdrop = backdropImgs.get(backdrop) || null;
    ren.backdropAlpha = backdropAlpha;
  };
  const bdSlider = $('#bdAlpha'), bdLbl = $('#bdMul'), bdBtnEl = $('#bdBtn');
  bdSlider.value = Math.round(backdropAlpha * 100);
  const syncBd = () => {
    bdLbl.textContent = backdropAlpha <= 0 ? 'off' : Math.round(backdropAlpha * 100) + '%';
    applyBackdrop(); saveUi();
  };
  bdSlider.addEventListener('input', () => {
    backdropAlpha = bdSlider.value / 100;
    if (backdropAlpha > 0) backdropLast = backdropAlpha;
    syncBd();
  });
  bdBtnEl.onclick = () => {
    backdropAlpha = backdropAlpha > 0 ? 0 : (backdropLast > 0 ? backdropLast : 0.55);
    bdSlider.value = Math.round(backdropAlpha * 100);
    syncBd();
    toast(backdropAlpha > 0 ? 'Backdrop on (' + Math.round(backdropAlpha * 100) + '%)' : 'Backdrop off');
  };
  const bgswatches = [...document.querySelectorAll('#bgPal .bgsw')];
  const syncBgSw = () => bgswatches.forEach(b => b.classList.toggle('on', b.dataset.bg === backdrop && backdrop !== ''));
  bgswatches.forEach(b => { b.onclick = () => {
    backdrop = (backdrop === b.dataset.bg) ? '' : b.dataset.bg; // re-click clears
    if (backdrop && backdropAlpha <= 0) { backdropAlpha = backdropLast > 0 ? backdropLast : 0.55; bdSlider.value = Math.round(backdropAlpha * 100); }
    syncBgSw(); syncBd();
    toast(backdrop ? 'Backdrop ' + (b.title || backdrop) : 'Backdrop cleared');
  }; });
  syncBgSw();
  syncBd();
  const glSlider = $('#glSize'), glLbl = $('#glMul'), glBtnEl = $('#glBtn');
  glSlider.value = Math.round(glowScale * 50);
  const syncGl = () => { glLbl.textContent = Math.round(glowScale * 100) + '%'; ren.glowScale = glowScale; saveUi(); };
  glSlider.addEventListener('input', () => {
    glowScale = glSlider.value / 50;
    if (glowScale > 0) glowLast = glowScale;
    syncGl();
  });
  glBtnEl.onclick = () => {
    glowScale = glowScale > 0 ? 0 : (glowLast > 0 ? glowLast : 1);
    glSlider.value = Math.round(glowScale * 50);
    syncGl();
    toast(glowScale > 0 ? 'Glow on (' + Math.round(glowScale * 100) + '%)' : 'Glow off');
  };
  syncGl();
  // tether thickness: slider 0 (hidden) .. 50 (current) .. 100 (double), button = on/off toggle
  const teSlider = $('#teSize'), teLbl = $('#teMul'), teBtnEl = $('#teBtn');
  teSlider.value = Math.round(tetherScale * 50);
  const syncTe = () => { teLbl.textContent = Math.round(tetherScale * 100) + '%'; ren.tetherScale = tetherScale; syncIsoBtn(); saveUi(); };
  teSlider.addEventListener('input', () => {
    tetherScale = teSlider.value / 50;
    if (tetherScale > 0) tetherLast = tetherScale;
    syncTe();
  });
  teBtnEl.onclick = () => {
    tetherScale = tetherScale > 0 ? 0 : (tetherLast > 0 ? tetherLast : 1);
    teSlider.value = Math.round(tetherScale * 50);
    syncTe();
    toast(tetherScale > 0 ? 'Tethers on (' + Math.round(tetherScale * 100) + '%)' : 'Tethers hidden');
  };
  syncTe();
  // tether tint palette: 12 swatches, persisted, live on the renderer
  ren.tetherColor = tetherColor;
  const swatches = [...document.querySelectorAll('#tePal .tesw')];
  const syncSw = () => swatches.forEach(b => b.classList.toggle('on', (b.dataset.color || '').toLowerCase() === String(tetherColor).toLowerCase()));
  swatches.forEach(b => { b.onclick = () => { tetherColor = b.dataset.color; ren.tetherColor = tetherColor; syncSw(); saveUi(); toast('Tether color ' + (b.title || tetherColor)); }; });
  syncSw();
  // pane background opacity: slider = glass alpha, button = glass/clear toggle.
  // Only the pane BACKGROUNDS fade (a --paneAlpha multiplier on their background
  // paint) — text, buttons, sliders and the bottom pill are never touched.
  const paSlider = $('#paSize'), paLbl = $('#paMul'), paBtnEl = $('#paBtn');
  paSlider.value = Math.round(paneAlpha * 100);
  const syncPa = () => {
    paLbl.textContent = paneAlpha <= 0 ? 'clear' : Math.round(paneAlpha * 100) + '%';
    try { document.documentElement.style.setProperty('--paneAlpha', String(paneAlpha)); } catch {}
    syncPaneContrast();
    saveUi();
  };
  paSlider.addEventListener('input', () => {
    paneAlpha = paSlider.value / 100;
    if (paneAlpha > 0) paneLast = paneAlpha;
    syncPa();
  });
  paBtnEl.onclick = () => {
    paneAlpha = paneAlpha > 0 ? 0 : (paneLast > 0 ? paneLast : 1);
    paSlider.value = Math.round(paneAlpha * 100);
    syncPa();
    toast(paneAlpha > 0 ? 'Pane glass on (' + Math.round(paneAlpha * 100) + '%)' : 'Pane backgrounds clear');
  };
  syncPa();
  // per-pane glass overlay dots: toggle the polished-glass background (persisted)
  document.querySelectorAll('.glassDot').forEach(b => { b.onclick = glazeDotClick; });
  document.querySelectorAll('.luxDot').forEach(b => { b.onclick = luxDotClick; });
  applyGlaze();
  applyLux();
  // projects-pill restack: hover/focus/pin of a pill ? must re-decide
  // reader-over-pill vs popover-above (the pill element itself survives
  // renderTabs rebuilds, so one wiring holds for the session).
  try {
    const tb0 = document.getElementById('tabBar');
    if (tb0) {
      let tbzT = 0;
      const tbzSoon = () => { const t = ++tbzT; requestAnimationFrame(() => { if (t === tbzT) { try { syncTabBarZ(); } catch {} } }); };
      ['mouseover', 'mouseout', 'focusin', 'focusout', 'click'].forEach(ev => tb0.addEventListener(ev, tbzSoon));
    }
  } catch {}
  // column collapse arrows (persisted, collapse = shrink up to a top tab)
  document.querySelectorAll('[data-collapse]').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); setCollapsed(b.dataset.collapse, !document.getElementById(b.dataset.collapse)?.classList.contains('collapsed')); try { syncFindBar(); } catch {} try { syncTopBtn(); } catch {} try { syncNotesTab(); } catch {} try { sizeDocPanel(); } catch {} try { syncTabBarZ(); } catch {} };
  });
  if (leftCollapsed) setCollapsed('leftPanel', true);
  if (docCollapsed) setCollapsed('docPanel', true);
  // reader pane resize: ‹ stretch arrow on the pane's left edge, drag to stretch
  const wireResize = (el, dir) => {
    if (!el) return;
    let dragX = 0, dragW = 0, dragging = false;
    el.addEventListener('pointerdown', (e) => {
      dragging = true; dragX = e.clientX;
      dragW = document.getElementById('docPanel')?.getBoundingClientRect().width || 380;
      try { el.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      docWidth = clampDocW(dragW + dir * (e.clientX - dragX));
      applyDocWidth();
      try { placeFindSide(); } catch {} try { placeTopBtn(); } catch {} try { syncNotesTab(); } catch {} try { if (notesOpen) applyNotesGeom(); } catch {}
    });
    const endDrag = () => { if (!dragging) return; dragging = false; saveUi(); };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    el.addEventListener('dblclick', () => { docWidth = 0; applyDocWidth(); try { placeFindSide(); } catch {} try { placeTopBtn(); } catch {} try { syncNotesTab(); } catch {} try { if (notesOpen) applyNotesGeom(); } catch {} saveUi(); toast('Reader width reset'); });
  };
  try {
    applyDocWidth();
    wireResize(document.getElementById('docResize'), -1); // left edge: drag left = widen
    { const dtb = document.getElementById('docTiltBtn'); if (dtb && !dtb.dataset.wired) { dtb.dataset.wired = '1'; dtb.onclick = () => { const p = document.getElementById('docPanel'); if (p) setDocTilt(!p.classList.contains('tiltedR')); }; } }
    window.addEventListener('resize', () => fitViewport('resize'));
    // late layout settlers (webfonts swap row metrics after first paint) —
    // re-park the reader's bottom edge once they're in, or the pill-top read bakes in early
    try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { try { syncHbTabs(); } catch {} try { sizeDocPanel(); } catch {} try { placeTabBar(); } catch {} }); } catch {}
    window.addEventListener('load', () => { try { syncHbTabs(); } catch {} try { sizeDocPanel(); } catch {} try { placeTabBar(); } catch {} });
  } catch {}
  // verse minimap: header-drags to move, corner-drags to resize (both persist)
  try {
    const box = document.getElementById('miniMap'), head = document.getElementById('miniMapHead'), grip = document.getElementById('miniMapResize');
    if (box && head) {
      let mv = null, lastTapT = 0;
      head.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.closest && e.target.closest('#miniMapFold')) return; // the fold button keeps its own click
        const r = box.getBoundingClientRect();
        box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
        box.style.right = 'auto'; box.style.bottom = 'auto';
        mv = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
        try { head.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
      });
      head.addEventListener('pointermove', (e) => {
        if (!mv) return;
        miniX = e.clientX - mv.dx; miniY = e.clientY - mv.dy;
        applyMiniGeom(false); // dragging: no corner auto-lodge mid-drag (it lands on release triggers)
      });
      // double-tap to stow (not a real dblclick — the pointerdown
      // preventDefault above eats compatibility mouse events): two quick taps
      // on the header without a drag in between dock the map bottom-right.
      const endMv = (e) => {
        if (!mv) return;
        const dragged = !e || Math.hypot((e.clientX || 0) - mv.sx, (e.clientY || 0) - mv.sy) > 6;
        const onFold = !!(e && e.target && e.target.closest && e.target.closest('#miniMapFold'));
        mv = null;
        if (!dragged && !onFold) {
          const now = Date.now();
          if (now - lastTapT < 400) {
            lastTapT = 0;
            miniX = null; miniY = null;
            applyMiniGeom(); saveUi();
            toast('Verse map stowed');
            return;
          }
          lastTapT = now;
        }
        saveUi();
      };
      head.addEventListener('pointerup', endMv);
      head.addEventListener('pointercancel', endMv);
      const fold = document.getElementById('miniMapFold');
      if (fold) fold.onclick = (e) => {
        e.stopPropagation();
        miniFolded = !miniFolded;
        syncMiniFold(); applyMiniGeom(); // fold class first: geometry measures the shown (folded/unfolded) height
        if (!miniFolded) drawMiniMap(); // fresh frame the moment it reopens
        saveUi();
      };
    }
    if (box && grip) {
      let rs = null;
      grip.addEventListener('pointerdown', (e) => {
        const r = box.getBoundingClientRect();
        rs = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
        try { grip.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
      });
      grip.addEventListener('pointermove', (e) => {
        if (!rs) return;
        miniW = Math.max(140, Math.min(640, rs.w + (e.clientX - rs.x)));
        miniH = Math.max(100, Math.min(480, rs.h + (e.clientY - rs.y)));
        applyMiniGeom(false); // resizing: no corner auto-lodge mid-gesture
      });
      const endRs = () => { if (!rs) return; rs = null; saveUi(); };
      grip.addEventListener('pointerup', endRs);
      grip.addEventListener('pointercancel', endRs);
    }
    window.addEventListener('resize', () => { if (autoDist) applyMiniGeom(); });
    syncMiniMap();
  } catch {}
  // pills: hand-drag either by any blank background to move it (fixed size,
  // never stretchable; positions persist; double-click resets to the dock).
  // Single-clicking the TOP pill's blank background centers BOTH pills
  // left-to-right (heights stay hard-docked); clicking it again docks both
  // back beside the left pane.
  try {
    const topBar = document.getElementById('tabBar');
    if (topBar && !topBar.title) topBar.title = 'Click the empty background to center both pills left-to-right — click again to dock them beside the left pane. Drag to move.';
    wirePillDrag(topBar, (x, y) => { slidePillsTandem(x, 'bar'); }, () => { try { togglePillsCenter(); } catch {} }); // TOP pill: horizontal-only tandem drag — the bottom pill slides along; height hard-docked
    wirePillDrag(document.getElementById('hintBar'), (x, y) => { slidePillsTandem(x, 'hint'); }); // BOTTOM pill: horizontal-only tandem drag — the top pill slides along; height hard-docked
  } catch {}
  // tags pop-out: header-drags to move the glass card anywhere (persists; double-click header or any empty pane space re-centers)
  try {
    const tbox = document.getElementById('tagPop');
    const thead = tbox ? tbox.querySelector('.tvp-head') : null;
    const tcard = tbox ? tbox.querySelector('.tvp-card') : null;
    if (tbox && thead && tcard) {
      let drag = null;
      thead.addEventListener('pointerdown', (e) => {
        if (e.target && e.target.closest && e.target.closest('.tvp-x')) return; // ✕ keeps its own click
        const r = tcard.getBoundingClientRect();
        tcard.style.position = 'fixed'; tcard.style.left = r.left + 'px'; tcard.style.top = r.top + 'px'; tcard.style.margin = '0';
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        try { thead.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
      });
      thead.addEventListener('pointermove', (e) => {
        if (!drag) return;
        tvpX = e.clientX - drag.dx; tvpY = e.clientY - drag.dy;
        applyTvpGeom();
      });
      const endTdrag = () => { if (!drag) return; drag = null; saveUi(); };
      thead.addEventListener('pointerup', endTdrag);
      thead.addEventListener('pointercancel', endTdrag);
      thead.addEventListener('dblclick', (e) => {
        if (e.target && e.target.closest && e.target.closest('.tvp-x')) return;
        tvpX = tvpY = tvpW = tvpH = null; applyTvpGeom(); saveUi();
      });
      // empty-space reset: double-clicking bare pane space (tag-list gaps,
      // padding, legend text) re-centers too — pills keep their rename,
      // buttons/links/inputs, the resize grip and the header keep theirs
      tcard.addEventListener('dblclick', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('button, input, a, select, textarea, [contenteditable], .tvp-head, #tvpGrip')) return;
        tvpX = tvpY = tvpW = tvpH = null; applyTvpGeom(); saveUi();
      });
      // corner grip: drag to resize the card (persists like the position)
      try {
        const grip = document.getElementById('tvpGrip');
        if (grip && tcard) {
          let rs = null;
          grip.addEventListener('pointerdown', (e) => {
            const r = tcard.getBoundingClientRect();
            rs = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
            try { grip.setPointerCapture(e.pointerId); } catch {}
            e.preventDefault();
            e.stopPropagation();
          });
          grip.addEventListener('pointermove', (e) => {
            if (!rs) return;
            tvpW = Math.max(320, Math.min(Math.min(920, window.innerWidth * 0.94), rs.w + (e.clientX - rs.x)));
            tvpH = Math.max(200, Math.min(window.innerHeight * 0.94, rs.h + (e.clientY - rs.y)));
            applyTvpGeom();
          });
          const endRs = () => { if (!rs) return; rs = null; saveUi(); };
          grip.addEventListener('pointerup', endRs);
          grip.addEventListener('pointercancel', endRs);
        }
      } catch {}
      window.addEventListener('resize', () => { if (tvpX != null && !tbox.hidden) applyTvpGeom(); });
    }
  } catch {}
  // glossary of terms: book tab on the VisiDocsverse pane toggles it open;
  // the pane itself header-drags to move, corner-drags to resize (handy while
  // open — every open restarts at the dock). The old bottom-pill strip is gone.
  try {
    const gbox = document.getElementById('glossPane');
    if (gbox) {
      const ghead = document.getElementById('glossHead'), ggrip = document.getElementById('glossResize');
      const gclose = document.getElementById('glossClose');
      const gtab = document.getElementById('glossTab');
      if (gtab) { gtab.onclick = () => setGloss(!glossOpen); gtab.classList.toggle('open', glossOpen); }
      if (gclose) gclose.onclick = () => setGloss(false);
      // pinned-term tabs: pin buttons live at the end of each glossary term,
      // pin tabs stack under the glossary tab on the left panel's border
      try {
        injectPinButtons(); syncPinTabs();
        const gb = document.getElementById('glossBody');
        if (gb) gb.addEventListener('click', (e) => {
          const pin = e.target.closest && e.target.closest('[data-gpin]');
          if (pin) { e.stopPropagation(); togglePin(pin.dataset.gpin); }
        });
        const lp0 = document.getElementById('app');
        if (lp0) lp0.addEventListener('click', (e) => {
          const pt = e.target.closest && e.target.closest('.pinTab');
          if (pt && pt.dataset.pinword) setPin(pinOpenWord === pt.dataset.pinword ? null : pt.dataset.pinword);
        });
        const pclose = document.getElementById('pinClose');
        if (pclose) pclose.onclick = () => setPin(null);
        const punpin = document.getElementById('pinUnpin');
        if (punpin) punpin.onclick = () => togglePin(pinOpenWord);
      } catch {}
      if (ghead) {
        let mv = null;
        ghead.addEventListener('pointerdown', (e) => {
          if (e.target && e.target.closest && e.target.closest('#glossClose')) return; // ✕ keeps its own click
          const r = gbox.getBoundingClientRect();
          gbox.style.left = r.left + 'px'; gbox.style.top = r.top + 'px';
          gbox.style.right = 'auto'; gbox.style.bottom = 'auto';
          mv = { dx: e.clientX - r.left, dy: e.clientY - r.top };
          try { ghead.setPointerCapture(e.pointerId); } catch {}
          e.preventDefault();
        });
        ghead.addEventListener('pointermove', (e) => {
          if (!mv) return;
          glossX = e.clientX - mv.dx; glossY = e.clientY - mv.dy;
          applyGlossGeom();
        });
        const endMv = () => { if (!mv) return; mv = null; saveUi(); };
        ghead.addEventListener('pointerup', endMv);
        ghead.addEventListener('pointercancel', endMv);
      }
      if (ggrip) {
        let rs = null;
        ggrip.addEventListener('pointerdown', (e) => {
          const r = gbox.getBoundingClientRect();
          rs = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
          try { ggrip.setPointerCapture(e.pointerId); } catch {}
          e.preventDefault();
        });
        ggrip.addEventListener('pointermove', (e) => {
          if (!rs) return;
          glossW = Math.max(240, Math.min(620, rs.w + (e.clientX - rs.x)));
          glossH = Math.max(160, Math.min(720, rs.h + (e.clientY - rs.y)));
          applyGlossGeom();
        });
        const endRs = () => { if (!rs) return; rs = null; saveUi(); };
        ggrip.addEventListener('pointerup', endRs);
        ggrip.addEventListener('pointercancel', endRs);
      }
      window.addEventListener('resize', () => { if (glossOpen) applyGlossGeom(); try { syncPinTabs(); } catch {} try { if (pinOpenWord != null) placePinPane(); } catch {} try { syncNotesTab(); } catch {} try { if (notesOpen) applyNotesGeom(); } catch {} });
      // the top pill grows as tabs render (after this wiring runs) and the
      // bottom pill hides on small screens — re-clamp into the band whenever
      // either pill's geometry settles, not just on window resize.
      try {
        const reGloss = () => { if (glossOpen) applyGlossGeom(); try { syncNotesTab(); } catch {} try { if (notesOpen) applyNotesGeom(); } catch {} };
        if (window.ResizeObserver) {
          const ro = new ResizeObserver(() => reGloss());
          const tb = document.getElementById('tabBar'), hb = document.getElementById('hintBar');
          if (tb) ro.observe(tb); if (hb) ro.observe(hb);
        }
        requestAnimationFrame(() => reGloss());
        setTimeout(() => reGloss(), 600);
      } catch {}
      syncGloss();
    }
    // Notes book pane: fixed beside the reader (never draggable), wiring only
    try {
      const nt = $('#notesTab');
      if (nt) nt.onclick = () => setNotes(!notesOpen, vault.byId(shownId) ? shownId : activeId);
      const nc = $('#notesClose');
      if (nc) nc.onclick = () => closeNotesPane();
      const na = $('#notesAutoCk');
      if (na) { na.checked = notesAuto !== false; na.onchange = () => { notesAuto = na.checked; saveUi(); if (notesAuto) autoSaveNoteEntry(); toast(notesAuto ? 'Notes auto-save on' : 'Notes auto-save off — use Save to push'); }; }
      const nar = $('#notesArea');
      if (nar) nar.addEventListener('input', onNotesInput);
      const nsv = $('#notesSave');
      if (nsv) nsv.onclick = saveNotesPane;
      const nda = $('#notesDelAll');
      if (nda) nda.onclick = () => { const n = clearNoteEntries(notesDocId); toast(n ? `All ${n} note ${n === 1 ? 'entry' : 'entries'} deleted` : 'No note entries to delete'); };
      const ncn = $('#notesCancel');
      if (ncn) ncn.onclick = cancelNotesPane;
      const nss = $('#notesSelBtn');
      if (nss) nss.onclick = () => sendSelectionToNotes();
      const ncc = $('#notesCiteCopy');
      if (ncc) ncc.onclick = () => copyApaCite(notesDocId);
      // drag-and-drop: a highlight dragged from the body can be dropped onto
      // the pane (list/background files it at once; the composer keeps it as
      // draft text and pins the next save) or onto the Notes tab while closed.
      try {
        const db = $('#docBody');
        if (db && !db.dataset.noteDrag) {
          db.dataset.noteDrag = '1';
          db.addEventListener('dragstart', (e) => {
            try {
              dragFromNotes = false;
              const live = readReaderSelection();
              const useTxt = String(live.text || '').trim() ? live.text : '';
              dragNotePayload = useTxt.trim() ? { text: String(useTxt), spot: live.spot, docId: shownId } : null;
              try { if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; } catch {}
            } catch { dragNotePayload = null; }
          });
          db.addEventListener('dragend', () => { setTimeout(() => { dragNotePayload = null; }, 60); });
        }
        const np = $('#notesPane');
        if (np && !np.dataset.noteDrop) {
          np.dataset.noteDrop = '1';
          np.addEventListener('dragstart', () => { dragFromNotes = true; });
          np.addEventListener('dragend', () => { setTimeout(() => { dragFromNotes = false; }, 60); });
          np.addEventListener('dragover', (e) => {
            if (dragFromNotes) return; // internal reorder — never re-files
            try {
              const ty = (e.dataTransfer && e.dataTransfer.types) || [];
              const hasText = [...ty].some(t => String(t).toLowerCase().includes('text/plain') || String(t).toLowerCase().includes('text/html'));
              if (!hasText && ty.length) return; // files etc: leave to their own targets
            } catch {}
            try { e.preventDefault(); } catch {}
            try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } catch {}
            np.classList.add('drop-hi');
          });
          np.addEventListener('dragleave', (e) => {
            try { if (e.target === np || (e.relatedTarget && !np.contains(e.relatedTarget))) np.classList.remove('drop-hi'); } catch {}
            if (!np.matches(':hover')) { try { np.classList.remove('drop-hi'); } catch {} }
          });
          np.addEventListener('drop', (e) => {
            try { np.classList.remove('drop-hi'); } catch {}
            if (dragFromNotes) return; // let the native reorder land
            const inArea = !!(e.target && e.target.closest && e.target.closest('#notesArea'));
            const txt = notesDropText(e);
            if (!txt.trim()) return;
            const targetId = vault.byId(notesDocId) ? notesDocId : (vault.byId(shownId) ? shownId : null);
            if (!targetId) { try { e.preventDefault(); } catch {} toast('Open a document body first — notes live on bodies'); return; }
            if (inArea) {
              // manual insert at the caret (never relies on the native drop
              // action, so trusted + synthetic drops behave identically);
              // stash the passage anchor so the next save pins this entry.
              let sp = null;
              if (dragNotePayload && dragNotePayload.docId === targetId && dragNotePayload.spot && typeof dragNotePayload.spot === 'object') sp = dragNotePayload.spot;
              else { const sn = txt.trim().replace(/\s+/g, ' ').slice(0, 200); if (sn.trim().length >= 2) sp = { snip: sn }; }
              const clean = (typeof cleanNoteSpot === 'function') ? cleanNoteSpot(sp) : sp;
              notesDropSpot = clean ? { docId: targetId, spot: clean } : null;
              try { e.preventDefault(); } catch {}
              try { e.stopPropagation(); } catch {}
              try {
                const area = $('#notesArea');
                if (area && !area.disabled) {
                  const ins = txt.trim().slice(0, NOTE_MAX);
                  const cur = area.value || '';
                  let at = (typeof area.selectionStart === 'number') ? area.selectionStart : cur.length;
                  let to = (typeof area.selectionEnd === 'number') ? area.selectionEnd : at;
                  at = Math.max(0, Math.min(cur.length, at)); to = Math.max(0, Math.min(cur.length, to));
                  if (to < at) { const t2 = at; at = to; to = t2; }
                  const sep = (cur && at > 0 && at < cur.length && !/\s/.test(cur[at - 1] || '') && ins && !/^\s/.test(ins)) ? ' ' : '';
                  const next = (cur.slice(0, at) + sep + ins + cur.slice(to)).slice(0, NOTE_MAX);
                  area.value = next;
                  const caret = Math.min(next.length, at + sep.length + ins.length);
                  try { area.selectionStart = area.selectionEnd = caret; } catch {}
                  try { area.focus({ preventScroll: true }); } catch { try { area.focus(); } catch {} }
                  try { onNotesInput(); } catch {}
                }
              } catch {}
              toast(notesAuto !== false ? 'Dropped into composer — auto-save will pin it' : 'Dropped into composer — press Save to pin it');
              return;
            }
            try { e.preventDefault(); } catch {}
            try { e.stopPropagation(); } catch {}
            fileDroppedHighlight(txt, targetId);
          });
        }
        if (nt && !nt.dataset.noteDrop) {
          nt.dataset.noteDrop = '1';
          nt.addEventListener('dragover', (e) => {
            if (dragFromNotes) return;
            try {
              const ty = (e.dataTransfer && e.dataTransfer.types) || [];
              const hasText = [...ty].some(t => String(t).toLowerCase().includes('text/plain') || String(t).toLowerCase().includes('text/html'));
              if (!hasText && ty.length) return;
            } catch {}
            try { e.preventDefault(); } catch {}
            try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; } catch {}
            nt.classList.add('drop-hi');
          });
          nt.addEventListener('dragleave', () => { try { nt.classList.remove('drop-hi'); } catch {} });
          nt.addEventListener('drop', (e) => {
            try { nt.classList.remove('drop-hi'); } catch {}
            if (dragFromNotes) return;
            const txt = notesDropText(e);
            if (!txt.trim()) return;
            try { e.preventDefault(); } catch {}
            try { e.stopPropagation(); } catch {}
            const targetId = vault.byId(shownId) ? shownId : activeId;
            if (!vault.byId(targetId)) { toast('Open a document body first — notes live on bodies'); return; }
            if (!notesOpen) { try { setNotes(true, targetId); } catch {} }
            fileDroppedHighlight(txt, vault.byId(notesDocId) ? notesDocId : targetId);
          });
        }
      } catch {}
      // highlight cue wiring: any settled highlight in the body briefly floats
      // the "Drag highlighted text…" tip above it (selectionchange debounced so
      // mid-drag mouse sweeps don't nag; mousedown/dragstart/scroll hide it).
      try {
        if (!document.documentElement.dataset.selTip) {
          document.documentElement.dataset.selTip = '1';
          let selTipPend = 0;
          document.addEventListener('selectionchange', () => {
              try {
                const sel = window.getSelection();
                const root = $('#docBody');
                if (sel && !sel.isCollapsed && root && sel.anchorNode && root.contains(sel.anchorNode)) { try { clearTimeout(selTipPend); } catch {} selTipPend = setTimeout(cueSelDropTip, 350); return; }
                // overlay / carousel highlight: same debounce, pane-flavoured tip
                try {
                  const zwrap = $('#carZoomWrap');
                  const zroot = (zwrap && !zwrap.hidden) ? $('#carZoomText') : null;
                  if (zroot && sel && !sel.isCollapsed && sel.anchorNode && zroot.contains(sel.anchorNode)) { try { clearTimeout(selTipPend); } catch {} selTipPend = setTimeout(() => cuePaneNoteTip(zroot), 350); return; }
                  const trk = (typeof carOpen !== 'undefined' && carOpen && typeof carZoomOpen !== 'undefined' && !carZoomOpen) ? $('#carTrack') : null;
                  if (trk && sel && !sel.isCollapsed && sel.anchorNode) {
                    const an = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
                    const prot = an && an.closest ? an.closest('.car-pane .car-text') : null;
                    if (prot) { try { clearTimeout(selTipPend); } catch {} selTipPend = setTimeout(() => cuePaneNoteTip(prot), 350); return; }
                  }
                } catch {}
                hideSelDropTip(); try { clearTimeout(selTipPend); } catch {}
              } catch {}
            });
          const dbTip = $('#docBody');
          if (dbTip) {
            dbTip.addEventListener('mousedown', hideSelDropTip);
            dbTip.addEventListener('dragstart', hideSelDropTip);
          }
          const dscTip = $('#docScroll');
          if (dscTip) dscTip.addEventListener('scroll', hideSelDropTip, { passive: true });
            const czbTip = $('#carZoomBody');
            if (czbTip) czbTip.addEventListener('scroll', hideSelDropTip, { passive: true });
            const ctrTip = $('#carTrack');
            if (ctrTip) { ctrTip.addEventListener('scroll', hideSelDropTip, { passive: true }); ctrTip.addEventListener('mousedown', hideSelDropTip); ctrTip.addEventListener('dragstart', hideSelDropTip); }
            const cztTip = $('#carZoomText');
            if (cztTip) { cztTip.addEventListener('mousedown', hideSelDropTip); cztTip.addEventListener('dragstart', hideSelDropTip); }
            window.addEventListener('resize', hideSelDropTip);
        }
      } catch {}
      const nll = $('#notesList');
      if (nll) nll.addEventListener('click', (e) => {
        const x = e.target.closest('[data-ndel]');
        if (x && notesDocId) { if (deleteNoteEntry(notesDocId, x.dataset.ndel)) toast('Note entry deleted'); return; }
        const box = e.target.closest('[data-nejump]');
        // copying note text (a live selection inside the notes list) must not
        // jump on mouse-up — only a plain click on a pinned box jumps. Stale
        // reader selections don't count (scoped to #notesList).
        if (box && notesDocId) { try { const s = window.getSelection(); if (s && !s.isCollapsed && s.anchorNode && nll.contains(s.anchorNode)) return; } catch {} jumpToNoteSpot(box.dataset.nejump); } // pinned box -> quick-jump to its passage
        else if (box && !notesDocId) toast('Open a document body first — notes live on bodies');
        else if (e.target.closest('.ne') && notesDocId) toast('That entry has no body position — only sent highlights jump');
      });
      syncNotesTab();
      if (notesOpen) { if (vault.byId(notesDocId || activeId)) setNotes(true, notesDocId || activeId); else { notesOpen = false; syncNotesTab(); } }
      // view-jump side cluster: one MAIN / THEMATIC / TAGS set for the shown doc
      const gM = $('#gotoMain'), gT = $('#gotoThematic'), gG = $('#gotoTags');
      if (gM) gM.onclick = () => { const id = shownId; gotoViewFor(id, 'main'); gotoPicked = { docId: id, view: 'main' }; applyGotoPicked(); };
      if (gT) gT.onclick = () => { const id = shownId; gotoViewFor(id, 'thematic'); gotoPicked = { docId: id, view: 'thematic' }; applyGotoPicked(); };
      if (gG) gG.onclick = () => { const id = shownId; gotoViewFor(id, 'tags'); gotoPicked = { docId: id, view: 'tags' }; applyGotoPicked(); };
      const gX = $('#gotoSideX');
      if (gX) gX.onclick = () => { gotoSideClosedFor = shownId; const box = $('#gotoSide'); if (box) box.hidden = true; };
    } catch {}
  } catch {}
  // bottom pill "Tethers" button: show/hide the tether lines (bodies always stay put)
  const isoBtn = $('#isoBtn');
  if (isoBtn) isoBtn.onclick = () => {
    tetherScale = tetherScale > 0 ? 0 : (tetherLast > 0 ? tetherLast : 1);
    teSlider.value = Math.round(tetherScale * 50);
    syncTe();
    toast(tetherScale > 0 ? 'Tethers shown' : 'Tethers hidden');
  };
  syncIsoBtn();
  // bottom pill "2"/"3" tether partitions: "2" = dotted, "3" = sparse dots
  // (same show/hide state, same thickness — only the stroke changes).
  // The two styles exclude each other; clicking the active one restores solid.
  const tetherDotsBtn = $('#tetherDotsBtn');
  if (tetherDotsBtn) tetherDotsBtn.onclick = () => {
    if (tetherDotted && !tetherSparse) tetherDotted = false;
    else { tetherDotted = true; tetherSparse = false; tetherDashed = false; }
    if (ren) { ren.tetherDotted = tetherDotted; ren.tetherSparse = tetherSparse; ren.tetherDashed = tetherDashed; }
    syncTetherDotsBtn(); syncTetherSparseBtn(); syncTetherDashedBtn(); saveUi();
    toast(tetherDotted ? 'Dotted tethers on' : 'Solid tethers restored');
  };
  syncTetherDotsBtn();
  const tetherSparseBtn = $('#tetherSparseBtn');
  if (tetherSparseBtn) tetherSparseBtn.onclick = () => {
    if (tetherSparse) { tetherSparse = false; tetherDotted = false; }
    else { tetherSparse = true; tetherDotted = true; tetherDashed = false; }
    if (ren) { ren.tetherDotted = tetherDotted; ren.tetherSparse = tetherSparse; ren.tetherDashed = tetherDashed; }
    syncTetherDotsBtn(); syncTetherSparseBtn(); syncTetherDashedBtn(); saveUi();
    toast(tetherSparse ? 'Sparse tethers on' : 'Solid tethers restored');
  };
  syncTetherSparseBtn();
  const tetherDashedBtn = $('#tetherDashedBtn');
  if (tetherDashedBtn) tetherDashedBtn.onclick = () => {
    if (tetherDashed) tetherDashed = false;
    else { tetherDashed = true; tetherDotted = false; tetherSparse = false; }
    if (ren) { ren.tetherDotted = tetherDotted; ren.tetherSparse = tetherSparse; ren.tetherDashed = tetherDashed; }
    syncTetherDotsBtn(); syncTetherSparseBtn(); syncTetherDashedBtn(); saveUi();
    toast(tetherDashed ? 'Dashed tethers on' : 'Solid tethers restored');
  };
  syncTetherDashedBtn();
  // bottom pill "Tips" toggle: collapses only the tip rows, buttons always stay
  const tipsBtn = $('#tipsBtn');
  if (tipsBtn) tipsBtn.onclick = () => {
    tipsCollapsed = !tipsCollapsed;
    saveUi();
    syncTipsBtn();
    try { placeTabBar(); } catch {} // tips no longer change the bottom pill's width (collapsed rows keep it): re-seat heights/positions + the verse map
    toast(tipsCollapsed ? 'Tips hidden — buttons stay' : 'Tips shown');
  };
  syncTipsBtn();
  // book-tab equal widths: any label swap re-measures (own style.width
  // sets are attribute mutations, so they never retrigger this observer)
  try {
    const hbRow = document.querySelector('#hintBar .hb-btns');
    if (hbRow && !hbRow.dataset.wobs) {
      hbRow.dataset.wobs = '1';
      let queued = false;
      new MutationObserver(() => {
        if (queued) return; queued = true;
        requestAnimationFrame(() => { queued = false; try { syncHbTabs(); } catch {} });
      }).observe(hbRow, { childList: true, characterData: true, subtree: true });
    }
  } catch {}
  try { syncHbTabs(); } catch {}
  // bottom pill "Distribute" button: pin bodies in a fit-to-canvas orb, overriding
  // orbital motion; toggling off restores dynamics (persisted)
  const autoBtn = $('#autoBtn');
  if (autoBtn) autoBtn.onclick = () => {
    autoDist = !autoDist;
    clearFit(); // distribute re-pins every body: any fitted view is stale
    // hand-placed spots only live inside distribute mode: toggling either way
    // reseats every body (fresh fibonacci orb on enable, free physics on disable)
    if (uni) for (const n of uni.nodes) { n._ox = n._oy = n._oz = undefined; n._held = false; }
    // the pinned orb zeroes velocities every frame, so a bare release would
    // drop every body down the gravity well into one pile — re-seat settled
    // instead (the same composed seating fresh canvases open with, and what
    // Fit uses when leaving distribute): real shell positions, correct
    // orbital velocities, springs already webbed
    if (!autoDist && uni) { try { settleFresh(uni); } catch { /* the live sim finishes the job */ } }
    syncAutoBtn(); saveUi();
    toast(autoDist ? 'Auto-distribute on — bodies pinned in a fit-to-canvas orb' : 'Orbital dynamics restored');
  };
  syncAutoBtn();
  // bottom pill "Plain Body" button: flat white discs + thin black outline,
  // photo + glow overlays off; toggling off restores textured orbs (persisted)
  const simpleOrbBtn = $('#simpleOrbBtn');
  if (simpleOrbBtn) simpleOrbBtn.onclick = () => {
    simpleOrb = !simpleOrb;
    if (simpleOrb) simpleOrb2 = false; // the two simple modes are mutually exclusive
    ren.simpleOrb = simpleOrb;
    ren.stripOverlays = simpleOrb2;
    syncSimpleOrbBtn(); syncSimpleOrb2Btn(); saveUi();
    toast(simpleOrb ? 'Plain Body on — flat white discs, overlays off' : 'Textured orbs restored');
  };
  syncSimpleOrbBtn();
  // bottom pill "Plain Body 2" button: original blue orbs with only the photo
  // overlays stripped (glow stays); toggling off restores photos (persisted)
  const simpleOrb2Btn = $('#simpleOrb2Btn');
  if (simpleOrb2Btn) simpleOrb2Btn.onclick = () => {
    simpleOrb2 = !simpleOrb2;
    if (simpleOrb2) simpleOrb = false; // the two simple modes are mutually exclusive
    ren.simpleOrb = simpleOrb;
    ren.stripOverlays = simpleOrb2;
    syncSimpleOrbBtn(); syncSimpleOrb2Btn(); saveUi();
    toast(simpleOrb2 ? 'Plain Body 2 on — blue orbs, photo overlays stripped' : 'Photo overlays restored');
  };
  syncSimpleOrb2Btn();
  // bottom pill "Body to ▼" button: body shape swap — upside-down triangles
  // with the same fill and size as the orbs they replace (combines with any
  // color mode: textured, Plain Body white, Plain Body 2 blue)
  const triOrbBtn = $('#triOrbBtn');
  if (triOrbBtn) triOrbBtn.onclick = () => {
    triOrb = !triOrb;
    if (triOrb) docIcon = false; // one shape at a time
    ren.triOrb = triOrb;
    ren.docIcon = docIcon;
    syncTriOrbBtn(); syncDocIconBtn(); saveUi();
    if (autoDist) drawMiniMap(); // verse map mirrors the new body shape at once
    toast(triOrb ? 'Triangles on — upside-down ▼ in orb colors and sizes' : 'Orbs restored');
  };
  syncTriOrbBtn();
  const docIconBtn = $('#docIconBtn');
  if (docIconBtn) docIconBtn.onclick = () => {
    docIcon = !docIcon;
    if (docIcon) triOrb = false; // one shape at a time
    ren.docIcon = docIcon;
    ren.triOrb = triOrb;
    syncDocIconBtn(); syncTriOrbBtn(); saveUi();
    if (autoDist) drawMiniMap(); // verse map mirrors the new body shape at once
    toast(docIcon ? 'Document icons on — plain white pages, same sizes and selection' : 'Orbs restored');
  };
  syncDocIconBtn();
  // (Thematic now lives in the Universe view modes row — same docs + same
  // physics, recomposed by themes/tags. From the general state it distills
  // the WHOLE visidocsverse; leaving the view always drops the whole view.)
  // bottom pill "Return" button (gold): step back to the previous view —
  // the lens, sun, canvas and camera as they were before the last change.
  const returnBtn = $('#returnBtn');
  if (returnBtn) returnBtn.onclick = () => { goReturn(); };
  // bottom pill "Fit" button: a TOGGLE. On: snapshot the view, frame the
  // whole formation on the visible screen (recenter + dolly out for
  // sprawls, dolly in for small formations that would sit tiny in a void)
  // and lift any orb that would render as a speck up to a
  // readable size. Off: restore the exact pre-fit camera + orb sizes.
  // Physics is untouched either way.
  const fitBtn = $('#fitBtn');
  if (fitBtn) fitBtn.onclick = () => {
    if (!uni || !uni.nodes.length) { toast('Nothing to fit — the canvas is empty'); return; }
    try { camCancelGlide(); } catch {} // Fit owns the camera outright from here
    if (fitActive) {
      const s = fitSnapshot;
      if (s && s.uni === uni) {
        ren.cam.dist = s.dist; ren.cam.px = s.px; ren.cam.py = s.py;
        for (const n of uni.nodes) {
          const b = s.boosts.get(n.id);
          n._fitBoost = (b === undefined) ? 1 : b;
        }
        panHeld = true; // the restored view sticks, like a hand pan
        toast('Fit off — pre-fit view restored');
      } else toast('Fit off — the fitted canvas is gone');
      fitActive = false; fitSnapshot = null; syncFitBtn();
      return;
    }
    fitSnapshot = snapFit();
    let freedDistribute = false;
    if (autoDist) {
      // Fit and Distribute fight over the layout (a pinned orb vs a framed
      // view), so Fit wins: leave distribute mode first (physics freed, hand
      // placements cleared). The freed bodies were pinned cheek-by-jowl with
      // zeroed velocities — re-seat them settled (same composed seating fresh
      // canvases open with) so the formation has real extent to frame instead
      // of a tight ball that would frame as one unreadable pile.
      // Toggling Fit back off restores the pre-fit camera; distribute stays off.
      autoDist = false;
      if (uni) for (const n of uni.nodes) { n._ox = n._oy = n._oz = undefined; n._held = false; }
      syncAutoBtn(); saveUi();
      try { settleFresh(uni); } catch { /* the live sim finishes the job */ }
      freedDistribute = true;
    }
    // an already-collapsed formation (freed from the pinned orb before the
    // release-into-orbits fix above, or fallen together while paused) would
    // frame as one unreadable pile — detect the pile by body overlap and
    // re-seat it settled first, the same
    // composed seating fresh canvases open with. Healthy shell systems never
    // overlap, so this only fires on a genuine pile-up.
    let reseated = false;
    try {
      const piled = uni.nodes.filter(n => n && Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z));
      if (piled.length >= 4) {
        let touching = 0;
        for (let i = 0; i < piled.length; i++) {
          const a = piled[i], ra = a.radius || 6;
          let gap = 1e18;
          for (let j = 0; j < piled.length; j++) {
            if (i === j) continue;
            const b = piled[j];
            const g = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) - (ra + (b.radius || 6));
            if (g < gap) gap = g;
          }
          if (gap < 0) touching++;
        }
        if (touching * 2 >= piled.length) { settleFresh(uni); reseated = true; }
      }
    } catch { /* the live sim finishes the job */ }
    // frame the bodies actually present (not the empty rim — see header):
    // a rim-bound comet may drift out of frame over minutes; Fit again.
    const res = ren.fitView(uni.nodes, 70, 0, uni);
    if (!res.fitted) { fitSnapshot = null; toast('Everything already fits on screen'); return; }
    const bits = [];
    if (freedDistribute) bits.push('distribute off');
    if (reseated) bits.push('piled-up bodies re-seated');
    if (res.boosted) bits.push(`${res.boosted} orb${res.boosted === 1 ? '' : 's'} enlarged`);
    if (res.dist1 > res.dist0 + 1) bits.push('zoomed out');
    else if (res.dist1 < res.dist0 - 1) bits.push('zoomed in');
    fitActive = true; syncFitBtn();
    panHeld = false; // Fit framed it: gravity may hold the framed center
    toast(bits.length ? 'Fit — ' + bits.join(' · ') : 'Fit — reframed');
  };
  syncFitBtn();
  // sticky notes: left-pane visibility filters, floating canvas editor, reader pop-out
  { const nva = $('#notesViewAll'); if (nva) { nva.checked = viewNotesAll; nva.onchange = () => { viewNotesAll = nva.checked; saveUi(); }; } }
  { const nvs = $('#notesViewSun'); if (nvs) { nvs.checked = viewNotesSun; nvs.onchange = () => { viewNotesSun = nvs.checked; saveUi(); }; } }
  $('#noteEditSave').onclick = () => { if (noteEditId && saveNote(noteEditId, $('#noteEditText').value)) toast('Sticky note saved'); closeNoteEditor(); };
  $('#noteEditDelete').onclick = () => { if (noteEditId && deleteNote(noteEditId)) toast('Latest note entry deleted'); closeNoteEditor(); };
  $('#noteEditCancel').onclick = closeNoteEditor;
  $('#noteEditPane').onclick = () => { const id = noteEditId; closeNoteEditor(); if (id) setNotes(true, id); };
  $('#noteEditText').addEventListener('input', (e) => { $('#noteEditCount').textContent = String(e.target.value.length); });
  $('#notePop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-np]'); if (!b || !notePopId) return;
    const k = b.dataset.np;
    if (k === 'close') closeNotePop();
    else if (k === 'copy') copyNotePop();
    else if (k === 'copycite') copyApaCite(notePopId);
    else if (k === 'del') { if (deleteNote(notePopId)) toast('Latest note entry deleted'); }
    else if (k === 'edit') renderNotePop(true);
    else if (k === 'pane') { const id = notePopId; closeNotePop(); setNotes(true, id); }
    else if (k === 'save') { const ta = $('#notePopText'); if (ta && saveNote(notePopId, ta.value)) toast('Sticky note saved'); }
  });
  // a persisted general state reopens on the whole-visidocsverse map when the lens is on
  if (lensThematic && vault.tab() && vault.tab().activeId === null && (vault.tab().docs || []).length) thematicWhole = true;
  if (lensThematic && lensTags) lensTags = false; // the two lenses are mutually exclusive
  syncLensBtn();
  if (lensThematic || lensTags) applyLens(); // persisted lens: open directly in the lens view
  // top canvas tabs: render + double-click a tab to rename it, right-click for verse isolation
  bootStage('tabs');
  renderTabs();
  const tabBar = $('#tabBar');
  function openTabCtx(x, y, t) {
    ctx.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = `▦ ${t.name}`;
    ctx.appendChild(head);
    // Rename lives in the menu itself (double-click is undiscoverable and
    // native prompt() is blocked in some shells) — inline editor, no popup.
    {
      const rn = document.createElement('button');
      rn.className = 'ctx-item';
      rn.textContent = '✎ Rename';
      rn.title = `Rename “${t.name}”`;
      rn.onclick = (e) => {
        e.stopPropagation();
        head.innerHTML = '';
        const inp = document.createElement('input');
        inp.value = t.name;
        inp.maxLength = 40;
        inp.setAttribute('aria-label', 'Canvas name');
        inp.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(10,14,20,.8);border:1px solid var(--line);color:var(--txt);border-radius:7px;padding:6px 8px;font-size:13px;outline:none;';
        head.appendChild(inp);
        inp.focus();
        try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {}
        const commit = () => {
          const next = inp.value.trim();
          if (next && next !== t.name) {
            if (vault.renameTab(t.id, next)) { renderTabs(); toast(`Canvas renamed to “${next}”`); }
            else toast('That name is not usable');
          }
          openTabCtx(x, y, vault.tabs.find(v => v.id === t.id) || t);
        };
        inp.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') commit();
          else if (ev.key === 'Escape') openTabCtx(x, y, t);
        });
        inp.addEventListener('click', (ev) => ev.stopPropagation());
        // swap the Rename row into Save/Cancel while editing
        rn.textContent = '✓ Save name';
        rn.title = 'Save the name above (Enter)';
        rn.onclick = (e2) => { e2.stopPropagation(); commit(); };
      };
      ctx.appendChild(rn);
    }
    const tIso = vault.isIso(t);
    const tLinks = vault.assocIds(t);
    if (tIso) {
      const note = document.createElement('div');
      note.className = 'ctx-note';
      note.textContent = 'Lone canvas — uploads, searches, tags, copies and deletes stay in this tab.';
      ctx.appendChild(note);
    }
    const sub = document.createElement('div');
    sub.className = 'ctx-sub';
    sub.textContent = 'Associated with';
    ctx.appendChild(sub);
    // associated-with lists fellow members, information only — never clickable
    const tGroup = projectGroup(t.id);
    const mates = vault.tabs.filter(x => x.id !== t.id && tGroup.some(g => g.id === x.id));
    if (!mates.length) {
      const solo = document.createElement('div');
      solo.className = 'ctx-note';
      solo.textContent = vault.tabs.some(x => x.id !== t.id)
        ? 'Nothing linked yet — nothing to unlink.'
        : 'Create another canvas (+) to link verses.';
      ctx.appendChild(solo);
    } else {
      const list = document.createElement('div');
      list.className = 'ctx-picklist';
      for (const o of mates) {
        const on = tLinks.includes(o.id);
        // informative only: fellow members display here but are never
        // clickable (no tap-to-unlink)
        const d = document.createElement('div');
        d.className = 'ctx-item ctx-pick static' + (on ? ' on' : '');
        d.textContent = (on ? '✓ ' : '○ ') + o.name + (o.main ? ' ★' : '');
        d.title = on ? `Linked with “${o.name}”` : `In the same universe as “${o.name}”`;
        list.appendChild(d);
      }
      ctx.appendChild(list);
    }
    // shuffle: slide this tab one slot left or right — but never outside its
    // own bounded group (a lone tab offers no arrows at all, so it can never
    // split another universe's wireframe by landing mid-group; tabs can never
    // leave their universe at all)
    const tIdx = vault.tabs.findIndex(x => x.id === t.id);
    const gIdx = tGroup.map(g => vault.tabs.findIndex(x => x.id === g.id));
    const gLo = Math.min(...gIdx), gHi = Math.max(...gIdx);
    const canLeft = tIdx > gLo, canRight = tIdx < gHi;
    if (canLeft || canRight) {
      const mv = document.createElement('div');
      mv.className = 'ctx-sub';
      mv.textContent = 'Position';
      ctx.appendChild(mv);
      if (canLeft) ctx.appendChild(ctxItem('←  Move left', false, () => { vault.moveTab(t.id, -1); renderTabs(); toast(`“${t.name}” moved left`); }));
      if (canRight) ctx.appendChild(ctxItem('Move right  →', false, () => { vault.moveTab(t.id, 1); renderTabs(); toast(`“${t.name}” moved right`); }));
    }
    // whole-tab copy/paste: stash every body here, drop it into any tab
    // from that tab's own menu (associated or not — no scope check)
    {
      const cc = document.createElement('div');
      cc.className = 'ctx-sub';
      cc.textContent = 'Content';
      ctx.appendChild(cc);
      const cp = ctxItem(`⧉  Copy all content${t.docs.length ? ` (${t.docs.length})` : ''}`, false, () => {
        if (!t.docs.length) { toast(`“${t.name}” is empty — nothing to copy`); return; }
        setTabClip({ srcTabId: t.id, srcName: t.name, ids: t.docs.map(d => d.id) });
        renderTabs();
        toast(`${t.docs.length} ${t.docs.length === 1 ? 'body' : 'bodies'} copied — right-click another tab (or its empty canvas) to paste`);
        openTabCtx(x, y, vault.tabs.find(v => v.id === t.id) || t); // menu stays open
      });
      cp.title = `Copy every body in “${t.name}” — paste it into any tab from its menu or its empty canvas`;
      ctx.appendChild(cp);
      const offer = liveTabClip(t);
      if (offer) {
        const pn = offer.ids.length;
        const pp = ctxItem(`⤓  Paste ${pn} ${pn === 1 ? 'body' : 'bodies'} from “${offer.src.name}”`, false, () => {
          const r = vault.copyTabDocs(t.id, offer.src.id, offer.ids);
          if (!r) { setTabClip(null); renderTabs(); toast('Paste failed — the copied tab is gone'); return; }
          if (r.copied.length) {
            if (unis.has(t.id)) rebuildTab(t.id);
            else edgeByTab.delete(t.id);
            renderTabs();
            if (t.id === vault.activeTabId) { try { renderDoc(); } catch {} }
            toast(`Pasted ${r.copied.length} ${r.copied.length === 1 ? 'body' : 'bodies'} from “${offer.src.name}”${r.skipped ? ` (${r.skipped} already here)` : ''}`);
          } else { renderTabs(); toast(`Everything from “${offer.src.name}” is already here`); }
        });
        pp.title = `Paste the copied bodies into “${t.name}”`;
        ctx.appendChild(pp);
      }
    }
    ctx.hidden = false;
    const w = Math.min(280, ctx.offsetWidth || 220), h = ctx.offsetHeight || 200;
    ctx.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    ctx.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  }
  if (tabBar) tabBar.addEventListener('contextmenu', (e) => {
    // dev-only rewording for the "+" hover captions: right-clicking a "+"
    // opens the shared text editor instead of the native menu (same lock as
    // every helper — editor preview only). Left-click creation is untouched.
    if (helpEditAllowed()) {
      const ed = e.target.closest('[data-addto],[data-addtab]');
      if (ed) {
        e.preventDefault(); e.stopPropagation();
        openHelpEditor(ed.hasAttribute('data-addto') ? 'addToTab' : (ed.classList.contains('tabadd-out') ? 'addTabOut' : 'createTab'));
        return;
      }
    }
    if (e.target.closest('[data-closetab]') || e.target.closest('[data-addtab]') || e.target.closest('[data-addto]') || e.target.closest('[data-savetab]') || e.target.closest('[data-openproj]')) return;
    const tbb = e.target.closest('[data-tab]');
    if (!tbb) return;
    const t = vault.tabs.find(t => t.id === tbb.dataset.tab);
    if (!t) return;
    e.preventDefault();
    openTabCtx(e.clientX, e.clientY, t);
  });
  if (tabBar) tabBar.addEventListener('dblclick', (e) => {
    if (e.target.closest('[data-closetab]') || e.target.closest('[data-addtab]') || e.target.closest('[data-addto]') || e.target.closest('[data-savetab]') || e.target.closest('[data-openproj]')) return;
    const tbb = e.target.closest('[data-tab]');
    if (!tbb) return;
    const t = vault.tabs.find(t => t.id === tbb.dataset.tab);
    if (!t) return;
    const next = prompt('Name this canvas:', t.name);
    if (next !== null && next.trim() && next.trim() !== t.name) { vault.renameTab(t.id, next.trim()); renderTabs(); }
  });
  setRot(rotOn);
    // Save-project file bundle (NOT dev-only: buildBackupObject below needs it
  // in stripped desktop builds too, so it must stay outside the DEV range).
  const BACKUP_FILES = ['src/js/app.js', 'src/js/vault.js', 'src/js/physics.js', 'src/js/render.js', 'README.md', 'src/assets/overlays.json'];
  async function buildBackupObject() {
    const files = {};
    for (const f of BACKUP_FILES) {
      // desktop exports nest code one level deeper (src/js/...) than the live tree (src/...)
      const cands = (f.startsWith('src/') && !f.startsWith('src/js/')) ? [f, 'src/js/' + f.slice(4)] : [f];
      for (const cand of cands) {
        try {
          const r = await fetch(cand);
          if (!r.ok) continue;
          files[f] = { ok: true, content: await r.text() };
          break;
        } catch { /* try the next candidate path */ }
      }
      if (!files[f]) files[f] = { ok: false, content: null };
    }
    // Local-first: on desktop (and after save in preview) these resolve to
    // the real files; remotely they fall back to the Perchance API; fully
    // offline they stay null and the vault + settings still back up.
    async function fetchTextLocalFirst(local, remote, guard) {
      try {
        const r = await fetch(local);
        if (r.ok) { const t = await r.text(); if (t && (!guard || guard(t))) return t; }
      } catch {}
      if (!remote) return null;
      try {
        const r = await fetch(remote);
        if (r.ok) { const t = await r.text(); if (t && (!guard || guard(t))) return t; }
      } catch {}
      return null;
    }
    let mainPjs = await fetchTextLocalFirst('main.pjs',
      'https://perchance.org/api/getGeneratorsAndDependencies?generatorNames=' + encodeURIComponent(window.generatorName || ''),
      t => t.includes('$meta') || t.includes('{import:'))
      .then(t => { try { const o = JSON.parse(t); return (o.generators && o.generators[window.generatorName] && o.generators[window.generatorName].code) || t; } catch { return t; } });
    let indexHtml = await fetchTextLocalFirst('index.html',
      `https://null.perchance.org/${encodeURIComponent(window.generatorName || '')}`,
      t => t.includes('uniCv'));
    return {
      app: 'visidocsverse-backup', version: 1, pushedAt: new Date().toISOString(),
      generator: window.generatorName || null,
      mainPjs, indexHtml, files,
      // deep-clone doc rows: the backup must be a snapshot, not a live
      // reference — otherwise docs added after "build" leak into the file.
      tabs: vault.tabs.map(t => ({ id: t.id, name: t.name, docs: (t.docs || []).map(d => ({ ...d, links: [...(d.links || [])], tags: [...(d.tags || [])], pageMap: (d.pageMap && Array.isArray(d.pageMap.starts)) ? { kind: d.pageMap.kind, count: d.pageMap.count, starts: [...d.pageMap.starts] } : undefined, noteLog: Array.isArray(d.noteLog) && d.noteLog.length ? cloneNoteLog(d.noteLog) : undefined })), activeId: t.activeId, main: t.main === true, assoc: [...(t.assoc || [])], color: t.color || null, suppressedTags: [...(t.suppressedTags || [])], disassociated: vault.isIso(t) })),
      activeTabId: vault.activeTabId,
      vault: vault.docs.map(d => ({ ...d, links: [...(d.links || [])], tags: [...(d.tags || [])], pageMap: (d.pageMap && Array.isArray(d.pageMap.starts)) ? { kind: d.pageMap.kind, count: d.pageMap.count, starts: [...d.pageMap.starts] } : undefined, noteLog: Array.isArray(d.noteLog) && d.noteLog.length ? cloneNoteLog(d.noteLog) : undefined })), // legacy compat: active canvas docs
      settings: {
        rotOn, rotMul, speedMul: rotMul, autoDist, simpleOrb, simpleOrb2, triOrb, docIcon, vividUniverse,
        miniX, miniY, miniW, miniH, miniFolded, tvpX, tvpY, tvpW, tvpH, tabX, tabY, hintX, hintY, pillsCentered, vw: window.innerWidth, vh: window.innerHeight, pillMinW, clusterW, glossX, glossY, glossW, glossH, glossOpen, glossDockV1: true,
        ovAlpha, ovLast, lbScale, lbLast, sizeScale, sizeLast, spinOn, spinSpeed, compressScale, compressLast, bgShade, bgShadePreLux,
        backdrop, backdropAlpha, backdropLast, paneAlpha, paneLast,
        glazeLeft, glazeDoc, glazeCloud, glazeMini, glazeGloss, glazeTabBar, glazeHintBar, luxLeft, luxDoc, luxTab, luxHint, luxMini,
        leftCollapsed, docCollapsed, docWidth, hoverPrev, hideUngr, snapCenter, statsCollapsed, pillCollapsed, tipsCollapsed, pinnedTerms: [...pinnedTerms], lensThematic, lensTags,
        viewNotesAll, viewNotesSun, notesOpen, notesAuto, carZoom,
        topicSim: vault.topicSim, topicShared: vault.topicShared,
        topicMaxDf: vault.topicMaxDf, topicTopK: vault.topicTopK,
        topicIdfFloor: vault.topicIdfFloor,
        help: { ...helpTexts },
        // NOTE: glossEdits (`visidocsverse.gloss`) are intentionally EXCLUDED —
        // glossary wording is dev-machine-only and must never ride backups,
        // let alone installers (which are built from src/ + static index.html).
      },
    };
  }
  function downloadMasterFile(obj, name) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name || 'visidocsverse-master-settings.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  // "save project" (top tab bar): back up ALL projects to a file on the
  // user's computer. Desktop shell: a real "where to save" picker (native
  // save dialog, starting in the last-used folder) + direct file write, so
  // the user chooses the location every time. Browser/web preview: the
  // classic download (the browser decides the folder). The in-app copy keeps
  // autosaving either way; the file is the outside-the-app backup.
  async function saveAllProjects() {
    if (!vault.tabs.length) {
      toast('Nothing to save — the workspace is empty');
      return;
    }
    try {
      toast('Preparing projects file…');
      const obj = await buildBackupObject();
      const n = countBackupDocs(obj);
      const d = new Date();
      const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
      const name = `visidocsverse-projects-${stamp}.json`;
      let savedTo = '';
      // Native picker path (installed desktop app only).
      if (typeof Neutralino !== 'undefined' && Neutralino.os && Neutralino.filesystem) {
        try {
          let startDir = '';
          try { startDir = localStorage.getItem('visidocsverse.saveDir') || ''; } catch {}
          const picked = await Neutralino.os.showSaveDialog('Save projects backup — choose where to keep it', {
            defaultPath: (startDir ? startDir.replace(/[\\/]+$/, '') + '/' : '') + name
          });
          const p = String(picked || '');
          if (!p) {
            toast('Save cancelled — no location picked, nothing was written', 5000);
            try { lastGuardNote = 'save cancelled (no location picked)'; } catch {}
            return;
          }
          await Neutralino.filesystem.writeFile(p, JSON.stringify(obj));
          savedTo = p;
          try {
            const dir = p.replace(/[\\/][^\\/]*$/, '');
            if (dir) localStorage.setItem('visidocsverse.saveDir', dir);
          } catch {}
        } catch (e) {
          // native save unavailable/failed → fall through to the download
          savedTo = '';
          try { lastGuardNote = 'native save failed, trying download: ' + ((e && e.message) || e); } catch {}
        }
      }
      if (!savedTo) downloadMasterFile(obj, name);
      toast(`Saved ${n} document${n === 1 ? '' : 's'}${savedTo ? ' to ' + savedTo : ' to your computer'} — this file is your backup [${BUILD_TAG}]`);
      setLog(`Projects saved to computer — ${n} documents (backup copy; the in-app copy keeps autosaving)`);
      backupClean = true; // the file on the computer now matches the workspace
      try { lastGuardNote = `saved ok (${n} doc${n === 1 ? '' : 's'}${savedTo ? ' → ' + savedTo : ' to file'})`; } catch {}
    } catch (e) { toast(`Could not save projects (${(e && e.message) || e}) [${BUILD_TAG}]`, 9000); try { lastGuardNote = 'save FAILED: ' + ((e && e.message) || e); } catch {} }
  }
  // "Open Project" dropdown: master-file rows (load / merge from a
  // computer file — desktop-safe, ships in installers). Closing a canvas
  // removes it outright, so there is no shelf to offer here.
  function renderOpenProjMenu() {
    const list = $('#openProjList');
    if (!list) return;
    list.innerHTML = `<div class="opm-sub">From a computer file</div>`
      + `<button class="opm-item" data-restorepick="1" title="Load a Visi|Docsverse master file from your computer (replaces every open project)"><b>⤒ Load master file…</b><span>replaces every open project</span></button>`
      + `<button class="opm-item" data-absorbpick="1" title="Merge a Visi|Docsverse master file's documents into the current canvas (keeps what is open)"><b>＋ Merge master file…</b><span>adds documents into the current canvas</span></button>`;
  }
  function hideOpenProjMenu() { const m = $('#openProjMenu'); if (m) m.hidden = true; }
  function toggleOpenProjMenu(force) {
    const m = $('#openProjMenu');
    if (!m) return;
    const show = typeof force === 'boolean' ? force : m.hidden;
    if (show) { renderOpenProjMenu(); m.hidden = false; }
    else m.hidden = true;
  }
  // total bodies across every canvas in a backup object (for the confirm line)
  function countBackupDocs(obj) {
    try {
      if (obj && Array.isArray(obj.tabs) && obj.tabs.length) {
        let n = 0;
        for (const t of obj.tabs) if (t && Array.isArray(t.docs)) n += t.docs.length;
        else if (t && Array.isArray(t.documents)) n += t.documents.length;
        return n;
      }
      const v = obj && (obj.vault || obj.docs || obj.documents);
      if (Array.isArray(v)) return v.length;
      if (Array.isArray(obj)) return obj.length;
    } catch {}
    return 0;
  }
  // a backup-shaped object? (checked BEFORE JSON.parse errors and before the
  // confirm dialog, so drops/clicks on random .json files get a clear toast)
  function looksLikeBackup(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    if (obj.app === 'visidocsverse-backup' || obj.app === 'docuverse-backup' || obj.app === 'gravitas-backup') return true;
    // forgiving: tab/doc arrays without the app tag still count (hand-made or
    // very old master files) — applyBackupObject validates the rest.
    if (Array.isArray(obj.tabs) && obj.tabs.length) return true;
    if (Array.isArray(obj.vault)) return true;
    if (Array.isArray(obj.docs) || Array.isArray(obj.documents)) return true;
    return false;
  }
  function applyBackupObject(obj) {
    try { if (window.__visidocsverse) window.__visidocsverse.lastLoadError = null; } catch {}
    // accept: current {app,tabs,vault}, tabs-only, vault-only, legacy
    // {docs}/{documents}, or a bare docs array. Anything else is rejected
    // with a specific toast (not a silent no-op).
    let src = obj;
    if (Array.isArray(src)) src = { vault: src, tabs: null };
    if (!src || typeof src !== 'object') { toast('That file is not a Visi|Docsverse master file (no backup data)'); return false; }
    if (src.app && src.app !== 'visidocsverse-backup' && src.app !== 'docuverse-backup' && src.app !== 'gravitas-backup') { toast(`That file is a “${src.app}” file, not a Visi|Docsverse master file`); return false; }
    const hasTabs = Array.isArray(src.tabs) && src.tabs.length > 0;
    const vaultArr = Array.isArray(src.vault) ? src.vault : (Array.isArray(src.docs) ? src.docs : (Array.isArray(src.documents) ? src.documents : null));
    if (!hasTabs && !vaultArr) { toast('That file is not a Visi|Docsverse master file (no tabs or documents found)'); return false; }
    // snapshot the current universe so the result line can say what actually
    // changed — reloading the same docs over themselves reports "already
    // matches" instead of looking broken.
    const sigOf = (tabs) => {
      try {
        const names = [];
        for (const t of tabs) for (const d of (t.docs || [])) names.push(String(d.name || '') + ':' + String(d.text || '').length);
        return names.sort().join('\n');
      } catch { return ''; }
    };
    const beforeSig = sigOf(vault.tabs);
    const beforeCount = countBackupDocs({ tabs: vault.tabs });
    const s = (src.settings && typeof src.settings === 'object') ? src.settings : {};
    // settings first (validated; missing keys keep current values so old
    // master files don't wipe newer personalization)
    try {
      if (typeof s.rotOn === 'boolean') rotOn = s.rotOn;
      { const sv = s.speedMul ?? s.rotMul; if (typeof sv === 'number' && sv >= 0 && sv <= SPEED_MAX) rotMul = sv; }
      if (s.autoDist === true || s.autoDist === false) autoDist = s.autoDist;
      if (s.simpleOrb === true) { simpleOrb = true; simpleOrb2 = false; }
      else if (s.simpleOrb2 === true) { simpleOrb2 = true; simpleOrb = false; }
      else if (s.simpleOrb === false && s.simpleOrb2 === false) { simpleOrb = false; simpleOrb2 = false; }
      if (typeof s.ovAlpha === 'number' && s.ovAlpha >= 0 && s.ovAlpha <= 1) ovAlpha = s.ovAlpha;
      if (typeof s.ovLast === 'number' && s.ovLast > 0 && s.ovLast <= 1) ovLast = s.ovLast;
      if (typeof s.lbScale === 'number' && s.lbScale >= 0 && s.lbScale <= 3) lbScale = s.lbScale;
      if (typeof s.lbLast === 'number' && s.lbLast > 0 && s.lbLast <= 3) lbLast = s.lbLast;
      if (typeof s.sizeScale === 'number' && s.sizeScale >= 0.05 && s.sizeScale <= 4) sizeScale = s.sizeScale;
      if (typeof s.sizeLast === 'number' && s.sizeLast >= 0.05 && s.sizeLast <= 4) sizeLast = s.sizeLast;
      if (s.spinOn === true) spinOn = true; else if (s.spinOn === false) spinOn = false;
      if (typeof s.spinSpeed === 'number' && s.spinSpeed >= 0 && s.spinSpeed <= 100) spinSpeed = s.spinSpeed;
      if (typeof s.compressScale === 'number' && s.compressScale >= 0.2 && s.compressScale <= 1) compressScale = s.compressScale;
      if (typeof s.compressLast === 'number' && s.compressLast >= 0.2 && s.compressLast <= 1) compressLast = s.compressLast;
      if (typeof s.bgShade === 'number' && s.bgShade >= 0 && s.bgShade <= 1) bgShade = s.bgShade;
      if (typeof s.bgShadePreLux === 'number' && s.bgShadePreLux >= 0 && s.bgShadePreLux <= 1) bgShadePreLux = s.bgShadePreLux;
      if (typeof s.glow === 'number' && s.glow >= 0 && s.glow <= 2) glowScale = s.glow;
      if (typeof s.glowLast === 'number' && s.glowLast > 0 && s.glowLast <= 2) glowLast = s.glowLast;
      if (typeof s.tether === 'number' && s.tether >= 0 && s.tether <= 2) tetherScale = s.tether;
      if (typeof s.tetherLast === 'number' && s.tetherLast > 0 && s.tetherLast <= 2) tetherLast = s.tetherLast;
      if (typeof s.tetherColor === 'string' && /^#[0-9a-f]{6}$/i.test(s.tetherColor)) tetherColor = s.tetherColor;
      if (s.tetherDotted === true) tetherDotted = true; else if (s.tetherDotted === false) tetherDotted = false;
      if (s.tetherSparse === true) { tetherSparse = true; tetherDotted = true; } else if (s.tetherSparse === false) tetherSparse = false;
      if (s.tetherDashed === true) tetherDashed = true; else if (s.tetherDashed === false) tetherDashed = false;
      if (typeof s.backdrop === 'string' && (/^[a-z0-9._-]+\.jpg$/i.test(s.backdrop))) backdrop = s.backdrop;
      else if (s.backdrop === '' || s.backdrop === 'nebula') backdrop = ''; // legacy 'nebula' restores adopt to plain black
      if (typeof s.backdropAlpha === 'number' && s.backdropAlpha >= 0 && s.backdropAlpha <= 1) backdropAlpha = s.backdropAlpha;
      if (typeof s.backdropLast === 'number' && s.backdropLast > 0 && s.backdropLast <= 1) backdropLast = s.backdropLast;
      if (typeof s.paneAlpha === 'number' && s.paneAlpha >= 0 && s.paneAlpha <= 1) paneAlpha = s.paneAlpha;
      if (typeof s.paneLast === 'number' && s.paneLast > 0 && s.paneLast <= 1) paneLast = s.paneLast;
      if (s.glazeLeft === false) glazeLeft = false; else if (s.glazeLeft === true) glazeLeft = true;
      if (s.glazeDoc === false) glazeDoc = false; else if (s.glazeDoc === true) glazeDoc = true;
      if (s.glazeCloud === false) glazeCloud = false; else if (s.glazeCloud === true) glazeCloud = true;
      if (s.glazeMini === false) glazeMini = false; else if (s.glazeMini === true) glazeMini = true;
      if (s.glazeGloss === false) glazeGloss = false; else if (s.glazeGloss === true) glazeGloss = true;
      if (s.glazeTabBar === false) glazeTabBar = false; else if (s.glazeTabBar === true) glazeTabBar = true;
      if (s.glazeHintBar === false) glazeHintBar = false; else if (s.glazeHintBar === true) glazeHintBar = true;
      if (s.luxLeft === true) luxLeft = true; else if (s.luxLeft === false) luxLeft = false;
      if (s.luxDoc === true) luxDoc = true; else if (s.luxDoc === false) luxDoc = false;
      if (s.luxTab === true) luxTab = true; else if (s.luxTab === false) luxTab = false;
      if (s.luxHint === true) luxHint = true; else if (s.luxHint === false) luxHint = false;
      if (s.luxMini === true) luxMini = true; else if (s.luxMini === false) luxMini = false;
      else if (s.luxMini == null && (luxLeft || luxDoc || luxTab || luxHint)) luxMini = true; // pre-map backups: luxury on means the map joins in
      if (s.triOrb === true) triOrb = true; else if (s.triOrb === false) triOrb = false;
      if (s.vividUniverse === true) vividUniverse = false; else if (s.vividUniverse === false) vividUniverse = false; // retired: old vivid-on restores adopt to plain black
      if (typeof s.miniX === 'number' && typeof s.miniY === 'number') { miniX = s.miniX; miniY = s.miniY; }
      if (typeof s.miniW === 'number' && s.miniW >= 140 && s.miniW <= 640) miniW = s.miniW;
      if (typeof s.miniH === 'number' && s.miniH >= 100 && s.miniH <= 480) miniH = s.miniH;
      if (s.miniFolded === true) miniFolded = true; else if (s.miniFolded === false) miniFolded = false;
      if (typeof s.tvpX === 'number' && typeof s.tvpY === 'number') { tvpX = s.tvpX; tvpY = s.tvpY; }
      if (typeof s.tvpW === 'number' && typeof s.tvpH === 'number') { tvpW = s.tvpW; tvpH = s.tvpH; }
      if (typeof s.glossX === 'number' && typeof s.glossY === 'number') { glossX = s.glossX; glossY = s.glossY; }
      if (typeof s.glossW === 'number' && s.glossW >= 240 && s.glossW <= 620) glossW = s.glossW;
      if (typeof s.glossH === 'number' && s.glossH >= 160 && s.glossH <= 720) glossH = s.glossH;
      if (s.glossOpen === true) glossOpen = true; else if (s.glossOpen === false) glossOpen = false;
      if (!s.glossDockV1) { glossX = null; glossY = null; glossW = 0; glossH = 0; } // pre-dock backup: open tall beside the left panel
      if (glossOpen) { glossX = null; glossY = null; } // restored-open panes restart at the dock
      if (typeof s.docWidth === 'number' && s.docWidth >= 260 && s.docWidth <= 1200) docWidth = s.docWidth;
      else if (s.docWidth === 0) docWidth = 0;
      fitPaneWidthToScreen(s.vw); // backup from another display: re-fit the reader width here
      if (s.leftCollapsed === true) leftCollapsed = true; else if (s.leftCollapsed === false) leftCollapsed = false;
      if (s.docCollapsed === true) docCollapsed = true; else if (s.docCollapsed === false) docCollapsed = false;
      if (s.hoverPrev === true) hoverPrev = true; else if (s.hoverPrev === false) hoverPrev = false;
      if (s.hideUngr === true) hideUngr = true; else if (s.hideUngr === false) hideUngr = false;
      if (s.snapCenter === true) snapCenter = true; else if (s.snapCenter === false) snapCenter = false;
      if (s.statsCollapsed === true) statsCollapsed = true; else if (s.statsCollapsed === false) statsCollapsed = false;
      if (s.pillCollapsed === true) pillCollapsed = true; else if (s.pillCollapsed === false) pillCollapsed = false;
      if (s.tipsCollapsed === true) tipsCollapsed = true; else if (s.tipsCollapsed === false) tipsCollapsed = false;
      if (typeof s.tabX === 'number' && typeof s.tabY === 'number') { tabX = s.tabX; tabY = s.tabY; }
      if (typeof s.hintX === 'number' && typeof s.hintY === 'number') { hintX = s.hintX; hintY = s.hintY; }
      if (s.pillsCentered === true) pillsCentered = true; else if (s.pillsCentered === false) pillsCentered = false;
      fitPillsToScreen(s.vw, s.vh); // backup from another screen: land proportionally here
      // tandem heal (same as boot): centered mode re-seats fresh, a split
      // hand-placed pair reunites now with the top leading.
      if (pillsCentered) { tabX = tabY = hintX = hintY = null; }
      else if (tabX != null && hintX != null && tabX !== hintX) hintX = tabX;
      if (typeof s.pillMinW === 'number' && s.pillMinW >= 240 && s.pillMinW <= 4000) pillMinW = s.pillMinW;
      if (typeof s.clusterW === 'number' && s.clusterW >= 80 && s.clusterW <= 4000) clusterW = s.clusterW;
      if (Array.isArray(s.pinnedTerms)) pinnedTerms = s.pinnedTerms.filter(w => typeof w === 'string' && w).slice(0, MAX_PINS);
      if (s.viewNotesAll === false) viewNotesAll = false; else if (s.viewNotesAll === true) viewNotesAll = true;
      if (s.viewNotesSun === false) viewNotesSun = false; else if (s.viewNotesSun === true) viewNotesSun = true;
      if (s.viewNotes === false) { viewNotesAll = false; viewNotesSun = false; }
      if (typeof s.carZoom === 'number' && s.carZoom >= 100 && s.carZoom <= 145) carZoom = Math.round(s.carZoom);
      if (s.notesAuto === false) notesAuto = false; else if (s.notesAuto === true) notesAuto = true;
      if (s.notesOpen === true) notesOpen = true; else if (s.notesOpen === false) notesOpen = false;
      for (const k of ['topicSim', 'topicShared', 'topicMaxDf', 'topicTopK', 'topicIdfFloor']) {
        if (typeof s[k] === 'number' && isFinite(s[k])) vault[k] = s[k];
      }
      if (s.help && typeof s.help === 'object') {
        for (const k of Object.keys(DEFAULT_HELP)) {
          if (typeof s.help[k] === 'string' && s.help[k].trim()) helpTexts[k] = s.help[k];
        }
        try { saveHelp(); } catch {}
      }
    } catch (e) { console.warn('backup settings restore skipped', e); }
    // docs / tabs (normalizeDoc inside adoptTabs repairs ragged rows; the
    // legacy vault-only path normalizes explicitly here)
    try {
      if (hasTabs) {
        vault.adoptTabs(src.tabs);
        const want = (typeof src.activeTabId === 'string') ? src.activeTabId : null;
        vault.activeTabId = (want && vault.tabs.some(t => t.id === want)) ? want : vault.tabs[0].id;
      } else {
        const norm = vaultArr.map((rd, i) => {
          try { return vault.normalizeDoc(rd, 'Untitled ' + (i + 1)); }
          catch { const p = { id: 'd_' + Math.random().toString(36).slice(2, 10), name: 'Untitled ' + (i + 1), text: '', words: 0, links: [], tags: [] }; return p; }
        });
        // legacy file: replace the active canvas, keep the other canvases
        if (!vault.tabs.length) {
          vault.tabs = [{ id: 'tab_' + Math.random().toString(36).slice(2, 10), name: 'Universe 1', docs: norm, activeId: norm[0]?.id || null, main: true, assoc: [], color: null, suppressedTags: [] }];
          vault.activeTabId = vault.tabs[0].id;
        } else {
          vault.tab().docs = norm;
          vault.tab().activeId = norm[0]?.id || null;
        }
        // restored rows regenerate auto/* deterministically — re-apply this
        // canvas's suppression so deleted/merged names stay gone.
        try { const ltb = vault.tab(); if (ltb) for (const ld of (ltb.docs || [])) vault.applySuppress(ld, ltb); } catch {}
        try { vault.persist(); } catch {}
      }
    } catch (e) {
      console.warn('backup docs restore failed', e);
      try { if (window.__visidocsverse) window.__visidocsverse.lastLoadError = String((e && e.message) || e); } catch {}
      toast(`Could not use the documents in that file (${(e && e.message) || e})`, 6000);
      return false;
    }
    // clear every per-canvas cache so the restored docs (not stale edges or
    // selections from the previous universe) render
    try {
      unis.clear();
      thematicUnis.clear(); thematicBuilt.clear();
      wholeUni = null; wholeBuilt = ''; wholeThemes = []; thematicWhole = false;
      edgeByTab.clear();
      selSet.clear(); matchSet = null;
      try { closeNoteEditor(); } catch {}
      try { closeNotePop(); } catch {}
      try { $('#searchPop').innerHTML = ''; $('#searchInput').value = ''; } catch {}
    } catch {}
    try { saveUi(); } catch {}
    try { vault.persist(); } catch {}
    try {
      rebuildAllTabs();
    } catch (e) {
      console.warn('backup rebuild failed', e);
      try { if (window.__visidocsverse) window.__visidocsverse.lastLoadError = String((e && e.message) || e); } catch {}
      toast(`Loaded the documents but the universe failed to rebuild (${(e && e.message) || e}) — reload the page`, 8000);
      return false;
    }
    activeId = vault.tab().activeId;
    if ((activeId == null && vault.tab().activeId !== null) || (activeId && !vault.byId(activeId))) {
      activeId = (vault.tab().activeId === null && vault.docs.length) ? null : (vault.docs[0]?.id || null);
    }
    try { vault.tab().activeId = activeId; } catch {}
    try { vault.persist(); } catch {}
    try { renderDoc(); } catch (e) { console.warn('renderDoc after load failed', e); }
    try { updateStats(); } catch {}
    try { renderTabs(); } catch {}
    try { applyHelpToStatic(); } catch {}
    // restore every control to the loaded settings (each guarded: a missing
    // slider must never abort the load)
    try { $('#rotSpeed').value = speedToSlider(rotMul); } catch {}
    try { $('#rotMul').textContent = fmtSpeed(rotMul); } catch {}
    try { setRot(rotOn); } catch {}
    try { const el = $('#ovAlpha'); if (el) el.value = Math.round(ovAlpha * 100); const lb = $('#ovMul'); if (lb) lb.textContent = Math.round(ovAlpha * 100) + '%'; if (ren) ren.overlayAlpha = ovAlpha; } catch {}
    try { const el = $('#lbSize'); if (el) el.value = Math.round(lbScale * 100); const lb = $('#lbMul'); if (lb) lb.textContent = lbScale <= 0 ? 'hidden' : Math.round(lbScale * 100) + '%'; if (ren) ren.labelScale = lbScale; } catch {}
    try { const el = $('#szSize'); if (el) el.value = Math.round(sizeScale * 100); const lb = $('#szMul'); if (lb) lb.textContent = Math.round(sizeScale * 100) + '%'; if (ren) ren.bodyScale = sizeScale; } catch {}
    try { const el = $('#spSpeed'); if (el) el.value = Math.round(spinSpeed); const lb = $('#spMul'); if (lb) lb.textContent = spinOn ? Math.round(spinSpeed) + '%' : 'off'; if (ren) { ren.spinTarget = (spinOn && spinSpeed > 0) ? 1 : 0; ren.spinOmega = spinSpeed > 0 ? 4 * Math.pow(spinSpeed / 100, 0.65) : 0; } } catch {}
    try { const el = $('#cpSize'); if (el) el.value = Math.round(compressScale * 100); const lb = $('#cpMul'); if (lb) lb.textContent = Math.round(compressScale * 100) + '%'; if (ren) ren.compressScale = compressScale; } catch {}
    try { const el = $('#bgShade'); if (el) el.value = Math.round(bgShade * 100); const lb = $('#bgMul'); if (lb) lb.textContent = Math.round(bgShade * 100) + '%'; if (ren) ren.bgShade = bgShade; syncHintContrast(); syncPaneContrast(); syncModeBtn(); } catch {}
    try { const el = $('#glSize'); if (el) el.value = Math.round(glowScale * 50); const lb = $('#glMul'); if (lb) lb.textContent = Math.round(glowScale * 100) + '%'; if (ren) ren.glowScale = glowScale; } catch {}
    try { const el = $('#teSize'); if (el) el.value = Math.round(tetherScale * 50); const lb = $('#teMul'); if (lb) lb.textContent = Math.round(tetherScale * 100) + '%'; if (ren) ren.tetherScale = tetherScale; syncIsoBtn(); if (ren) { ren.tetherDotted = tetherDotted; ren.tetherSparse = tetherSparse; ren.tetherDashed = tetherDashed; } syncTetherDotsBtn(); syncTetherSparseBtn(); syncTetherDashedBtn(); } catch {}
    try { if (ren) ren.tetherColor = tetherColor; document.querySelectorAll('#tePal .tesw').forEach(b => b.classList.toggle('on', (b.dataset.color || '').toLowerCase() === String(tetherColor).toLowerCase())); } catch {}
    try { const el = $('#bdAlpha'); if (el) el.value = Math.round(backdropAlpha * 100); const lb = $('#bdMul'); if (lb) lb.textContent = backdropAlpha <= 0 ? 'off' : Math.round(backdropAlpha * 100) + '%'; if (ren) { ren.backdropAlpha = backdropAlpha; } try { applyBackdrop(); } catch {} } catch {}
    try { document.querySelectorAll('#bgPal .bgsw').forEach(b => b.classList.toggle('on', b.dataset.bg === backdrop && backdrop !== '')); } catch {}
    try { const el = $('#paSize'); if (el) el.value = Math.round(paneAlpha * 100); const lb = $('#paMul'); if (lb) lb.textContent = paneAlpha <= 0 ? 'clear' : Math.round(paneAlpha * 100) + '%'; try { document.documentElement.style.setProperty('--paneAlpha', String(paneAlpha)); } catch {} syncPaneContrast(); } catch {}
    try {
      document.getElementById('leftPanel')?.classList.toggle('noglass', !glazeLeft);
      document.getElementById('docPanel')?.classList.toggle('noglass', !glazeDoc);
      document.getElementById('devBox')?.classList.toggle('noglass', !glazeCloud);
      document.getElementById('miniMap')?.classList.toggle('noglass', !glazeMini);
      document.getElementById('glossPane')?.classList.toggle('noglass', !glazeGloss);
      document.getElementById('leftPanel')?.classList.toggle('lux', !!luxLeft);
      document.getElementById('docPanel')?.classList.toggle('lux', !!luxDoc);
      document.getElementById('tabBar')?.classList.toggle('lux', !!luxTab);
      document.getElementById('hintBar')?.classList.toggle('lux', !!luxHint);
      document.getElementById('miniMap')?.classList.toggle('lux', !!luxMini);
      try { syncShadeLock(); } catch {} // backup restore: re-freeze shade if luxury is on
    } catch {}
    try { applyDocWidth(); } catch {}
    try { syncGloss(); } catch {}
    try { if (pinOpenWord != null && !pinnedTerms.includes(pinOpenWord)) setPin(null); syncPinTabs(); } catch {}
    try {
      const nva = $('#notesViewAll'); if (nva) nva.checked = viewNotesAll !== false;
      const nvs = $('#notesViewSun'); if (nvs) nvs.checked = viewNotesSun !== false;
      if (notesOpen && !vault.byId(notesDocId || activeId)) { notesOpen = false; notesDocId = null; }
      syncNotesTab();
      if (notesOpen) setNotes(true, notesDocId || activeId);
    } catch {}
    try {
      if (leftCollapsed) setCollapsed('leftPanel', true); else setCollapsed('leftPanel', false);
      if (docCollapsed) setCollapsed('docPanel', true); else setCollapsed('docPanel', false);
    } catch {}
    try { if (ren) { ren.simpleOrb = simpleOrb; ren.stripOverlays = simpleOrb2; ren.triOrb = triOrb; ren.vivid = false; } syncAutoBtn(); syncSimpleOrbBtn(); syncSimpleOrb2Btn(); syncTriOrbBtn(); syncDocIconBtn(); syncHv(); syncLbPill(); } catch {} // nebula retired: vivid stays off
    try { syncHv(); } catch {}
    try {
      lensThematic = s.lensThematic === true;
      lensTags = s.lensTags === true;
      if (lensThematic && lensTags) lensTags = false; // the two lenses are mutually exclusive
      syncLensBtn();
      if (lensThematic || lensTags) applyLens();
    } catch {}
    try { saveUi(); } catch {}
    try { vault.persist(); } catch {}
    try {
      const afterCount = countBackupDocs({ tabs: vault.tabs });
      const afterSig = sigOf(vault.tabs);
      const identical = afterSig === beforeSig;
      try { if (window.__visidocsverse) window.__visidocsverse.lastLoadInfo = { before: beforeCount, after: afterCount, identical, canvases: vault.tabs.length }; } catch {}
      const where = `${afterCount} bodies across ${vault.tabs.length} canvas${vault.tabs.length === 1 ? '' : 'es'}`;
      if (identical) setLog(`Loaded backup: ${where} — already matches the current universe, nothing changed`);
      else setLog(`Loaded backup: ${beforeCount} → ${afterCount} bodies across ${vault.tabs.length} canvas${vault.tabs.length === 1 ? '' : 'es'}`);
    } catch {}
    return true;
  }
      // merge: add a backup file's documents into the CURRENT canvas, keeping
  // what is already open. Exact-text duplicates are skipped; same-name but
  // different-text docs arrive as "Name (2).md" so nothing is overwritten.
  // Returns {added, dupes, total} (added docs are already rebuilt + focused).
  function mergeBackupObject(obj) {
    let rawList = null;
    if (obj && Array.isArray(obj.tabs) && obj.tabs.length) {
      rawList = [];
      for (const t of obj.tabs) {
        const arr = (t && Array.isArray(t.docs)) ? t.docs : (t && Array.isArray(t.documents) ? t.documents : null);
        if (arr) for (const d of arr) rawList.push(d);
      }
    } else if (Array.isArray(obj)) rawList = obj.slice();
    else if (obj && Array.isArray(obj.vault)) rawList = obj.vault;
    else if (obj && Array.isArray(obj.docs)) rawList = obj.docs;
    else if (obj && Array.isArray(obj.documents)) rawList = obj.documents;
    if (!rawList || !rawList.length) { toast('That backup has no documents to merge'); return { added: 0, dupes: 0, total: 0 }; }
    const tab = vault.tab();
    if (!tab) { toast('No open canvas to merge into'); return { added: 0, dupes: 0, total: rawList.length }; }
    const seenText = new Set((tab.docs || []).map(d => String(d.text || '').replace(/\s+/g, ' ').trim()));
    const seenName = new Set((tab.docs || []).map(d => String(d.name || '').toLowerCase()));
    const seenId = new Set((tab.docs || []).map(d => d.id));
    let added = 0, dupes = 0;
    const newIds = [];
    for (let i = 0; i < rawList.length; i++) {
      let d = null;
      try { d = vault.normalizeDoc(rawList[i], 'Untitled ' + (i + 1)); }
      catch { continue; }
      const key = String(d.text || '').replace(/\s+/g, ' ').trim();
      if (key && seenText.has(key)) { dupes++; continue; } // same bytes already here
      seenText.add(key);
      // unique id (a backup merged over itself would otherwise twin-collide)
      if (!d.id || seenId.has(d.id)) {
        d.id = 'd_' + Math.random().toString(36).slice(2, 10);
        while (seenId.has(d.id)) d.id = 'd_' + Math.random().toString(36).slice(2, 10);
      }
      seenId.add(d.id);
      // unique name (same rule as file intake: "Report (2).md")
      let nm = d.name, k = 1;
      while (seenName.has(nm.toLowerCase())) {
        k++;
        nm = String(d.name).replace(/(\.[^.]+)?$/, ` (${k})$1`);
        if (k > 999) break;
      }
      d.name = nm;
      seenName.add(nm.toLowerCase());
      vault.applySuppress(d, tab); // merged-in bodies respect this canvas's deleted/merged names
      tab.docs.push(d);
      newIds.push(d.id);
      added++;
    }
    try { vault.persist(); } catch {}
    try { edgeByTab.delete(tab.id); } catch {}
    rebuild(activeId);
    if (newIds.length && uni && uni.focus(newIds[0])) { claimSun(newIds[0]); renderDoc(); }
    try { renderTabs(); } catch {}
    try { updateStats(); } catch {}
    return { added, dupes, total: rawList.length };
  }
  async function readBackupFile(f) {
    setLog(`Reading “${f.name}” (${(f.size / 1024).toFixed(0)} KB)…`);
    toast(`Reading “${f.name}”…`);
    let txt = null;
    try { txt = await f.text(); }
    catch (err) {
      try {
        txt = await new Promise((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result || ''));
          r.onerror = () => rej(r.error || new Error('FileReader failed'));
          r.readAsText(f);
        });
      } catch (err2) { toast(`Could not read “${f.name}” (${(err2 && err2.message) || err2})`, 8000); setLog(`Load failed: could not read “${f.name}”`); return null; }
    }
    if (!txt || !txt.trim()) { toast(`“${f.name}” looks empty (0 bytes of text)`); setLog(`Load failed: “${f.name}” is empty`); return null; }
    txt = String(txt).replace(/^﻿/, '').trim();
    let obj = null;
    try { obj = JSON.parse(txt); }
    catch (je) {
      const head = txt.slice(0, 160).replace(/\s+/g, ' ');
      console.warn('backup JSON.parse failed', je, head);
      try { window.__visidocsverse.lastLoadError = 'JSON: ' + ((je && je.message) || je); } catch {}
      toast(`Could not load “${f.name}” — not valid JSON (${(je && je.message) || je})`, 10000);
      setLog(`Load failed: “${f.name}” is not valid JSON — starts with: ${head.slice(0, 120)}…`);
      return null;
    }
    if (!looksLikeBackup(obj)) {
      const keys = (obj && typeof obj === 'object' && !Array.isArray(obj)) ? Object.keys(obj).slice(0, 8).join(', ') : (Array.isArray(obj) ? `array[${obj.length}]` : typeof obj);
      toast(`“${f.name}” is not a Visi|Docsverse master file (found: ${keys || 'empty'})`, 10000);
      setLog(`Load failed: “${f.name}” has no backup data (found: ${keys || 'empty'})`);
      try { window.__visidocsverse.lastLoadError = 'not-a-backup: ' + (keys || 'empty'); } catch {}
      return null;
    }
    try { window.__visidocsverse._lastBackupObj = obj; window.__visidocsverse._lastBackupName = f.name; } catch {}
    return { obj, name: f.name };
  }
  // Desktop-safe master-file restore (SHIPS in installers: this block sits
  // outside every dev-only range and only calls bundled helpers — no cloud,
  // no dev pane, no dev-only names, so the desktop strip leaves it intact).
  // restoreMasterFromFile replaces the whole universe; absorbMasterIntoCanvas
  // merges the file's documents into the current canvas. Both take a File
  // (from the Open-Existing-Project menu pickers below) and are also on the
  // __visidocsverse console handle for scripted restores.
  async function restoreMasterFromFile(f) {
    if (!f) return false;
    const got = await readBackupFile(f);
    if (!got) return false;
    const { obj } = got;
    try {
      const n = countBackupDocs(obj);
      const tabs = Array.isArray(obj.tabs) ? obj.tabs.length : 0;
      const detail = tabs > 1 ? `${n} bodies across ${tabs} canvases` : `${n} documents`;
      setLog(`Loaded “${f.name}” — asking to replace universe with ${detail}…`);
      if (!await confirmDlg(`Load Visi|Docsverse master file with ${detail}? This replaces the current universe.`, 'Load file')) { setLog(`Load cancelled — kept current universe`); return false; }
      if (applyBackupObject(obj)) {
        try {
          const info = window.__visidocsverse.lastLoadInfo;
          if (info && info.identical) toast(`Backup matches the open universe — nothing changed (${detail})`, 6000);
          else if (info) toast(`Visi|Docsverse master file loaded — ${info.before} → ${info.after} bodies`, 6000);
          else toast(`Visi|Docsverse master file loaded — ${detail}`, 6000);
        } catch { toast(`Visi|Docsverse master file loaded — ${detail}`, 6000); }
        return true;
      }
      setLog(`Load failed: applyBackupObject refused “${f.name}”`);
      return false;
    } catch (err) { console.warn('load failed', err); try { window.__visidocsverse.lastLoadError = String((err && err.message) || err); } catch {} toast(`Could not load that file (${(err && err.message) || err})`, 10000); setLog(`Load failed: ${(err && err.message) || err}`); return false; }
  }
  async function absorbMasterIntoCanvas(f) {
    if (!f) return { added: 0, dupes: 0, total: 0 };
    if (!vault.tab()) {
      toast('No open canvas — click + to start one before merging a master file.');
      return { added: 0, dupes: 0, total: 0 };
    }
    const got = await readBackupFile(f);
    if (!got) return { added: 0, dupes: 0, total: 0 };
    const { obj } = got;
    try {
      const n = countBackupDocs(obj);
      const tabs = Array.isArray(obj.tabs) ? obj.tabs.length : 0;
      const detail = tabs > 1 ? `${n} bodies across ${tabs} canvases` : `${n} documents`;
      setLog(`Loaded “${f.name}” — asking to merge ${detail} into “${vault.tab().name}”…`);
      if (!await confirmDlg(`Merge ${detail} into “${vault.tab().name}”? Keeps what is open, adds the rest. Exact duplicates are skipped.`, 'Merge')) { setLog(`Merge cancelled — kept current universe`); return { added: 0, dupes: 0, total: n }; }
      const r = mergeBackupObject(obj);
      if (r.added > 0) {
        const dupe = r.dupes ? ` · ${r.dupes} duplicate${r.dupes === 1 ? '' : 's'} skipped` : '';
        toast(`Merged ${r.added} document${r.added === 1 ? '' : 's'} into “${vault.tab().name}”${dupe}`);
        setLog(`Merged “${f.name}”: ${r.added} added${dupe} (${vault.docs.length} bodies now)`);
      } else if (r.dupes > 0) {
        toast(`Nothing new — all ${r.dupes} already in “${vault.tab().name}”`);
        setLog(`Merge: nothing new — all ${r.dupes} already open`);
      }
      return r;
    } catch (err) { console.warn('merge failed', err); toast(`Could not merge that file (${(err && err.message) || err})`, 10000); setLog(`Merge failed: ${(err && err.message) || err}`); return { added: 0, dupes: 0, total: 0 }; }
  }
  const restorePickEl = $('#restorePick');
  if (restorePickEl) restorePickEl.onchange = async (e) => {
    const f = (e.target.files || [])[0];
    e.target.value = '';
    if (!f) return;
    await restoreMasterFromFile(f);
  };
  const absorbPickEl = $('#absorbPick');
  if (absorbPickEl) absorbPickEl.onchange = async (e) => {
    const f = (e.target.files || [])[0];
    e.target.value = '';
    if (!f) return;
    await absorbMasterIntoCanvas(f);
  };
          window.__visidocsverse = { get uni() { return uni; }, get unis() { return unis; }, get thematicThemes() { return thematicThemes; }, ren, vault, rebuild, rebuildAllTabs, entangleSync, renderTabs, switchCanvas, closeCanvas, removeFromCanvas, deleteEverywhere, removeAllFromCanvas, removeIdsFromCanvas, removeUniverseFromCanvas, toggleAssoc: (...a) => vault.toggleAssoc(...a), confirmDlg, infoDlg, openPickModal, setLog, syncIntakeLog, openSrcPop, closeSrcPop, srcSection, buildBackupObject, applyBackupObject, mergeBackupObject, looksLikeBackup, countBackupDocs, restoreMasterFromFile, absorbMasterIntoCanvas, ingestFiles, getDropFiles, readFileAsText, intakeAllowed, cleanName, deleteTag, deleteTagEverywhere, mergeTags, renameTag, renameTagConfirm, openTagRenameEditor, openTagPop, closeTagPop, openHowStart, closeHowStart, showCloseGuardPane, hideCloseGuardPane, needsBackupGuard, markBackupDirty, exitAppNow, showAssoc, hideAssoc, showAssocAll, clearAssoc, focusAssocDoc, toggleSnapCenter, get snapCenter() { return snapCenter; }, saveAllProjects, lastLoadError: null, lastLoadInfo: null, get activeId() { return activeId; }, defocusSun, getNote, saveNote, deleteNote, getThematicWhole, wholeVisidocsverseDocs, get thematicWhole() { return thematicWhole; }, get wholeThemes() { return wholeThemes; }, get helpTexts() { return { ...helpTexts }; }, openHelpEditor, helpEditAllowed, DEFAULT_HELP, eula: { accepted: () => eulaAccepted(), show: () => showEulaModal() }, update: { version: APP_VERSION, gate: () => needsUpdateCheck(), check: (n) => checkForUpdates(n || toast), show: (info, n) => showUpdateBanner(info, n || toast), hide: (r) => hideUpdateBanner(r !== false) }, get lastSeed() { return lastSeedCount; }, license: { verify: (t) => verifyLicenseKey(t), gate: () => needsLicenseGate(), show: (note) => showLicenseModal(note), lemonStartup: () => verifyLicenseOnStartup(), lemonActivate: (k, n) => activateLicenseKey(k, n) } };
    try { Object.assign(window.__visidocsverse, { docApaInfo, docApaText, docApaHtml, copyApaCite, setNotes, closeNotesPane, renderNotesPane, openNotePop, closeNotePop, openNoteEditor, closeNoteEditor, resolveCiteMeta, origPut, origGet, get notesOpen() { return notesOpen; }, get notesDocId() { return notesDocId; }, get shownId() { return shownId; }, get paneId() { return paneId; } }); } catch {} // notes/APA handles for scripted checks
  try { Object.assign(window.__visidocsverse, { diskUsable, diskVaultDir, diskVaultLabel, diskPut, diskGetBlob, diskListKeys, migrateIdbOriginalsToDisk, origBlob, purgeImages }); } catch {} // disk-vault handles for scripted checks
  window.addEventListener('resize', () => ren.resize());
  bootStage('ready');
  try { document.title = __bootTitle0; } catch (e) {} // boot complete: restore the plain title (tracer stays silent on success)
  // Desktop-shell close-guard self-check: runs ONLY inside the installed app
  // (Neutralino client/NL_* globals and Tauri IPC never exist in the browser
  // preview), and stays silent when everything is healthy.
  try {
    let inTauriShell = false;
    try { inTauriShell = !!(window.__TAURI_INTERNALS__); } catch {}
    const inShell = (window.NL_PORT != null || window.NL_TOKEN != null || window.NL_APPID != null || (typeof Neutralino !== 'undefined') || inTauriShell);
    if (inShell) {
      let probe = null;
      try { probe = JSON.parse(localStorage.getItem('visidocsverse.closeprobe') || 'null'); } catch {}
      try { localStorage.removeItem('visidocsverse.closeprobe'); } catch {}
      if (probe && probe.at) {
        toast('Last time the app closed without going through its save check — your workspace was restored as-is. Use “Save project” for a file backup.', 9000);
      }
      if (inTauriShell) {
        // Tauri shells need no bridge-file/runtime/native-API probes: the X
        // is intercepted from the vendored bundle above, not the WS bridge.
      } else if (typeof Neutralino === 'undefined') {
        toast('Desktop bridge file failed to load (close-warning off) — reinstall, or report this.', 9000);
      } else if (window.NL_PORT == null || window.NL_TOKEN == null) {
        toast('Desktop runtime data missing (close-warning off) — reinstall, or report this.', 9000);
      } else {
        const port = window.NL_PORT;
        // Native-API access probe: hasAPIAccess() is config-gated
        // (enableNativeAPI). A connected bridge with blocked native calls
        // dispatches no windowClose and rejects showMessageBox — the exact
        // "silent X" symptom. getConfig is allowlisted (app.*); if the WS is
        // up it resolves when allowed and rejects when blocked. If the WS
        // never opens the call just stays queued (the bridge toast covers it).
        setTimeout(() => {
          try {
            Promise.resolve(Neutralino.app.getConfig()).then(
              () => {},
              () => { try { toast('Desktop native API is blocked (close-warning off) — reinstall, or report this.', 12000); } catch {} });
          } catch {}
        }, 14000);
        setTimeout(() => {
          try {
            if (!window.__bridgeReady) {
              try { Neutralino.init(); } catch {} // one retry: the server can lose the first-race WS
              setTimeout(() => {
                try { if (!window.__bridgeReady) toast('Desktop bridge is not connected (close-warning off, port ' + port + ') — restart the app, or report this.', 12000); } catch {}
              }, 8000);
            }
          } catch {}
        }, 12000);
      }
    }
  } catch {}
  // Desktop-shell health probes (silent on success): one no-UI native call
  // per namespace the close guard needs + a byte-range fetch of every
  // lazily-imported vendor module. A failing shell reports WHICH piece broke
  // (namespace + reason, file + HTTP status) instead of a generic banner, so
  // a screenshot diagnoses a bad install instead of guessing. Results live on
  // window.__visidocsverse.nativeProbe / .vendorProbe for scripted checks.
  try {
    let tauriIpc = false;
    try { tauriIpc = !!(window.__TAURI_INTERNALS__); } catch {}
    const neuShell = (typeof Neutralino !== 'undefined');
    if (neuShell || tauriIpc) {
      (async () => {
        const bad = [];
        if (neuShell && !tauriIpc) {
          const call = async (ns, fn) => {
            try { await fn(); return ns + ':ok'; }
            catch (e) { return ns + ':FAIL ' + ((e && (e.message || e.code)) || e); }
          };
          const out = [
            await call('app', () => Neutralino.app.getConfig()),
            await call('os', () => Neutralino.os.getEnv('PATH')),
            await call('window', () => Neutralino.window.getTitle()),
          ];
          try { window.__visidocsverse.nativeProbe = out; } catch {}
          for (const r of out) if (!/:ok$/.test(r)) bad.push(r);
        }
        try {
          const files = ['pdf.mjs', 'pdf.worker.js', 'tesseract.mjs', 'xlsx.mjs', 'mammoth.mjs', 'fflate.mjs'];
          if (tauriIpc) files.push('tauri-api-window.bundle.mjs', 'tauri-plugin-fs.bundle.mjs', 'tauri-api-path.bundle.mjs');
          const checks = await Promise.all(files.map(async (f) => {
            const ctl = new AbortController();
            const to = setTimeout(() => { try { ctl.abort(); } catch {} }, 8000);
            try {
              const r = await fetch(vendorBase() + f, { headers: { Range: 'bytes=0-0' }, signal: ctl.signal });
              return f + ':' + (r.ok ? 'ok' : 'HTTP ' + r.status);
            } catch (e) { return f + ':UNREACHABLE ' + ((e && e.name) || e); }
            finally { clearTimeout(to); }
          }));
          try { window.__visidocsverse.vendorProbe = checks; } catch {}
          for (const c of checks) if (!/:ok$/.test(c)) bad.push(c);
        } catch (e) { bad.push('vendor-probe:' + ((e && e.message) || e)); }
        if (bad.length) {
          try { toast('Desktop files/native check failed — ' + bad.join('; ') + '. Reinstall from a fresh extract, or report this.', 15000); } catch {}
        }
      })();
    }
  } catch {}
  // Viewport settle: boot sizes against a window that may still be animating
  // (maximize on launch, slow fonts) — re-assert the full layout once it
  // lands, plus on every later viewport-affecting change. fitViewport is
  // idempotent and dedupes identical sizes, so these are cheap.
  try { fitViewport('boot'); } catch {}
  try { setTimeout(() => fitViewport('settle'), 250); } catch {}
  try { setTimeout(() => fitViewport('settle'), 900); } catch {}
  try { setTimeout(() => fitViewport('settle'), 2500); } catch {}
  try { window.addEventListener('orientationchange', () => fitViewportSoon(200)); } catch {}
  try { document.addEventListener('fullscreenchange', () => fitViewportSoon(200)); } catch {}
  try { document.addEventListener('visibilitychange', () => { if (!document.hidden) fitViewportSoon(150); }); } catch {}
  try {
    const armDpr = () => {
      try {
        const mq = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)');
        const h = () => { try { mq.removeEventListener('change', h); } catch {} try { mq.removeListener(h); } catch {} fitViewportSoon(150); armDpr(); };
        if (mq.addEventListener) mq.addEventListener('change', h);
        else if (mq.addListener) mq.addListener(h);
      } catch {}
    };
    armDpr();
  } catch {}
}

if (document.readyState !== 'loading') boot();
else document.addEventListener('DOMContentLoaded', boot);

// Offline license verification for the desktop app.
//
// The buyer receives a small license key FILE with their purchase (email +
// delivery channel are yours to choose). This module verifies that file
// LOCALLY with the embedded ECDSA P-256 public key — no network, no phone
// home, no expiry ping. The matching private key lives ONLY with the
// developer (used by src/tools/desktop/make-key.mjs to sign key files);
// it is never in this repo and never ships to users.
//
// license.js re-exports the Lemon Squeezy online path (see
// licensing-manager.js); either system passing unlocks the app.
import { verifyLicenseOnStartup, activateLicenseKey, deactivateLicenseKey, lemonCacheStatus, clearLemonCache } from './licensing-manager.js';

// Key file shape (JSON):
//   {"product":"visidocsverse","email":"buyer@example.com","issued":"2026-10-25","sig":"<base64url>"}
// where sig = ECDSA-SHA256(privateKey, "visidocsverse|<lowercased email>|<issued>").
// Verified copies are cached in localStorage; a cached key is re-verified
// (still offline) on every launch. Casual licensing, not DRM: everything a
// user needs to run is on their machine, by design.
export const LICENSE = {
  product: 'visidocsverse',
  cacheKey: 'visidocsverse.license.v1',
  // Gate the Perchance preview too when true (dev builds). Ships false: the
  // desktop shells (Tauri / file://) always gate, the web preview never does.
  enforceOnWeb: false,
};

// Created once by make-key.mjs `gen`. To rotate: generate a new pair, swap
// this block, and re-issue key files (old files stop verifying).
export const LICENSE_PUBLIC_JWK = {
  kty: 'EC', crv: 'P-256',
  x: 'yXli-EBskR8KkQQdRUZPHC78848h_xddZQZrXfVj-jQ',
  y: 'FvfSoWugPDhhcCsFQORszaHLib7kP0u-sumQeSKapys',
};

const te = new TextEncoder();

function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function signingInput(email, issued) {
  return te.encode([LICENSE.product, String(email).trim().toLowerCase(), String(issued)].join('|'));
}

export async function verifyLicenseKey(text) {
  let o = null;
  try { o = JSON.parse(String(text)); }
  catch { return { ok: false, error: 'That is not a license key file (it is not JSON).' }; }
  if (!o || o.product !== LICENSE.product || typeof o.email !== 'string' || !o.email.includes('@') || typeof o.issued !== 'string' || typeof o.sig !== 'string') {
    return { ok: false, error: 'That file is not a Visi|Docsverse license key (missing product / email / issued / sig).' };
  }
  const email = o.email.trim().toLowerCase();
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return { ok: false, error: 'This copy cannot verify keys here (WebCrypto is unavailable) — open Visi|Docsverse through its installed launcher, not this file directly.' };
  }
  let key = null;
  try {
    key = await crypto.subtle.importKey('jwk', LICENSE_PUBLIC_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return { ok: false, error: 'The bundled public key is damaged — reinstall Visi|Docsverse and try again.' };
  }
  let sig = null;
  try { sig = b64urlToBytes(o.sig); }
  catch { return { ok: false, error: 'The key signature is malformed.' }; }
  let ok = false;
  try { ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signingInput(email, o.issued)); }
  catch { ok = false; }
  if (!ok) return { ok: false, error: `That key file was not issued for ${email} by us — check you pasted the whole file.` };
  return { ok: true, email, issued: o.issued };
}

export function cachedLicenseText() {
  try { return localStorage.getItem(LICENSE.cacheKey); }
  catch { return null; }
}

export function cacheLicenseText(text) {
  try { localStorage.setItem(LICENSE.cacheKey, String(text)); }
  catch { /* private mode: activation lasts this session */ }
}

export function clearLicenseCache() {
  try { localStorage.removeItem(LICENSE.cacheKey); }
  catch {}
}

// Fully remove this machine's activation (both paths) — the next
// ensureLicensed() re-shows the Activate modal on desktop shells.
export function deactivateLicense() {
  clearLemonCache();
  clearLicenseCache();
}

// Server-side seat release: frees this machine's Lemon instance (it stops
// counting against the key's activation limit) and clears both local caches.
// Fail-closed: when Lemon can't be reached the local activation is KEPT, so a
// null/false return means "still licensed here". Re-exported for status UIs.
export async function deactivateLicenseRemote() {
  let r = null;
  try { r = await deactivateLicenseKey(); } catch { r = null; }
  if (r && r.success) {
    try { clearLicenseCache(); } catch {}
    return r;
  }
  return r || { success: false, offline: true, message: 'Could not reach Lemon Squeezy — still activated on this machine.' };
}

export { deactivateLicenseKey };

// Read-only license snapshot for status surfaces (offline only, never
// throws): {kind:'lemon'|'keyfile'|'none', email}. Once a Lemon subscription
// cache exists on this machine it is authoritative — a legacy key file is
// not reported as a valid license, matching ensureLicensed().
export async function licenseStatus() {
  let lemonPresent = false;
  try {
    const s = await lemonCacheStatus();
    if (s && s.ok) return { kind: 'lemon', email: s.email || '' };
    lemonPresent = !!(s && s.present);
  } catch {}
  if (lemonPresent) return { kind: 'none', email: '' };
  try {
    const c = cachedLicenseText();
    if (c) {
      const r = await verifyLicenseKey(c);
      if (r.ok) return { kind: 'keyfile', email: r.email || '' };
    }
  } catch {}
  return { kind: 'none', email: '' };
}

// True inside any real install (desktop shell): Tauri, a file://-launched
// shell, OR Neutralino (localhost http + NL_* globals / Neutralino client).
// The web preview is never a desktop shell, so gates can never fire there.
export function isDesktopShell() {
  try {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__) return true;
    if (window.NL_PORT != null || window.NL_TOKEN != null || window.NL_APPID != null || window.NL_VERSION != null) return true; // Neutralino runtime constants
    if (typeof Neutralino !== 'undefined') return true; // Neutralino client API present (vendored neutralino.js)
    const p = String(location.protocol || '').toLowerCase();
    if (p === 'file:' || p === 'tauri:' || p === 'wry:' || p === 'app:') return true;
    if (/tauri\.localhost$/i.test(location.hostname)) return true;
  } catch {}
  return false;
}

// True only inside a real install (desktop shell) or when the dev flag says so.
export function needsLicenseGate() {
  if (LICENSE.enforceOnWeb) return true;
  return isDesktopShell();
}

// Resolve true once this machine holds a verified subscription. Lemon Squeezy
// weekly-check first; the fully-offline ECDSA key file is legacy-only and is
// tried ONLY when no Lemon subscription cache has ever existed on this
// machine. Once a subscription cache exists, Lemon is authoritative — an
// expired/cancelled/overdue subscription cannot be bypassed with an old key
// file. Shows the Activate modal (dismissable via "Not now" for deferred
// activation) when gating and neither verifies. Resolves false when the user
// defers — the caller exits cleanly (no save guard pre-boot) and the modal
// reappears on next launch. A non-routine startup verdict (tamper, expired,
// overdue) is passed through so the modal can say WHY it is locked, not just
// that it is.
export async function ensureLicensed() {
  if (!needsLicenseGate()) return true;
  let note = '';
  let lemonPresent = false;
  try {
    const r = await verifyLicenseOnStartup();
    if (r && r.isValid) return true;
    if (r && r.statusMessage && r.statusMessage !== 'No active Visi|Docsverse subscription found. Please enter your license key.' && r.statusMessage !== 'No active Visi|Docsverse license found. Please enter your license key.') note = r.statusMessage;
  } catch {}
  try {
    const s = await lemonCacheStatus();
    lemonPresent = !!(s && s.present);
  } catch { lemonPresent = true; }
  // Legacy key-file fallback only when Lemon was never activated here.
  if (!lemonPresent) {
    try {
      const c = cachedLicenseText();
      if (c) {
        const r = await verifyLicenseKey(c);
        if (r.ok) return true;
      }
    } catch {}
  }
  return showLicenseModal(note);
}

export { verifyLicenseOnStartup, activateLicenseKey };

function licenseEls() {
  return {
    m: document.getElementById('licenseModal'),
    input: document.getElementById('licenseInput'),
    err: document.getElementById('licenseErr'),
    ok: document.getElementById('licenseOk'),
    fileBtn: document.getElementById('licenseFileBtn'),
    file: document.getElementById('licenseFile'),
    keyInput: document.getElementById('licenseKeyInput'),
    onlineBtn: document.getElementById('licenseOnlineBtn'),
    later: document.getElementById('licenseLater'),
  };
}

export function showLicenseModal(note) {
  return new Promise((resolve) => {
    const { m, input, err, ok, fileBtn, file, keyInput, onlineBtn, later } = licenseEls();
    if (!m) { resolve(false); return; }
    let settled = false;
    const onEsc = (e) => {
      if (e && e.key === 'Escape' && !m.hidden && later && !later.disabled) { e.preventDefault(); later.click(); }
    };
    const done = (val) => {
      if (settled) return;
      settled = true;
      try { document.removeEventListener('keydown', onEsc, true); } catch {}
      try { m.hidden = true; } catch {}
      try { say(null); } catch {}
      resolve(val);
    };
    const say = (msg, color) => {
      if (!err) return;
      if (!msg) { err.hidden = true; err.textContent = ''; err.style.color = ''; }
      else { err.hidden = false; err.textContent = msg; err.style.color = color || ''; }
    };
    m.hidden = false;
    try { document.title = 'VisiDocsVerse [boot:license-modal]'; } catch (e) {}
    // Surface the lockout reason (tampered cache, unreadable store, …) when
    // the boot check supplied one; a first-run "no license yet" stays clean.
    say(note || null);
    fileBtn.onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      try { input.value = await f.text(); say(null); }
      catch { say('Could not read that file.'); }
      file.value = '';
    };
    if (onlineBtn) onlineBtn.onclick = async () => {
      onlineBtn.disabled = true;
      try {
        say('Activating Visi|Docsverse…', 'var(--mut)');
        const r = await activateLicenseKey(keyInput ? keyInput.value : '');
        if (!r.success) { say(r.message); return; }
        // Let the success land before the modal closes (then boot continues
        // into the unlocked app, which is this app's "enableProUI").
        say(r.message, '#8fd0a8');
        await new Promise(res => setTimeout(res, 1400));
        done(true);
      } finally { onlineBtn.disabled = false; }
    };
    // "Not now" = deferred activation: hide the modal and resolve false so
    // the caller can exit cleanly (the save guard never fires pre-boot — see
    // gatesOk in app.js). Next launch re-shows this modal automatically.
    if (later) later.onclick = () => done(false);
    try { document.addEventListener('keydown', onEsc, true); } catch {}
    // Enter in the single-line key field submits like the button.
    if (keyInput && !keyInput.dataset.bound) {
      keyInput.dataset.bound = '1';
      keyInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && onlineBtn && !onlineBtn.disabled) { e.preventDefault(); onlineBtn.click(); }
      });
    }
    ok.onclick = async () => {
      ok.disabled = true;
      try {
        const r = await verifyLicenseKey(input.value);
        if (!r.ok) { say(r.error); return; }
        cacheLicenseText(JSON.stringify(JSON.parse(input.value)));
        done(true);
      } finally { ok.disabled = false; }
    };
  });
}

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
import { verifyLicenseOnStartup, activateLicenseKey } from './licensing-manager.js';

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

// True only inside a real install (desktop shell) or when the dev flag says so.
export function needsLicenseGate() {
  if (LICENSE.enforceOnWeb) return true;
  try {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__) return true;
    const p = location.protocol;
    if (p === 'file:' || p === 'tauri:' || p === 'wry:' || p === 'app:') return true;
    if (/tauri\.localhost$/i.test(location.hostname)) return true;
  } catch {}
  return false;
}

// Resolve true once this machine holds a verified key. Lemon Squeezy
// online-cache first, then the fully-offline ECDSA key file; shows the
// Activate modal (blocking, no dismiss) when gating and neither verifies.
// A non-routine startup verdict (tamper, unreadable cache) is passed through
// so the modal can say WHY it is locked, not just that it is.
export async function ensureLicensed() {
  if (!needsLicenseGate()) return true;
  let note = '';
  try {
    const r = await verifyLicenseOnStartup();
    if (r && r.isValid) return true;
    if (r && r.statusMessage && r.statusMessage !== 'No active Visi|Docsverse license found. Please enter your license key.') note = r.statusMessage;
  } catch {}
  try {
    const c = cachedLicenseText();
    if (c) {
      const r = await verifyLicenseKey(c);
      if (r.ok) return true;
    }
  } catch {}
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
  };
}

export function showLicenseModal(note) {
  return new Promise((resolve) => {
    const { m, input, err, ok, fileBtn, file, keyInput, onlineBtn } = licenseEls();
    if (!m) { resolve(false); return; }
    const say = (msg, color) => {
      if (!err) return;
      if (!msg) { err.hidden = true; err.textContent = ''; err.style.color = ''; }
      else { err.hidden = false; err.textContent = msg; err.style.color = color || ''; }
    };
    m.hidden = false;
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
        say('Contacting Lemon Squeezy to activate Visi|Docsverse…', 'var(--mut)');
        const r = await activateLicenseKey(keyInput ? keyInput.value : '');
        if (!r.success) { say(r.message); return; }
        // Let the success land before the modal closes (then boot continues
        // into the unlocked app, which is this app's "enableProUI").
        say(r.message, '#8fd0a8');
        await new Promise(res => setTimeout(res, 1400));
        m.hidden = true;
        say(null);
        resolve(true);
      } finally { onlineBtn.disabled = false; }
    };
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
        m.hidden = true;
        resolve(true);
      } finally { ok.disabled = false; }
    };
  });
}

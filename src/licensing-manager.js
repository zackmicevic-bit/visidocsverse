// licensing-manager.js — Lemon Squeezy license activation, HMAC-secured
// local caching, and offline startup validation for VisiDocsverse.
//
// Four steps, one file:
//   1-2. activateLicenseKey() — online Lemon Squeezy activation (once per
//          install). Needs internet for this single call only.
//   3.   saveSecureCache() — persists the activation locally with an
//          HMAC-SHA256 signature so hand-edited caches fail closed.
//   4.   verifyLicenseOnStartup() — offline-first gate: fresh caches unlock
//          instantly with zero network; expired ones re-validate in the
//          background and keep working while offline (grace). Success paths
//          also return the cached record as `data` (VerificationResult).
//
// Browser-native port (no Node): WebCrypto replaces `crypto`, localStorage
// replaces the OS app-dir file (the Tauri WebView persists it in the app
// profile, same as the vault). The pre-existing fully-offline ECDSA key-file
// path in license.js is kept as a fallback — either one passing unlocks.
//
// Casual licensing, not DRM: everything a user needs to run is on their
// machine, by design. The HMAC only proves the cache wasn't hand-edited;
// real entitlement lives in Lemon Squeezy (instance ids).

/**
 * @typedef {object} LicenseCacheSchema
 * @property {string} app_name
 * @property {string} license_key
 * @property {string} instance_id
 * @property {number} product_id
 * @property {string} customer_email
 * @property {number} activated_at
 * @property {number} last_validated_at
 * @property {number} validation_grace_period_days
 * @property {string} signature_hash
 */

/**
 * @typedef {object} VerificationResult
 * @property {boolean} isValid
 * @property {string} statusMessage
 * @property {Partial<LicenseCacheSchema>} [data]
 */

export const LEMON = {
  appName: 'VisiDocsverse',
  activateUrl: 'https://api.lemonsqueezy.com/v1/licenses/activate',
  validateUrl: 'https://api.lemonsqueezy.com/v1/licenses/validate',
  cacheKey: 'visidocsverse.lemon.v1',
  graceDays: 30,
};

const te = new TextEncoder();

function hexOf(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Machine-stable secret for the local HMAC (tamper-evidence only — it is
// derived from public browser attributes, so it cannot stop a determined
// user, and isn't meant to; Lemon Squeezy instances are the real check).
async function getLocalMachineSecret() {
  let fp = 'unknown-machine';
  try {
    fp = [
      navigator.platform || '',
      navigator.userAgent || '',
      navigator.language || '',
      String(navigator.hardwareConcurrency || ''),
    ].join('|');
  } catch { /* private mode */ }
  const digest = await crypto.subtle.digest('SHA-256', te.encode('visidocsverse-lemon|' + fp));
  return hexOf(digest);
}

async function hmacHex(secretHex, text) {
  const keyBytes = new Uint8Array(secretHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexOf(await crypto.subtle.sign('HMAC', key, te.encode(text)));
}

// STEP 1 & 2: Lemon Squeezy API activation. Calls the API to activate a key
// string and saves the local cache upon success. Returns {success, message}.
// Fails closed with a human message on bad keys, API rejections, or network
// errors.
export async function activateLicenseKey(licenseKey, machineName = 'VisiDocsverse-Client-PC') {
  const key = String(licenseKey || '').trim();
  if (!key) return { success: false, message: 'Enter the license key from your purchase email first.' };
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return { success: false, message: 'This copy cannot sign keys here (WebCrypto is unavailable) — open Visi|Docsverse through its installed launcher.' };
  }
  let data = null;
  try {
    const params = new URLSearchParams();
    params.append('license_key', key);
    params.append('instance_name', String(machineName || 'VisiDocsverse-Client-PC').slice(0, 80));
    const response = await lemonFetch(LEMON.activateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString(),
    });
    try { data = await response.json(); }
    catch { return { success: false, message: `Activation failed (server answered ${response.status}). Check your connection and retry.` }; }
    if (!response.ok || !data || data.activated !== true) {
      return { success: false, message: (data && data.error) || 'Activation failed. Please verify your license key and try again.' };
    }
  } catch (err) {
    return { success: false, message: `Network connection error: ${(err && err.message) || 'Unable to reach activation server.'}` };
  }
  // Prepare payload from the Lemon Squeezy response.
  const payload = {
    app_name: LEMON.appName,
    license_key: (data.license_key && data.license_key.key) || key,
    instance_id: (data.instance && data.instance.id) || '',
    product_id: (data.meta && data.meta.product_id) || 0,
    customer_email: (data.meta && data.meta.customer_email) || '',
    activated_at: Math.floor(Date.now() / 1000),
    last_validated_at: Math.floor(Date.now() / 1000),
    validation_grace_period_days: LEMON.graceDays,
  };
  // STEP 3: encrypted local storage caching.
  try { await saveSecureCache(payload); }
  catch { return { success: false, message: 'Activated, but this computer refused to store it (storage blocked?) — retry with storage allowed.' }; }
  return { success: true, message: `Visi|Docsverse successfully activated for ${payload.customer_email || 'you'}!` };
}

// Signs payload (WITHOUT any stale signature_hash field — callers may pass a
// previously-cached object; re-signing the old hash would fail verification
// on next launch) and persists it. Exported for diagnostics/support.
export async function saveSecureCache(payload) {
  const { signature_hash: _drop, ...clean } = payload || {};
  const jsonString = JSON.stringify(clean);
  const signature_hash = await hmacHex(await getLocalMachineSecret(), jsonString);
  try { localStorage.setItem(LEMON.cacheKey, JSON.stringify({ ...clean, signature_hash })); }
  catch (err) { throw new Error('storage-blocked'); }
}

export function readLemonCacheRaw() {
  try { return localStorage.getItem(LEMON.cacheKey); }
  catch { return null; }
}

export function clearLemonCache() {
  try { localStorage.removeItem(LEMON.cacheKey); }
  catch {}
}

// Returns {ok, data?, reason?}: ok only when the cache parses AND its HMAC
// verifies. Tampered caches are wiped so they fail closed.
async function loadAndVerifyCache() {
  const raw = readLemonCacheRaw();
  if (!raw) return { ok: false, reason: 'missing' };
  let obj = null;
  try { obj = JSON.parse(raw); }
  catch { return { ok: false, reason: 'unreadable' }; }
  if (!obj || typeof obj !== 'object' || typeof obj.signature_hash !== 'string') return { ok: false, reason: 'unreadable' };
  const { signature_hash, ...payload } = obj;
  let expected = '';
  try { expected = await hmacHex(await getLocalMachineSecret(), JSON.stringify(payload)); }
  catch { return { ok: false, reason: 'crypto' }; }
  if (signature_hash !== expected) {
    try { localStorage.removeItem(LEMON.cacheKey); } catch {}
    return { ok: false, reason: 'tampered' };
  }
  if (obj.app_name !== LEMON.appName || typeof obj.license_key !== 'string' || !obj.license_key) {
    return { ok: false, reason: 'unreadable' };
  }
  return { ok: true, data: obj };
}

// STEP 4: offline startup lifecycle, run on application boot to determine
// feature lock status. Returns a VerificationResult (success paths carry the
// cached record as `data`). Fresh cache -> instant offline unlock. Expired
// cache -> one background revalidation; offline + expired still gets
// temporary access (local-first, never locked out mid-travel). Never throws.
export async function verifyLicenseOnStartup() {
  const seen = await loadAndVerifyCache();
  if (!seen.ok) {
    if (seen.reason === 'missing') return { isValid: false, statusMessage: 'No active Visi|Docsverse license found. Please enter your license key.' };
    if (seen.reason === 'tampered') return { isValid: false, statusMessage: 'License cache file integrity check failed. Please re-enter your key.' };
    if (seen.reason === 'crypto') return { isValid: false, statusMessage: 'This copy cannot verify keys here (WebCrypto is unavailable).' };
    return { isValid: false, statusMessage: 'Error reading local license configuration.' };
  }
  const c = seen.data;
  const now = Math.floor(Date.now() / 1000);
  const secondsElapsed = now - (c.last_validated_at || 0);
  const daysElapsed = secondsElapsed / (60 * 60 * 24);
  const grace = Number(c.validation_grace_period_days) > 0 ? Number(c.validation_grace_period_days) : LEMON.graceDays;
  // Within the grace period: unlock instantly, no Wi-Fi needed.
  if (daysElapsed < grace) {
    return { isValid: true, statusMessage: 'Visi|Docsverse Pro unlocked (Offline Verified).', data: c };
  }
  // Grace period passed -> attempt silent background validation.
  const revalidationSuccess = await backgroundRevalidate(c.license_key, c.instance_id);
  if (revalidationSuccess) {
    const updated = { ...c, last_validated_at: now };
    try { await saveSecureCache(updated); } catch {}
    return { isValid: true, statusMessage: 'License validated online successfully.', data: updated };
  }
  // Network failure or offline: grant grace access so the user is never
  // locked out during travel.
  return { isValid: true, statusMessage: 'Offline Mode: Grace period elapsed, but network unavailable. Access granted.', data: c };
}

async function backgroundRevalidate(licenseKey, instanceId) {
  try {
    const params = new URLSearchParams();
    params.append('license_key', String(licenseKey || ''));
    if (instanceId) params.append('instance_id', String(instanceId));
    const response = await lemonFetch(LEMON.validateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString(),
    });
    const data = await response.json();
    return response.ok && data && data.valid === true;
  } catch {
    return false; // network offline (or blocked) — caller grants temporary access
  }
}

// Plain fetch first (works wherever CORS allows, e.g. the desktop shell with
// no CSP restriction). Inside Tauri, fall back to the http plugin's fetch,
// which is not bound by WebView CORS, so activation works even if Lemon
// Squeezy ever stops sending ACAO headers.
let tauriHttpFetch = null;
async function lemonFetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (firstErr) {
    try {
      if (!window.__TAURI__) throw firstErr;
      if (!tauriHttpFetch) {
        const mod = await import('https://esm.sh/@tauri-apps/plugin-http@2');
        tauriHttpFetch = mod.fetch;
      }
      return await tauriHttpFetch(url, { ...opts, headers: opts.headers });
    } catch {
      throw firstErr;
    }
  }
}

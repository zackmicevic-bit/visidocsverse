// licensing-manager.js — Lemon Squeezy license activation, HMAC-secured
// local caching, and offline startup validation for VisiDocsverse.
//
// Subscription build (weekly online check), one file:
//   1-2. activateLicenseKey() — online Lemon Squeezy activation (once per
//          install). Needs internet for this single call only.
//   3.   saveSecureCache() — persists the activation locally with an
//          HMAC-SHA256 signature so hand-edited caches fail closed.
//   4.   verifyLicenseOnStartup() — subscription gate: caches younger than
//          checkIntervalDays (7) unlock instantly with zero network; older
//          ones MUST ping Lemon Squeezy. Valid -> reseal + unlock. Invalid
//          (expired/cancelled) -> lock. Unreachable -> temporary access until
//          checkIntervalDays + offlineGraceDays (7+7), then lock until online.
//          Success paths also return the cached record as `data`.
//
// Browser-native port (no Node): WebCrypto replaces `crypto`, localStorage
// replaces the OS app-dir file (the Tauri WebView persists it in the app
// profile, same as the vault). The pre-existing fully-offline ECDSA key-file
// path in license.js is legacy-only: it is tried only when no Lemon
// subscription cache has ever existed on the machine.
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
  // Subscription policy (weekly online check):
  // - checkIntervalDays: a successful Lemon validate is good for 7 days.
  //   Launches inside this window unlock instantly with zero network.
  // - offlineGraceDays: extra days past the check due-date where an
  //   unreachable network still grants temporary access (travel tolerance).
  //   Past checkIntervalDays + offlineGraceDays with no successful check,
  //   the app locks until it can reach Lemon Squeezy — even if offline.
  // - graceDays is the legacy alias (30 in perpetual builds); old caches
  //   storing 30 are clamped to the weekly policy below, so the shift to
  //   subscriptions takes effect immediately on update.
  checkIntervalDays: 7,
  offlineGraceDays: 7,
  graceDays: 7,
};

const te = new TextEncoder();

function hexOf(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Machine-stable secret for the local HMAC (tamper-evidence only — it is
// derived from public browser attributes, so it cannot stop a determined
// user, and isn't meant to; Lemon Squeezy instances are the real check).
// Stability matters more than uniqueness here: the old fingerprint included
// navigator.userAgent (which embeds the WebView2/Chrome version that
// auto-updates silently every few days) and navigator.language, so a
// background WebView update rotated the secret, the stored HMAC stopped
// matching, and a perfectly good activation started failing as "tampered"
// after a few days of not opening the app. The stable fingerprint uses only
// platform + CPU count, which survive WebView/OS updates and language flips.
async function getLocalMachineSecret() {
  let platform = '';
  let cores = '';
  try {
    platform = navigator.platform || (navigator.userAgentData && navigator.userAgentData.platform) || '';
    cores = String(navigator.hardwareConcurrency || '');
  } catch { /* private mode */ }
  const digest = await crypto.subtle.digest('SHA-256', te.encode('visidocsverse-lemon|' + platform + '|' + cores));
  return hexOf(digest);
}

// Pre-1.0.20 fingerprint (UA + language included). Kept for migration only:
// caches signed before the fix verify against this when the UA hasn't
// rotated since signing, so they migrate forward instead of re-prompting.
async function getLegacyMachineSecret() {
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
export async function activateLicenseKey(licenseKey, machineName = 'VisiDocsVerse Desktop') {
  const key = String(licenseKey || '').trim();
  if (!key) return { success: false, message: 'Enter the license key from your purchase email first.' };
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return { success: false, message: 'This copy cannot sign keys here (WebCrypto is unavailable) — open Visi|Docsverse through its installed launcher.' };
  }
  let data = null;
  try {
    const params = new URLSearchParams();
    params.append('license_key', key);
    params.append('instance_name', String(machineName || 'VisiDocsVerse Desktop').slice(0, 80));
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

// Read-only snapshot of the local Lemon cache for status surfaces (no
// network, never throws): {present, ok, reason?, email?, activated_at?, last_validated_at?}.
export async function lemonCacheStatus() {
  try {
    const seen = await loadAndVerifyCache();
    if (!seen.ok) return { present: seen.reason !== 'missing', ok: false, reason: seen.reason };
    const d = seen.data || {};
    return { present: true, ok: true, email: d.customer_email || '', activated_at: d.activated_at || 0, last_validated_at: d.last_validated_at || 0 };
  } catch { return { present: false, ok: false, reason: 'unreadable' }; }
}

// Returns {ok, data?, reason?}: ok when the cache parses AND its HMAC
// verifies (stable secret, then legacy secret for pre-fix migration).
// Fails closed WITHOUT deleting: wiping on a transient mismatch is what
// turned one background WebView update into a permanent deactivation. Only
// explicit deactivate / successful re-activation overwrites the cache.
async function loadAndVerifyCache() {
  const raw = readLemonCacheRaw();
  if (!raw) return { ok: false, reason: 'missing' };
  let obj = null;
  try { obj = JSON.parse(raw); }
  catch { return { ok: false, reason: 'unreadable' }; }
  if (!obj || typeof obj !== 'object' || typeof obj.signature_hash !== 'string') return { ok: false, reason: 'unreadable' };
  const { signature_hash, ...payload } = obj;
  // Shape first: a license_key WITHOUT its server-issued instance_id is not
  // a completed activation (Lemon always returns one), so hand-made/partial
  // caches fail closed here — without deleting anything.
  if (obj.app_name !== LEMON.appName || typeof obj.license_key !== 'string' || !obj.license_key) {
    return { ok: false, reason: 'unreadable' };
  }
  if (typeof obj.instance_id !== 'string' || !obj.instance_id) {
    return { ok: false, reason: 'no-instance' };
  }
  try {
    const expected = await hmacHex(await getLocalMachineSecret(), JSON.stringify(payload));
    if (signature_hash === expected) return { ok: true, data: obj };
  } catch { return { ok: false, reason: 'crypto' }; }
  // Pre-fix migration: same UA as today, sealed before the stable fingerprint.
  // If the WebView already auto-updated while the app was closed, neither
  // secret matches and this install asks once more — after that one
  // re-activation the stable seal survives all future updates.
  try {
    const legacy = await hmacHex(await getLegacyMachineSecret(), JSON.stringify(payload));
    if (signature_hash === legacy) {
      try { await saveSecureCache(payload); } catch {}
      try {
        const migrated = JSON.parse(readLemonCacheRaw());
        if (migrated && migrated.signature_hash) return { ok: true, data: migrated };
      } catch {}
      return { ok: true, data: obj };
    }
  } catch {}
  return { ok: false, reason: 'tampered' };
}

// Purges development/legacy license artifacts from localStorage so they can
// never satisfy the boot guard. Desktop shells only (no-op in the preview).
// Real activations are NEVER touched: only pre-rename legacy keys, dev/test
// key names, and caches holding obvious placeholder key strings. Returns the
// removed key names (diagnostics). There is no license data in IndexedDB
// (images/originals only), so nothing to clear there.
export function clearDevLicenseCaches() {
  const removed = [];
  try {
    if (typeof localStorage === 'undefined') return removed;
    // 1. pre-rename legacy keys (kept migrating by mvLs — drop the stragglers)
    for (const k of ['docuverse.license.v1', 'docuverse.lemon.v1']) {
      try {
        if (localStorage.getItem(k) != null) { localStorage.removeItem(k); removed.push(k); }
      } catch {}
    }
    // 2. any dev/test-named license key that is not one of the real caches
    const real = new Set([LEMON.cacheKey, 'visidocsverse.license.v1']);
    try {
      const victims = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || real.has(k)) continue;
        if (/licen[sc]e/i.test(k) && /(^|[^a-z])(dev|test|debug|mock|fake|sample)([^a-z]|$)/i.test(k)) victims.push(k);
      }
      for (const k of victims) { try { localStorage.removeItem(k); removed.push(k); } catch {} }
    } catch {}
    // 3. a real-named cache holding an obvious placeholder key (never a
    // Lemon-issued token — those are long). Fail closed: wipe, re-prompt.
    try {
      const raw = localStorage.getItem(LEMON.cacheKey);
      if (raw) {
        let obj = null;
        try { obj = JSON.parse(raw); } catch { obj = null; }
        const k = obj && typeof obj.license_key === 'string' ? obj.license_key.trim() : '';
        if (!k || k.length < 8 || /^(test|dev|demo|placeholder|sample|xxx+|changeme|your[-_ ]?key)$/i.test(k)) {
          localStorage.removeItem(LEMON.cacheKey);
          removed.push(LEMON.cacheKey + ' (placeholder key)');
        }
      }
    } catch {}
  } catch {}
  return removed;
}

// STEP 4: subscription startup lifecycle — weekly online check.
// Returns a VerificationResult (success paths carry the cached record as
// `data`). Launches inside checkIntervalDays unlock instantly with zero
// network (the "ping once a week"). Past the due date the app MUST reach
// Lemon Squeezy: valid -> reseal + unlock; invalid/expired -> lock; offline
// -> temporary access until checkIntervalDays + offlineGraceDays, then lock
// until online. Never throws.
export async function verifyLicenseOnStartup() {
  const seen = await loadAndVerifyCache();
  if (!seen.ok) {
    if (seen.reason === 'missing') return { isValid: false, statusMessage: 'No active Visi|Docsverse subscription found. Please enter your license key.' };
    if (seen.reason === 'no-instance') return { isValid: false, statusMessage: 'License record is incomplete (missing instance). Please re-enter your key to reactivate.' };
    if (seen.reason === 'tampered') return { isValid: false, statusMessage: 'License cache file integrity check failed. Please re-enter your key.' };
    if (seen.reason === 'crypto') return { isValid: false, statusMessage: 'This copy cannot verify keys here (WebCrypto is unavailable).' };
    return { isValid: false, statusMessage: 'Error reading local license configuration.' };
  }
  const c = seen.data;
  const now = Math.floor(Date.now() / 1000);
  const secondsElapsed = now - (c.last_validated_at || 0);
  const daysElapsed = secondsElapsed / (60 * 60 * 24);
  // Enforce the weekly policy even for caches sealed under the old 30-day
  // perpetual policy (stored value is ignored when larger).
  const interval = LEMON.checkIntervalDays;
  const maxOffline = LEMON.checkIntervalDays + LEMON.offlineGraceDays;
  // Within the check window: unlock instantly, no Wi-Fi needed.
  if (daysElapsed < interval) {
    return { isValid: true, statusMessage: 'Visi|Docsverse Pro unlocked (Offline Verified).', data: c };
  }
  // Check due -> must ping Lemon Squeezy now.
  const res = await backgroundRevalidate(c.license_key, c.instance_id);
  if (res.outcome === 'valid') {
    const updated = { ...c, last_validated_at: now };
    try { await saveSecureCache(updated); } catch {}
    return { isValid: true, statusMessage: 'Subscription validated online successfully.', data: updated };
  }
  if (res.outcome === 'invalid') {
    return { isValid: false, statusMessage: res.message || 'This subscription is no longer active (expired, cancelled, or key reset). Please renew or re-enter your key.', data: c };
  }
  // Offline / unreachable: temporary travel tolerance, then hard lock.
  if (daysElapsed < maxOffline) {
    const left = Math.max(0, Math.ceil(maxOffline - daysElapsed));
    return { isValid: true, statusMessage: `Offline Mode: weekly subscription check could not reach Lemon Squeezy. Connect within ${left} day${left === 1 ? '' : 's'} to stay activated.`, data: c };
  }
  return { isValid: false, statusMessage: 'Weekly subscription check overdue — connect to the internet so Visi|Docsverse can validate your subscription.', data: c };
}

// Weekly ping: distinguishes subscription-cancelled (lock) from
// network-unreachable (temporary grace). Returns
// {outcome:'valid'|'invalid'|'offline', message?}.
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
    let data = null;
    try { data = await response.json(); }
    catch { return { outcome: 'offline', message: `Validation server answered ${response.status}.` }; }
    if (data && data.valid === true) return { outcome: 'valid' };
    if (data && data.valid === false) {
      return { outcome: 'invalid', message: (data && data.error) || 'This subscription is no longer active (expired, cancelled, or key reset). Please renew or re-enter your key.' };
    }
    // Unexpected shape (non-OK without a valid flag): treat 4xx/5xx with an
    // error as invalid only when Lemon explicitly says so; otherwise offline.
    return { outcome: 'offline', message: 'Validation unreachable.' };
  } catch {
    return { outcome: 'offline', message: 'Network unavailable.' };
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

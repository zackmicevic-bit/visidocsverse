// trial.js — free 21-day trial store for VisiDocsverse desktop installs.
//
// Same binary, no key, no network: the first desktop launch with no paid
// license starts the trial automatically. After TRIAL_DAYS the app goes
// read-only (browse/search/read/export/backups keep working; new intake,
// new notes and new canvases are gated) until the user subscribes.
//
// Casual licensing, not DRM: the record is HMAC-signed (tamper-evident, same
// recipe as licensing-manager.js) and mirrored across two localStorage slots
// so wiping one slot cannot silently restart the clock. A determined user can
// wipe the whole WebView profile — accepted, by design. Real entitlement
// lives in Dodo Payments; the trial only decides when the paywall appears.
// The trial is fully offline: day-counting is local, no phone-home.

export const TRIAL_DAYS = 21;
export const TRIAL_SECS = TRIAL_DAYS * 24 * 60 * 60;
export const TRIAL_KEY = 'visidocsverse.trial.v1';
export const TRIAL_MIRROR_KEY = 'visidocsverse.trial.mirror.v1';
export const SUBSCRIBE_URL = 'https://dodo.pe/visidocsverse';
export const TRIAL_DOWNLOAD_URL = 'https://visidocsverse-site.vercel.app/download'; // clean redirect -> free Dodo product (see src/site/download.html + vercel.json). TODO: swap to https://visidocsverse.com/download once the custom domain is live.

const te = new TextEncoder();

function hexOf(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Domain-separated from the Dodo cache secret so the two HMACs never collide.
async function trialSecret() {
  let platform = '';
  let cores = '';
  try {
    platform = navigator.platform || (navigator.userAgentData && navigator.userAgentData.platform) || '';
    cores = String(navigator.hardwareConcurrency || '');
  } catch { /* private mode */ }
  const digest = await crypto.subtle.digest('SHA-256', te.encode('visidocsverse-trial|' + platform + '|' + cores));
  return hexOf(digest);
}

async function hmacHex(secretHex, text) {
  const keyBytes = new Uint8Array(secretHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hexOf(await crypto.subtle.sign('HMAC', key, te.encode(text)));
}

function readSlot(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function writeSlot(k, v) {
  try { localStorage.setItem(k, v); } catch { /* storage blocked: trial lasts this session */ }
}

async function seal(rec) {
  const { sig: _drop, ...clean } = rec || {};
  const json = JSON.stringify(clean);
  const sig = await hmacHex(await trialSecret(), json);
  return { ...clean, sig };
}

async function openSealed(raw) {
  if (!raw) return { ok: false, reason: 'missing' };
  let obj = null;
  try { obj = JSON.parse(raw); } catch { return { ok: false, reason: 'unreadable' }; }
  if (!obj || typeof obj !== 'object' || typeof obj.sig !== 'string') return { ok: false, reason: 'unreadable' };
  if (typeof obj.startedAt !== 'number' || !(obj.startedAt > 0)) return { ok: false, reason: 'unreadable' };
  const { sig, ...payload } = obj;
  try {
    const expected = await hmacHex(await trialSecret(), JSON.stringify(payload));
    if (sig === expected) return { ok: true, data: obj };
  } catch { return { ok: false, reason: 'crypto' }; }
  return { ok: false, reason: 'tampered' };
}

async function persist(rec) {
  const sealed = await seal(rec);
  const raw = JSON.stringify(sealed);
  writeSlot(TRIAL_KEY, raw);
  writeSlot(TRIAL_MIRROR_KEY, raw);
  return sealed;
}

// True inside a real install (desktop shell). Mirrors license.js so this
// module stays import-cycle free (license.js imports trial.js, never back).
export function isTrialShell() {
  try {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__) return true;
    if (window.NL_PORT != null || window.NL_TOKEN != null || window.NL_APPID != null || window.NL_VERSION != null) return true;
    if (typeof Neutralino !== 'undefined') return true;
    const p = String(location.protocol || '').toLowerCase();
    if (p === 'file:' || p === 'tauri:' || p === 'wry:' || p === 'app:') return true;
    if (/tauri\.localhost$/i.test(location.hostname)) return true;
  } catch {}
  return false;
}

// Create the trial record on first use. Restores primary from mirror when
// only one side survives; never overwrites a valid record.
export async function ensureTrialStarted(nowSec) {
  const now = nowSec || Math.floor(Date.now() / 1000);
  try {
    const a = await openSealed(readSlot(TRIAL_KEY));
    if (a.ok) return a.data;
    const b = await openSealed(readSlot(TRIAL_MIRROR_KEY));
    if (b.ok) {
      try {
        const sealed = await seal(b.data);
        writeSlot(TRIAL_KEY, JSON.stringify(sealed));
      } catch {}
      return b.data;
    }
    if (a.reason !== 'missing' || b.reason !== 'missing') return null; // tampered/unreadable: caller treats as expired
    const rec = { v: 1, startedAt: now, lastSeenAt: now };
    return await persist(rec);
  } catch { return null; }
}

// Read-only snapshot: {mode:'active'|'expired'|'tampered', daysUsed, daysLeft,
// startedAt, fresh}. Never throws. Touches lastSeenAt forward (monotonic — a
// rolled-back clock can never extend the trial).
export async function trialStatus() {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      return { mode: 'tampered', daysUsed: TRIAL_DAYS, daysLeft: 0, startedAt: 0, crypto: true };
    }
    let seen = await openSealed(readSlot(TRIAL_KEY));
    if (!seen.ok) {
      const m = await openSealed(readSlot(TRIAL_MIRROR_KEY));
      if (m.ok) {
        seen = m;
        try {
          const sealed = await seal(m.data);
          writeSlot(TRIAL_KEY, JSON.stringify(sealed));
        } catch {}
      } else {
        if ((seen.reason === 'missing' || seen.reason === 'unreadable') && (m.reason === 'missing' || m.reason === 'unreadable')) {
          return { mode: 'active', daysUsed: 0, daysLeft: TRIAL_DAYS, startedAt: 0, fresh: true };
        }
        return { mode: 'tampered', daysUsed: TRIAL_DAYS, daysLeft: 0, startedAt: 0 };
      }
    }
    const d = seen.data;
    const now = Math.floor(Date.now() / 1000);
    const last = (typeof d.lastSeenAt === 'number' && d.lastSeenAt > 0) ? d.lastSeenAt : d.startedAt;
    const rolledBack = now < last - 3600;
    const eff = Math.max(now, last);
    const elapsed = Math.max(0, eff - d.startedAt);
    const daysUsed = Math.min(TRIAL_DAYS, Math.floor(elapsed / 86400));
    const remain = d.startedAt + TRIAL_SECS - eff;
    const daysLeft = remain <= 0 ? 0 : Math.min(TRIAL_DAYS, Math.ceil(remain / 86400));
    if (now > last) {
      try { await persist({ ...d, lastSeenAt: now }); } catch {}
    }
    if (remain <= 0) return { mode: 'expired', daysUsed: TRIAL_DAYS, daysLeft: 0, startedAt: d.startedAt, rolledBack };
    return { mode: 'active', daysUsed, daysLeft, startedAt: d.startedAt, rolledBack };
  } catch { return { mode: 'tampered', daysUsed: TRIAL_DAYS, daysLeft: 0, startedAt: 0 }; }
}

export function trialEndDate(startedAt) {
  try {
    if (!startedAt) return '';
    return new Date((startedAt + TRIAL_SECS) * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return ''; }
}

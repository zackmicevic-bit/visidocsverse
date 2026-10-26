// make-key.mjs — offline license key tooling (DEVELOPER MACHINE ONLY).
//
// The private key this manages must NEVER enter the repo or a build:
// keep it on an encrypted drive / password manager. The installer only
// ever carries the PUBLIC half (src/license.js LICENSE_PUBLIC_JWK).
//
//   node make-key.mjs gen [--out <dir>]     create a fresh signing pair
//   node make-key.mjs sign <private.json> <email> [issued]
//
// `gen` prints the LICENSE_PUBLIC_JWK block to paste into src/license.js
// and writes the private half to <out>/visidocsverse-signing-private.json.
// `sign` prints the customer key FILE text (email it / ship it on a USB —
// any delivery channel works; the file is verified offline in the app).
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { subtle } from 'node:crypto';

const PRODUCT = 'visidocsverse';

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function usage() {
  console.log('usage:\n  node make-key.mjs gen [--out <dir>]\n  node make-key.mjs sign <private.json> <email> [issued=YYYY-MM-DD]');
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) usage();

if (cmd === 'gen') {
  let out = '.';
  const oi = rest.indexOf('--out');
  if (oi >= 0) out = rest[oi + 1] || out;
  mkdirSync(out, { recursive: true });
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = await subtle.exportKey('jwk', kp.publicKey);
  const priv = await subtle.exportKey('jwk', kp.privateKey);
  const privPath = join(out, 'visidocsverse-signing-private.json');
  writeFileSync(privPath, JSON.stringify({ kty: 'ECDSA-P256-signing', product: PRODUCT, created: new Date().toISOString().slice(0, 10), privateJwk: priv }, null, 2));
  try { chmodSync(privPath, 0o600); } catch {}
  console.log('--- paste into src/license.js LICENSE_PUBLIC_JWK ---');
  console.log(JSON.stringify({ kty: pub.kty, crv: pub.crv, x: pub.x, y: pub.y }, null, 2));
  console.log('--- private key (KEEP SECRET, never commit) ---');
  console.log(privPath);
} else if (cmd === 'sign') {
  const [privPath, email, issuedArg] = rest;
  if (!privPath || !email || !email.includes('@')) usage();
  const wrap = JSON.parse(readFileSync(privPath, 'utf8'));
  if (wrap.product !== PRODUCT || !wrap.privateJwk) throw new Error('not a ' + PRODUCT + ' signing key: ' + privPath);
  const issued = issuedArg || new Date().toISOString().slice(0, 10);
  const key = await subtle.importKey('jwk', wrap.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const data = new TextEncoder().encode([PRODUCT, email.trim().toLowerCase(), issued].join('|'));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  console.log(JSON.stringify({ product: PRODUCT, email: email.trim().toLowerCase(), issued, sig: b64url(sig) }));
} else usage();

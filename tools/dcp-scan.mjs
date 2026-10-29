// dcp-scan.mjs — list every file DCP Setup Maker should package.
// usage: node ./tools/dcp-scan.mjs [root]
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(process.argv[2] || new URL('..', import.meta.url).pathname);
const skip = new Set(['node_modules', '.git', 'dist']);
const out = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    if (skip.has(e)) continue;
    const p = join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else out.push({ file: p.slice(root.length + 1).replace(/\\/g, '/'), bytes: st.size });
  }
})(root);
const total = out.reduce((a, b) => a + b.bytes, 0);
console.log(JSON.stringify({ root, files: out.length, bytes: total, filesList: out.map(o => o.file) }, null, 2));

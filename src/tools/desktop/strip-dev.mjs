// strip-dev.mjs — remove developer-only code from a desktop export.
//
// The web app keeps a merged "DEV" pane (cloud backup above dev builds) that
// is dev-gated at runtime. Desktop installers must not bundle it at all, so
// the export recipe copies the frontend into dist/ and then runs:
//
//   node strip-dev.mjs [distDir]
//
// It deletes every DEV-ONLY range (index.html + src/app.js) and drops the dev
// handles from the __visidocsverse console object. Fails loudly if a marker is
// missing or unbalanced, so a half-stripped build can never ship silently.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(process.argv[2] || join(here, 'dist'));

function stripRanges(text, startRe, endRe, label) {
  const starts = [...text.matchAll(startRe)].map(m => m.index);
  const ends = [...text.matchAll(endRe)].map(m => m.index + m[0].length);
  if (!starts.length) throw new Error(`${label}: no DEV-ONLY-START marker found`);
  if (starts.length !== ends.length)
    throw new Error(`${label}: unbalanced markers (${starts.length} START vs ${ends.length} END)`);
  for (let i = 0; i < starts.length; i++) {
    if (ends[i] <= starts[i]) throw new Error(`${label}: END before START at pair ${i + 1}`);
    if (i + 1 < starts.length && starts[i + 1] < ends[i])
      throw new Error(`${label}: nested/overlapping ranges at pair ${i + 1}`);
  }
  // remove back-to-front so earlier indices stay valid
  let out = text, removed = 0;
  for (let i = starts.length - 1; i >= 0; i--) {
    removed += ends[i] - starts[i];
    out = out.slice(0, starts[i]) + out.slice(ends[i]);
  }
  return { out, pairs: starts.length, removed };
}

// ---- index.html: drop the whole DEV pane ----
{
  const p = join(dist, 'index.html');
  let html = readFileSync(p, 'utf8');
  const { out, pairs, removed } = stripRanges(
    html,
    /<!-- DEV-ONLY-START -->/g,
    /<!-- DEV-ONLY-END -->/g,
    'index.html'
  );
  html = out.replace(/<div id="devBox"[^>]*>\s*<\/div>/, '');
  if (/<div id="devBox"/.test(html)) throw new Error('index.html: DEV pane shell not fully removed');
  if (/DEV-ONLY/.test(html)) throw new Error('index.html: leftover DEV-ONLY marker after strip');
  // (Dead #devBox CSS selectors intentionally remain: they match no element
  // once the pane is gone, and per-selector surgery risks mangling shared
  // rules like `#leftPanel, #docPanel, #devBox`. The cbLast/devNote/devEdit
  // rules below are removed because those lines belong to no shared rule.)
  if (/id="devBox"|pushBtn|loadInput|mergeInput|devWin|cbStatus/.test(html))
    throw new Error('index.html: leftover DEV pane markup after strip');
  // dead CSS: rules that only styled the removed pane's elements
  const cssLines = html.split('\n');
  const keptLines = cssLines.filter(l => !/#(cbLast|devNote|devEdit)\b/.test(l));
  const cssRemoved = cssLines.length - keptLines.length;
  html = keptLines.join('\n');
  writeFileSync(p, html);
  console.log(`index.html: removed ${pairs} DEV range(s), ${removed} chars + ${cssRemoved} dead CSS lines`);
}

// ---- src/app.js: drop dev-only behavior, keep user features ----
{
  const p = join(dist, 'src', 'app.js');
  let js = readFileSync(p, 'utf8');
  const { out, pairs, removed } = stripRanges(
    js,
    /\/\/ DEV-ONLY-START/g,
    /\/\/ DEV-ONLY-END.*(?:\n|$)/g,
    'src/app.js'
  );
  js = out;
  // the __visidocsverse console object references stripped dev handles: drop them.
  for (const needle of [
    'get devBuilds() { return { ...devBuilds }; }, setDevBuilds, isDev, renderDevBox, ',
    'loadBackupFromText, mergeBackupFromText, ',
  ]) {
    if (!js.includes(needle))
      throw new Error(`src/app.js: __visidocsverse segment not found (already stripped?): ${needle.slice(0, 40)}…`);
    js = js.replace(needle, '');
  }
  if (/DEV-ONLY/.test(js)) throw new Error('src/app.js: leftover DEV-ONLY marker after strip');
  for (const name of ['pushBackup', 'renderDevBox', 'setDevBuilds', 'renderCloudBox', 'isDev(', 'loadBackupFromText', 'mergeBackupFromText', 'devBuilds', 'backupHist']) {
    if (new RegExp(`\\b${name}\\b`).test(js))
      throw new Error(`src/app.js: leftover reference to stripped dev code: ${name}`);
  }
  writeFileSync(p, js);
  console.log(`src/app.js: removed ${pairs} DEV range(s), ${removed} chars + __visidocsverse dev handles`);
}

console.log('strip-dev: OK — dist/ carries no DEV pane code');

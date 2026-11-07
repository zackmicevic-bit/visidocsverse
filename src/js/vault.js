// VisiDocsverse vault: local-first document store (browser adaptation of the Rust/SQLite pillar).
// - Folder intake via File System Access API (showDirectoryPicker) + drag-drop + file picker
// - Mass = word count + reference frequency. Connections = [[wikilinks]] + shared tags.
const LS_KEY = 'visidocsverse.v1';
const TABS_KEY = 'visidocsverse.tabsV1'; // multi-canvas store: {tabs:[{id,name,docs,activeId,main,assoc:[tabIds]}], activeTabId} (assoc is mutual; empty = isolated)
const TABS_CORRUPT_PREFIX = 'visidocsverse.tabsV1.corrupt.'; // forensic archives: raw store bytes saved here before any reseed overwrites them

// Never silently overwrite a populated store with a fresh seed: stash the raw
// bytes under a timestamped key (keeping the 3 newest) so a failed parse or
// validation can always be diagnosed and restored. Runs before any seed persist.
function archiveCorruptTabs(raw) {
  try {
    if (!raw) return;
    try { localStorage.setItem(TABS_CORRUPT_PREFIX + Date.now(), String(raw)); } catch { return; }
    try {
      const ks = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(TABS_CORRUPT_PREFIX) === 0) ks.push(k);
      }
      ks.sort();
      while (ks.length > 3) localStorage.removeItem(ks.shift());
    } catch { /* pruning is best-effort */ }
  } catch { /* archiving must never break boot */ }
}
const STOP = new Set(('a,about,above,after,again,against,all,also,am,an,and,any,are,as,at,be,because,been,before,being,below,between,both,but,by,can,could,did,do,does,doing,down,during,each,few,for,from,further,had,has,have,having,he,her,here,hers,herself,him,himself,his,how,if,in,into,is,it,its,itself,more,most,nor,not,of,off,on,once,only,or,other,ought,our,ours,out,over,own,same,should,such,than,that,the,their,them,then,there,these,they,this,those,through,under,until,very,was,were,what,when,where,which,while,who,whom,why,with,would,your,will,just,often,however,therefore,thus,within,without,upon,along,among,used,using,use,study,studies,research,based,including,include,chapter,chapters,page,pages,table,tables,figure,figures,abstract,references,reference,appendix,method,methods,literature,introduction,conclusion,findings,analysis,et,al,via,per').split(','));

// reference lists are NOT what a document is about: a trailing References /
// Works Cited / Bibliography section repeats cited-author names dozens of times,
// which would otherwise forge "shared ground" between unrelated assignments that
// merely cite the same scholars. Strip that section (only) before topic analysis.
// Mass/word-count still uses the full text — this affects topic matching only.
function stripRefs(text) {
  const lines = String(text || '').split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/^#+\s*/, '').trim().toLowerCase();
    if (l === 'references' || l === 'reference' || l === 'works cited' || l === 'bibliography') cut = i;
  }
  if (cut < 0) return String(text || '');
  // keep the body only if something substantial precedes the heading (else a doc
  // that IS mostly references keeps its text — never return an empty analysis)
  const head = lines.slice(0, cut).join('\n');
  return head.trim().length > 200 ? head : String(text || '');
}
function termFreq(text) {
  const m = new Map();
  for (const w of (String(text).toLowerCase().match(/[a-z]{4,}/g) || [])) {
    if (STOP.has(w)) continue;
    m.set(w, (m.get(w) || 0) + 1);
  }
  return m;
}

// corpus analysis: TF-IDF vectors per doc + pairwise topic similarity.
// Lets imported Office/PDF prose tether by what it's ABOUT, not just markup.
// idfFloor: idf is computed against max(docs, idfFloor) — a lone handful of docs
// pulled onto a small canvas share so much vocabulary that raw idf collapses and
// their sims sink below the gate, orphaning the very web that was copied over.
// The floor keeps small canvases comparable to the main universe (84+ docs).
function analyzeTopics(docs, idfFloor = 30) {
  const n = docs.length;
  const Neff = Math.max(n, idfFloor);
  const tf = new Map(); // id -> Map(term -> count)
  const df = new Map(); // term -> doc count
  for (const d of docs) {
    const f = termFreq(stripRefs(d.text));
    tf.set(d.id, f);
    for (const t of f.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, c] of df) idf.set(t, Math.log(1 + Neff / c));
  const vec = new Map(); // id -> Map(term -> tf*idf), norm
  const norm = new Map();
  for (const d of docs) {
    const v = new Map();
    let s = 0;
    for (const [t, c] of tf.get(d.id)) {
      const w = (1 + Math.log(c)) * idf.get(t);
      v.set(t, w); s += w * w;
    }
    vec.set(d.id, v); norm.set(d.id, Math.sqrt(s) || 1);
  }
  return { tf, idf, df, vec, norm };
}

function cosineTopic(a, b, T) {
  const va = T.vec.get(a.id), vb = T.vec.get(b.id);
  if (!va || !vb) return null;
  const [small, big] = va.size <= vb.size ? [va, vb] : [vb, va];
  let dot = 0;
  const shared = [];
  for (const [t, w] of small) {
    const w2 = big.get(t);
    if (w2 !== undefined) { dot += w * w2; shared.push([t, w + w2]); }
  }
  const sim = dot / (T.norm.get(a.id) * T.norm.get(b.id));
  if (!(sim > 0) || !shared.length) return null;
  // recognizable glue first: terms with high combined TF-IDF in BOTH docs
  // (rare one-off mentions sink; the words the docs are actually about float)
  shared.sort((x, y) => y[1] - x[1]);
  return { sim, shared: shared.map(s => s[0]) };
}

// distinctive high-contrast identity colors for isolated verses (shared blue is
// reserved for associated tabs, so the palette stays clear of it)
const ISO_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#3bc9db', '#b197fc', '#f783ac', '#e8eef7'];

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const uid = (p = 'd_') => p + Math.random().toString(36).slice(2, 10);

function parseDoc(text) {
  const links = [...String(text).matchAll(/\[\[([^\[\]]+?)\]\]/g)].map(m => m[1].trim().split('|')[0].trim()).filter(Boolean);
  const tags = [...String(text).matchAll(/(?:^|\s)#([A-Za-z0-9_\-/]{2,})/g)].map(m => m[1].toLowerCase());
  const words = (String(text).match(/\S+/g) || []).length;
  return { links, tags, words };
}

// ---------- auto tags: title words become tags ----------
// parseDoc only harvests explicit #hashtags, so a doc whose title says
// "…arrange the educational Programs" but whose body contains no #markup
// rendered ZERO tag pills and could never tether by tag. Auto tags close
// that gap: the filename/title's content words (never STOP words, never
// pure numbers) plus — for short/vague titles — the body's top terms.
// Stored as `auto/<word>` so they render blue, stay distinguishable from
// hand-written #tags, and can be dropped + recomputed on rename/reload
// without touching explicit tags. All matching (tethers, mass, search)
// compares the STRIPPED form, so auto/educational and #educational meet.
const AUTO_MAX = 6;
const stripAuto = (t) => String(t || '').toLowerCase().replace(/^(auto|manual)\//, '');
const isManual = (t) => String(t || '').toLowerCase().startsWith('manual/');
function titleTerms(name) {
  const seen = new Set();
  const out = [];
  for (const w of String(name || '').toLowerCase().replace(/(\.(md|markdown|txt|csv|pdf|docx?|xlsx?|pptx?|mp4|mov|mp3|wav|jpe?g|png))+$/i, '').split(/[^a-z0-9]+/)) {
    if (w.length < 3 || !/[a-z]/.test(w) || /^\d+$/.test(w) || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  // short titles keep their word order; long ones ("S7 - Evidence 1B -
  // Screenshot of the Email … educational Programs") lead with the most
  // distinctive words so the cap keeps "educational"/"programs", not filler
  if (out.length > AUTO_MAX) out.sort((a, b) => (b.length - a.length) || (a < b ? -1 : 1));
  return out.slice(0, AUTO_MAX);
}
function autoTagsFor(name, text, explicit) {
  const have = new Set((explicit || []).map(stripAuto));
  const picked = [];
  for (const w of titleTerms(name)) {
    if (have.has(w)) continue;
    have.add(w);
    picked.push('auto/' + w);
    if (picked.length >= AUTO_MAX) return picked;
  }
  // a one-word title ("Report") says little: top up from body frequency
  if (picked.length < 3) {
    const freq = termFreq(String(name || '') + '\n' + String(text || ''));
    const ranked = [...freq.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    for (const [w] of ranked) {
      if (have.has(w)) continue;
      have.add(w);
      picked.push('auto/' + w);
      if (picked.length >= AUTO_MAX) break;
    }
  }
  return picked;
}
// merge stored/explicit tags with freshly computed auto tags (stale auto/*
// entries are dropped first, so renames and text changes refresh them)
function withAutoTags(name, text, tags) {
  const explicit = (tags || []).map(String).map(s => s.trim().toLowerCase()).filter(Boolean).filter(t => !t.startsWith('auto/'));
  return [...explicit, ...autoTagsFor(name, text, explicit)];
}
// tag delete/merge support: verse-level tag ops (pop-out pane) suppress the
// auto-derived form of a removed name, otherwise title words would regenerate
// the "deleted" pill on the next recount. Explicit #tags are never suppressed —
// writing #name in any body always brings a tag back.
const TAG_RE = /^[a-z0-9_\-/]{2,}$/;
function normTagDisp(s) { return String(s || '').trim().toLowerCase().replace(/^auto\//, ''); }

// Normalize one raw doc row from disk (backup file, localStorage, legacy
// store): every downstream consumer assumes id/name/text/words/links/tags
// exist, so a single ragged row (missing links, numeric text, …) used to
// throw mid-load and abort the whole restore as "not working". Fill, coerce
// and recompute instead — never throw for a ragged row.
function normalizeDoc(raw, fallbackName) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const id = (typeof r.id === 'string' && r.id.trim()) ? r.id.trim().slice(0, 64)
    : (typeof r.docId === 'string' && r.docId.trim()) ? r.docId.trim().slice(0, 64) : uid();
  const name = String(r.name || fallbackName || 'Untitled').trim().slice(0, 160) || 'Untitled';
  const text = (typeof r.text === 'string') ? r.text
    : (typeof r.body === 'string') ? r.body
    : (typeof r.content === 'string') ? r.content : '';
  let links = Array.isArray(r.links) ? r.links.map(String).map(s => s.trim()).filter(Boolean) : null;
  let tags = Array.isArray(r.tags) ? r.tags.map(String).map(s => s.trim().toLowerCase()).filter(Boolean) : null;
  let words = (typeof r.words === 'number' && isFinite(r.words) && r.words >= 0) ? Math.round(r.words) : null;
  if (links === null || tags === null || words === null) {
    let p = null;
    try { p = parseDoc(text); } catch { p = { links: [], tags: [], words: 0 }; }
    if (links === null) links = p.links;
    if (tags === null) tags = p.tags;
    if (words === null) words = (String(text).match(/\S+/g) || []).length;
  }
  // legacy rows carry explicit-only tags (possibly none): title words join as
  // auto/* so plain-prose titles tether by tag. Recomputed deterministically
  // on every load, so old workspaces heal without a migration step.
  tags = withAutoTags(name, text, tags);
  const doc = { id, name, text, words, links, tags };
  const origin = (typeof r.origin === 'string' && r.origin.trim()) ? r.origin.trim().slice(0, 64) : undefined;
  if (origin) doc.origin = origin;
 if (typeof r.note === 'string' && r.note.trim()) doc.note = r.note.slice(0, 140);
  // notepad entries: one shared list per document lineage (sticky squares,
  // reader pop-out and the Notes book pane all read and write this list).
  // Legacy single-string `note` rows migrate into one entry on load.
  const log = [];
  if (Array.isArray(r.noteLog)) {
    for (const e of r.noteLog.slice(0, 200)) {
      if (!e || typeof e.text !== 'string' || !e.text.trim()) continue;
      const ne = { id: (typeof e.id === 'string' && e.id.trim()) ? e.id.trim().slice(0, 32) : uid('n_'), text: e.text.slice(0, 2000), at: isFinite(e.at) ? Math.round(e.at) : Date.now() };
      // pinned passage: where a sent highlight was created (same rich-anchor
      // shape as manual-tag spots — validated identically)
      const sp = e.spot;
      if (sp && typeof sp === 'object' && !Array.isArray(sp) && typeof sp.snip === 'string' && sp.snip.replace(/\s+/g, ' ').trim().length >= 2) {
        const anchor = { snip: sp.snip.replace(/\s+/g, ' ').trim().slice(0, 300) };
        if (isFinite(sp.at)) anchor.at = Math.max(0, Math.round(sp.at));
        if (Array.isArray(sp.path) && sp.path.length <= 12 && sp.path.every(n => Number.isInteger(n) && n >= 0 && n < 10000)) anchor.path = sp.path.slice();
        if (Number.isInteger(sp.off) && sp.off >= 0) anchor.off = sp.off;
        ne.spot = anchor;
      }
      log.push(ne);
    }
  }
  if (typeof r.note === 'string' && r.note.trim()) log.unshift({ id: uid('n_'), text: r.note.slice(0, 2000), at: Date.now() });
  if (log.length) doc.noteLog = log;
  if (typeof r.noteDraft === 'string' && r.noteDraft.trim()) doc.noteDraft = r.noteDraft.slice(0, 2000);
  if (typeof r.notePending === 'string' && r.notePending.trim() && log.some(e => e.id === r.notePending.trim().slice(0, 32))) doc.notePending = r.notePending.trim().slice(0, 32);
  // embedded-image manifest (bytes live in the imgstore IndexedDB sidecar —
  // never inline bytes here, localStorage quota would evict the workspace)
  if (Array.isArray(r.images)) {
    const imgs = [];
    for (const im of r.images.slice(0, 200)) {
      if (!im || typeof im.key !== 'string' || !im.key.trim()) continue;
      imgs.push({
        key: im.key.trim().slice(0, 128),
        cap: String(im.cap || 'image').slice(0, 120),
        w: Math.max(0, Math.round(Number(im.w) || 0)),
        h: Math.max(0, Math.round(Number(im.h) || 0)),
      });
    }
    if (imgs.length) doc.images = imgs;
  }
  // original-file pointer (bytes live in the origstore IndexedDB sidecar):
  // survives restores so the pointer stays valid in this browser; a byte-miss
  // (restored backup, older import) downloads as extracted text instead.
  if (typeof r.origKey === 'string' && r.origKey.trim()) doc.origKey = r.origKey.trim().slice(0, 128);
  // picture-text backfill already ran for this doc (images OCR'd into the text)
  if (r.ocrDone === true) doc.ocrDone = true;
  // backfill attempt counter: a broken OCR engine must not nag every boot —
  // the backfill seals the doc after a few failed passes (see backfillOcr)
  if (Number.isInteger(r.ocrTries) && r.ocrTries > 0) doc.ocrTries = Math.min(99, r.ocrTries);
  // manual-tag spot anchors (slug -> source snippet): survive restores, pruned
  // to tags actually present so stale anchors never linger
  if (r.manualTags && typeof r.manualTags === 'object' && !Array.isArray(r.manualTags)) {
    const mt = {};
    for (const [k, v] of Object.entries(r.manualTags).slice(0, 200)) {
      const kk = normTagDisp(k);
      if (!TAG_RE.test(kk)) continue;
      if (typeof v === 'string' && v.trim()) mt[kk] = v.slice(0, 300);
      else if (v && typeof v === 'object' && typeof v.snip === 'string' && v.snip.trim()) {
        // rich anchor: snippet + stripped offset + DOM path of the creation range
        const e = { snip: v.snip.slice(0, 300) };
        if (isFinite(v.at)) e.at = Math.max(0, Math.round(v.at));
        if (Array.isArray(v.path) && v.path.length <= 12 && v.path.every(n => Number.isInteger(n) && n >= 0 && n < 10000)) e.path = v.path.slice();
        if (Number.isInteger(v.off) && v.off >= 0) e.off = v.off;
        mt[kk] = e;
      }
    }
    if (Object.keys(mt).length) doc.manualTags = mt;
  }
  if (doc.manualTags) {
    for (const k of Object.keys(doc.manualTags)) {
      if (!tags.includes('manual/' + k)) delete doc.manualTags[k];
    }
    if (!Object.keys(doc.manualTags).length) delete doc.manualTags;
  }
  // preserve unknown future fields only when JSON-safe (skip functions/DOM)
  for (const k of ['createdAt', 'updatedAt', 'mtime', 'color']) {
    if (r[k] !== undefined && (typeof r[k] === 'string' || typeof r[k] === 'number')) doc[k] = r[k];
  }
  return doc;
}

export const vault = {
  tabs: [], // canvases: [{id, name, docs[], activeId}]
  activeTabId: null,
  tab() { return this.tabs.find(t => t.id === this.activeTabId) || this.tabs[0]; },
  get docs() { const t = this.tab(); return t ? t.docs : []; },
  set docs(v) { const t = this.tab(); if (t) t.docs = v; },
  topicSim: 0.10,   // min TF-IDF cosine to be a topic *candidate*
  topicShared: 3,   // min shared terms to be a topic *candidate*
  topicMaxDf: 1.0,  // shared terms must appear in at most this fraction of docs
  topicTopK: 5,     // each doc keeps tethers to at most its K closest topics
  topicIdfFloor: 30, // idf sample-size floor: small canvases stay comparable to big ones

  // normalize one raw doc row (backup restore, storage repair)
  normalizeDoc,
  stripAuto, // 'auto/x'/'manual/x' -> 'x': pills, search and tethers compare the stripped form
  isManual, // 'manual/x' -> true: hand-made reader tags, gold-M badged, never parsed from text
  // per-canvas auto-tag suppression (tag delete/merge in the tags pop-out).
  // suppressedOf(tab) -> Set of stripped names whose auto/* form stays hidden.
  // applySuppress(doc, tab?) strips those auto/* entries from one doc (tab
  // defaults to the doc's owning canvas, else the active one). Explicit #tags
  // are never suppressed. suppressTag(tab, disp) records a name + persists.
  suppressedOf(tab) {
    const tb = (typeof tab === 'string') ? this.tabs.find(t => t.id === tab) : (tab || this.tab());
    const a = (tb && Array.isArray(tb.suppressedTags)) ? tb.suppressedTags : [];
    return new Set(a.map(normTagDisp).filter(s => TAG_RE.test(s)));
  },
  applySuppress(doc, tab) {
    if (!doc || !Array.isArray(doc.tags) || !doc.tags.length) return doc;
    let owner = tab;
    if (owner === undefined) {
      try { owner = this.tabs.find(t => (t.docs || []).includes(doc)) || this.tab(); }
      catch { owner = null; }
    }
    const sup = this.suppressedOf(owner);
    if (!sup.size) return doc;
    doc.tags = doc.tags.filter(tg => !(String(tg).startsWith('auto/') && sup.has(stripAuto(tg))));
    return doc;
  },
  suppressTag(tab, disp) {
    const tb = (typeof tab === 'string') ? this.tabs.find(t => t.id === tab) : (tab || this.tab());
    if (!tb) return false;
    const d = normTagDisp(disp);
    if (!TAG_RE.test(d)) return false;
    if (!Array.isArray(tb.suppressedTags)) tb.suppressedTags = [];
    if (!tb.suppressedTags.map(normTagDisp).includes(d)) {
      tb.suppressedTags.push(d);
      if (tb.suppressedTags.length > 200) tb.suppressedTags = tb.suppressedTags.slice(-200);
    }
    this.persist();
    return true;
  },
  // normalize raw tab rows (load + backup restore): ids, names, mutual assoc
  // lists. Legacy `disassociated:false` rows join the whole legacy shared
  // pool; legacy isolated rows start alone. Unknown/stale ids are dropped.
  // Ragged rows never throw: missing ids are minted, missing docs default to
  // [], and every doc passes through normalizeDoc so universe()/renderDoc()
  // can always assume id/name/text/words/links/tags exist.
  adoptTabs(rawTabs) {
    if (!Array.isArray(rawTabs) || !rawTabs.length) throw new Error('That backup has no canvases (tabs is empty).');
    const seenTabIds = new Set();
    const tabs = rawTabs.map((rt, ti) => {
      const t = (rt && typeof rt === 'object') ? rt : {};
      let id = (typeof t.id === 'string' && t.id.trim()) ? t.id.trim().slice(0, 64) : uid('tab_');
      while (seenTabIds.has(id)) id = uid('tab_');
      seenTabIds.add(id);
      const rawDocs = Array.isArray(t.docs) ? t.docs : (Array.isArray(t.documents) ? t.documents : []);
      const seenDocIds = new Set();
      const docs = rawDocs.map((rd, di) => {
        const d = normalizeDoc(rd, 'Untitled ' + (di + 1));
        while (seenDocIds.has(d.id)) d.id = uid();
        seenDocIds.add(d.id);
        if (d.origin && !seenDocIds.has(d.origin)) { /* cross-tab lineage stays as-is */ }
        return d;
      });
      // cross-tab duplicate doc ids (same body copied verbatim with the same id
      // instead of a fresh copy id) would collapse twin tracking — mint fresh
      // ids for repeats beyond the first occurrence across the whole file.
      // suppressedTags: auto-tag names deleted/merged away on this canvas (kept
      // through backups/restores so the removed names don't regenerate).
      const _supp = Array.isArray(t.suppressedTags) ? [...new Set(t.suppressedTags.map(normTagDisp).filter(s => TAG_RE.test(s)))].slice(0, 200) : [];
      return { id, name: String(t.name || ('Canvas ' + (ti + 1))).slice(0, 40), docs, _activeRaw: (t.activeId === null) ? null : (typeof t.activeId === 'string' ? t.activeId : undefined), main: t.main === true, assoc: Array.isArray(t.assoc) ? t.assoc.map(String) : null, color: (typeof t.color === 'string' && /^#[0-9a-f]{6}$/i.test(t.color)) ? t.color : null, suppressedTags: _supp, _iso: t.disassociated === true, lastMsg: (typeof t.lastMsg === 'string' ? t.lastMsg : '').slice(0, 500) };
    });
    // second pass: de-dupe doc ids ACROSS tabs (keep the first, mint the rest)
    {
      const seen = new Set();
      for (const t of tabs) for (const d of t.docs) {
        if (seen.has(d.id)) d.id = uid();
        seen.add(d.id);
      }
    }
    for (const t of tabs) {
      const ids = new Set(t.docs.map(d => d.id));
      if (t._activeRaw === null && t.docs.length) t.activeId = null; // explicit general state
      else if (typeof t._activeRaw === 'string' && ids.has(t._activeRaw)) t.activeId = t._activeRaw;
      else t.activeId = t.docs[0]?.id || null;
      delete t._activeRaw;
    }
    const ids = new Set(tabs.map(t => t.id));
    const pool = tabs.filter(t => !t._iso);
    for (const t of tabs) {
      if (t.assoc) t.assoc = [...new Set(t.assoc.filter(id => id !== t.id && ids.has(id)))];
      else if (!t._iso) t.assoc = pool.filter(x => x.id !== t.id).map(x => x.id);
      else t.assoc = [];
      delete t._iso;
    }
    if (!tabs.some(t => t.main)) tabs[0].main = true; // first/starting tab is the main verse
    this.tabs = tabs;
    this.ensureIsoColors();
    // enforce per-canvas auto-tag suppression: docs restored from backups (or
    // older localStorage rows) regenerate auto/* deterministically, which would
    // resurrect names the user deleted/merged away — strip them again here.
    for (const t of this.tabs) for (const d of (t.docs || [])) this.applySuppress(d, t);
    this.persist();
    return tabs;
  },

  load() {
    let raw = null;
    try { raw = localStorage.getItem(TABS_KEY); } catch { raw = null; }
    try {
      if (raw) {
        const o = JSON.parse(raw);
        if (o && Array.isArray(o.tabs) && o.tabs.every(t => t && (Array.isArray(t.docs) || Array.isArray(t.documents)))) {
          if (!o.tabs.length) {
            // an explicitly emptied workspace is valid: do not reseed it.
            this.tabs = [];
            this.activeTabId = null;
            return;
          }
          try {
            this.adoptTabs(o.tabs);
          } catch (e) { console.warn('stored tabs unusable, reseeding (raw archived)', e); archiveCorruptTabs(raw); throw e; }
          if (!this.tabs.some(t => t.id === o.activeTabId)) o.activeTabId = this.tabs[0].id;
          this.activeTabId = o.activeTabId;
          return;
        }
        // bytes exist but are not a valid tabs payload: archive before seeding over them.
        archiveCorruptTabs(raw);
      }
    } catch (e) {
      // parse failed (or adopt failed above): the raw bytes are already
      // archived, so falling through to legacy migrate / seed is safe.
      try { archiveCorruptTabs(raw); } catch { /* best-effort */ }
    }
    // first run: migrate the legacy single-universe store if it holds real
    // docs, else start with an empty canvas. There are no sample docs — the
    // app always opens empty; the empty-universe "Create a project" CTA
    // covers the zero-tab state, same as an explicitly emptied workspace.
    let docs = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.docs) && d.docs.length) docs = d.docs;
      }
    } catch { /* start empty */ }
    if (docs) {
      try { docs = docs.map((d, i) => normalizeDoc(d, 'Untitled ' + (i + 1))); } catch { docs = []; }
      if (!docs.length) docs = null;
    }
    if (!docs) {
      this.tabs = [];
      this.activeTabId = null;
      this.persist();
      return;
    }
    this.tabs = [{ id: uid('tab_'), name: 'Universe 1', docs, activeId: docs[0]?.id || null, main: true, assoc: [], color: null, suppressedTags: [] }];
    this.activeTabId = this.tabs[0].id;
    this.persist();
  },
  persist() {
    try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: this.tabs, activeTabId: this.activeTabId })); }
    catch { /* quota / private mode */ }
  },
  reset() { this.tabs = []; this.activeTabId = null; this.persist(); }, // empty-canvas reset: never reseeds sample docs
  // ---------- canvases (top tabs): separate doc sets, copy bodies between them ----------
  createTab(name) {
    const clean = String(name || '').trim().slice(0, 40) || ('Universe ' + (this.tabs.length + 1));
    const t = { id: uid('tab_'), name: clean, docs: [], activeId: null, main: false, assoc: [], color: null, suppressedTags: [] };
    this.tabs.push(t);
    // new canvases join the active tab's association — the shared verse they were built from
    for (const s of this.scopeTabs()) {
      if (s.id === t.id) continue;
      if (!t.assoc.includes(s.id)) t.assoc.push(s.id);
      s.assoc = s.assoc || [];
      if (!s.assoc.includes(t.id)) s.assoc.push(t.id);
    }
    this.persist();
    return t;
  },
  closeTab(id) {
    const i = this.tabs.findIndex(t => t.id === id);
    if (i < 0) return false;
    this.tabs.splice(i, 1);
    for (const t of this.tabs) if (t.assoc) t.assoc = t.assoc.filter(x => x !== id); // drop dead links
    if (!this.tabs.length) {
      // the workspace may be empty: no active tab, no promoted main verse.
      this.activeTabId = null;
      this.persist();
      return true;
    }
    this.ensureIsoColors(); // a close can strand a verse into isolation
    if (this.activeTabId === id) this.activeTabId = this.tabs[Math.max(0, i - 1)].id;
    if (!this.tabs.some(t => t.main)) this.tabs[0].main = true; // closing the main verse promotes the oldest tab
    this.persist();
    return true;
  },
  renameTab(id, name) {
    const t = this.tabs.find(t => t.id === id);
    if (!t) return null;
    const clean = String(name || '').trim().slice(0, 40);
    if (!clean) return null;
    t.name = clean;
    this.persist();
    return t;
  },
  // association: valid linked verse ids (mutual by construction, stale ids dropped)
  assocIds(t) {
    const tb = typeof t === 'string' ? this.tabs.find(x => x.id === t) : t;
    if (!tb) return [];
    return (tb.assoc || []).filter(id => id !== tb.id && this.tabs.some(x => x.id === id));
  },
  // isolated = a lone verse in a multi-verse universe (a single-verse universe is never "isolated")
  isIso(t) { return this.tabs.length > 1 && this.assocIds(t).length === 0; },
  // every isolated verse owns a distinctive palette color (kept when it links
  // and unlinks again, so its identity is stable). Shared tabs ignore it and
  // wear the shared accent instead.
  ensureIsoColors() {
    for (const t of this.tabs) {
      if (typeof t.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(t.color)) t.color = null;
      if (this.isIso(t) && !t.color) {
        const used = new Set(this.tabs.filter(x => x !== t && this.isIso(x) && x.color).map(x => x.color));
        const free = ISO_COLORS.filter(c => !used.has(c));
        const pool = free.length ? free : ISO_COLORS;
        t.color = pool[Math.floor(Math.random() * pool.length)];
      }
    }
    this.persist();
  },
  // slide a tab one slot left (-1) or right (+1). End tabs can only go one way.
  moveTab(id, dir) {
    const i = this.tabs.findIndex(t => t.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.tabs.length) return false;
    [this.tabs[i], this.tabs[j]] = [this.tabs[j], this.tabs[i]];
    this.persist();
    return true;
  },
  // link/unlink two verses (always mutual). Returns true when linked, false when unlinked.
  toggleAssoc(id, otherId) {
    const a = this.tabs.find(t => t.id === id), b = this.tabs.find(t => t.id === otherId);
    if (!a || !b || id === otherId) return null;
    a.assoc = a.assoc || []; b.assoc = b.assoc || [];
    const on = !a.assoc.includes(otherId);
    if (on) { a.assoc.push(otherId); if (!b.assoc.includes(id)) b.assoc.push(id); }
    else { a.assoc = a.assoc.filter(x => x !== otherId); b.assoc = b.assoc.filter(x => x !== id); }
    this.ensureIsoColors(); // newly isolated verses get their color here
    return on;
  },
  // interaction scope: the active tab plus every verse it is associated with
  // (copies, deletes, twins). A verse with no associations only ever touches itself.
  scopeTabs() {
    const a = this.tab();
    if (!a) return this.tabs.slice();
    const ids = new Set([a.id, ...this.assocIds(a)]);
    return this.tabs.filter(t => ids.has(t.id));
  },
  // copy (never move) a body to another canvas. Solo = just that body; otherwise its
  // shared-ground constellation travels too (topic tethers only — the same set the
  // isolated view shows), so the local web re-forms there. Bodies already present
  // (by name) are skipped.
  sendCopyTo(docId, tabId, solo = false) {
    const src = this.docs.find(d => d.id === docId);
    if (!src) return null;
    const want = new Set([docId]);
    if (!solo) {
      const { edges } = this.universe();
      for (const e of edges) {
        if (e.kind !== 'topic') continue; // refs/tags stay behind; shared ground travels
        if (e.source === docId) want.add(e.target);
        else if (e.target === docId) want.add(e.source);
      }
    }
    return this.copyIdsTo(tabId, [...want]);
  },
  // copy an explicit set of bodies (by id) into another canvas. Same skip + lineage
  // rules as sendCopyTo; the constellation picker uses this with a user-chosen set.
  copyIdsTo(tabId, ids) {
    const t = this.tabs.find(t => t.id === tabId);
    if (!t || t.id === this.activeTabId) return null;
    if (!new Set(this.scopeTabs().map(t => t.id)).has(tabId)) return null; // unassociated verses neither send nor receive copies
    const names = new Set(t.docs.map(x => x.name.toLowerCase()));
    const copied = [];
    let skipped = 0;
    for (const d of this.docs.filter(d => ids.includes(d.id))) {
      if (names.has(d.name.toLowerCase())) { skipped++; continue; } // already there
      const c = { id: uid(), name: d.name, text: d.text, words: d.words, links: [...d.links], tags: [...d.tags], origin: d.origin || d.id };
      if (d.manualTags && Object.keys(d.manualTags).length) c.manualTags = { ...d.manualTags }; // spot anchors travel with the copy
      if (Array.isArray(d.noteLog) && d.noteLog.length) c.noteLog = d.noteLog.map(e => ({ ...e })); // copies open with the same notepad; later edits sync by lineage
      if (d.origKey) c.origKey = d.origKey; // copies share the original bytes, like shared picture keys
      this.applySuppress(c, t); // a copied body never resurrects a name this canvas deleted/merged away
      t.docs.push(c);
      names.add(c.name.toLowerCase());
      copied.push(c);
    }
    this.persist();
    return { copied, skipped };
  },
  // copy a whole tab's content into another canvas — any tab may receive,
  // associated or not (unlike copyIdsTo, there is no scope check). Same skip
  // + lineage rules as body copies; pictures travel as shared keys.
  copyTabDocs(destTabId, srcTabId, ids) {
    const s = this.tabs.find(t => t.id === srcTabId);
    const t = this.tabs.find(t => t.id === destTabId);
    if (!s || !t || s.id === t.id) return null;
    const want = new Set(Array.isArray(ids) && ids.length ? ids : s.docs.map(d => d.id));
    const names = new Set(t.docs.map(x => x.name.toLowerCase()));
    const copied = [];
    let skipped = 0;
    for (const d of s.docs.filter(d => want.has(d.id))) {
      if (names.has(d.name.toLowerCase())) { skipped++; continue; } // already there
      const c = { id: uid(), name: d.name, text: d.text, words: d.words, links: [...d.links], tags: [...d.tags], origin: d.origin || d.id };
      if (Array.isArray(d.images) && d.images.length) c.images = d.images.map(im => ({ ...im })); // shared picture keys, like origKey
      if (d.manualTags && Object.keys(d.manualTags).length) c.manualTags = { ...d.manualTags }; // spot anchors travel with the copy
      if (Array.isArray(d.noteLog) && d.noteLog.length) c.noteLog = d.noteLog.map(e => ({ ...e })); // copies open with the same notepad
      if (d.origKey) c.origKey = d.origKey; // copies share the original bytes
      this.applySuppress(c, t); // a copied body never resurrects a name this canvas deleted/merged away
      t.docs.push(c);
      names.add(c.name.toLowerCase());
      copied.push(c);
    }
    this.persist();
    return { copied, skipped };
  },
  // delete scope: active tab + every tab it interacts with (associated cluster).
  // A verse with no associations purges only itself; deletes never reach
  // unassociated verses. Finds every copy by lineage (origin survives renames)
  // plus same-name duplicates ("Report (2).md" stems match "Report.md").
  // Returns total bodies removed.
  removeEverywhere(docId) {
    const all = this.tabs.flatMap(t => t.docs);
    const d = this.docs.find(d => d.id === docId) || all.find(d => d.id === docId);
    if (!d) return 0;
    const root = d.origin || d.id;
    const stem = (n) => String(n || '').toLowerCase().replace(/\s\(\d+\)(\.[^.]+)?$/, '$1');
    const nm = stem(d.name);
    const scope = new Set(this.scopeTabs().map(t => t.id));
    let n = 0;
    for (const t of this.tabs) {
      if (!scope.has(t.id)) continue; // isolated verses keep their copies
      const before = t.docs.length;
      t.docs = t.docs.filter(x => !(x.id === docId || x.id === root || x.origin === root || stem(x.name) === nm));
      n += before - t.docs.length;
    }
    this.persist();
    return n;
  },

  titleOf(d) { return (d.name || 'Untitled').replace(/\.(md|markdown|txt|csv|pdf|docx?|xlsx?|pptx?|mp4|mov|mp3|wav|jpe?g|png)$/i, ''); },
  byId(id) { return this.docs.find(d => d.id === id) || null; },
  byIdAnywhere(id) { return this.byId(id) || this.tabs.flatMap(t => t.docs || []).find(d => d.id === id) || null; }, // whole-visidocsverse thematic: members may live on other canvases
  byTitle(t) {
    const c = String(t || '').trim().toLowerCase().replace(/\.(md|markdown|txt|csv|pdf|docx?|xlsx?|pptx?|mp4|mov|mp3|wav|jpe?g|png)$/i, '');
    return this.docs.find(d => this.titleOf(d).toLowerCase() === c) || null;
  },

  addFile(name, text, images) {    const clean = String(name || 'untitled').trim() || 'untitled';
    const p = parseDoc(text);
    const d = { id: uid(), name: clean, text: String(text), words: p.words, links: p.links, tags: withAutoTags(clean, String(text), p.tags) };
    if (Array.isArray(images) && images.length) d.images = images.slice(0, 200);
    // dedupe by name
    let n = clean, i = 1;
    const names = new Set(this.docs.map(x => x.name.toLowerCase()));
    while (names.has(n.toLowerCase())) { i++; n = clean.replace(/(\.[^.]+)?$/, ` (${i})$1`); }
    d.name = n;
    // a dedupe suffix ("Report (2).md") must not leak into the auto tags
    if (n !== clean) d.tags = withAutoTags(n, String(text), p.tags);
    this.applySuppress(d, this.tab());
    this.docs.push(d);
    this.persist();
    return d;
  },

  // refresh words/links/tags after the text changed out-of-band (picture-text
  // backfill appending an OCR section) — the same parse new intakes get, so
  // every counter (reader words, corpus totals, mass) agrees with the text.
  recountDoc(d) {
    if (!d) return null;
    const p = parseDoc(String(d.text || ''));
    d.words = p.words; d.links = p.links;
    // manual tags live outside the text — carry them through the recount
    const keepers = (d.tags || []).filter(isManual);
    d.tags = withAutoTags(d.name, d.text, [...p.tags, ...keepers]);
    this.applySuppress(d); // owning canvas's suppression (deleted/merged names stay gone)
    return d;
  },
  rename(id, title) {
    const d = this.byId(id);
    if (!d) return null;
    const clean = String(title || '').trim().replace(/[\\/:*?"<>|]/g, '') || 'Untitled';
    const ext = (d.name.match(/\.[^.]+$/) || [''])[0];
    d.name = clean + ext;
    d.tags = withAutoTags(d.name, d.text, d.tags); // old auto/* dropped, new title words join
    this.applySuppress(d, this.tab());
    this.persist();
    return d;
  },

  remove(id) {
    const i = this.docs.findIndex(d => d.id === id);
    if (i < 0) return false;
    this.docs.splice(i, 1);
    this.persist();
    return true;
  },

  // mass = word count + reference frequency (explicit refs AND topic resonance).
  // degMap: id -> count of topic-neighbors (computed in universe()).
  // docs/byTitle default to the active tab; the whole-visidocsverse thematic passes
  // every canvas's docs so masses and title lookups span the full corpus.
  masses(degMap, docs, byTitle) {
    docs = docs || this.docs;
    byTitle = byTitle || ((t) => this.byTitle(t));
    const inCount = new Map(docs.map(d => [d.id, 0]));
    for (const d of docs) {
      for (const t of d.links) {
        const hit = byTitle(t);
        if (hit) inCount.set(hit.id, inCount.get(hit.id) + 1);
      }
    }
    const tagOwners = new Map();
    for (const d of docs) for (const t of d.tags) {
      const k = stripAuto(t);
      if (!tagOwners.has(k)) tagOwners.set(k, new Set());
      tagOwners.get(k).add(d.id);
    }
    // wallpaper guard for AUTO tags only: a title word stamped on most of
    // the corpus ("evidence" on 16/18 evidence files) describes the filing
    // cabinet, not a relationship — it tethers nothing and weighs nothing.
    // Explicit hand-written #tags always count (intent). Small shared auto
    // tags ("screenshot" on 4) still tether normally.
    const autoCap = Math.max(4, Math.round(docs.length * 0.4));
    const autoCounts = (d) => {
      let n = 0;
      for (const t of d.tags) {
        if (!String(t).startsWith('auto/')) { n += Math.max(0, (tagOwners.get(stripAuto(t))?.size || 1) - 1); continue; }
        const owners = tagOwners.get(stripAuto(t))?.size || 1;
        if (owners <= autoCap) n += owners - 1;
      }
      return n;
    };
    const out = new Map();
    for (const d of docs) {
      let refs = inCount.get(d.id) + d.links.length;
      refs += autoCounts(d) * 0.5;
      refs += (degMap?.get(d.id) || 0) * 1.0;
      let m = 2 + d.words / 150 + refs * 1.5;
      out.set(d.id, m);
    }
    return out;
  },

  // bodies[]: {id,label,mass,tags,words}  links[]: {source,target,kind,topics?}
  // kinds: ref ([[link]] or title mention) · tag (shared #tag) · topic (shared vocabulary)
  // docs defaults to the active tab; the whole-visidocsverse thematic passes every
  // canvas's docs so the web spans the full corpus, not just one tab.
  universe(docs) {
    docs = docs || this.docs;
    const self = this;
    const byTitle = (t) => {
      const c = String(t || '').trim().toLowerCase().replace(/\.(md|markdown|txt|csv|pdf|docx?|xlsx?|pptx?|mp4|mov|mp3|wav|jpe?g|png)$/i, '');
      return docs.find(d => self.titleOf(d).toLowerCase() === c) || null;
    };
    const T = analyzeTopics(docs, this.topicIdfFloor ?? 30);
    // topic adjacency first (masses need it)
    const topicDeg = new Map(docs.map(d => [d.id, 0]));
    const cand = []; // every above-bar pair, ranked — each doc keeps its TOP-K
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const a = docs[i], b = docs[j];
        const r = cosineTopic(a, b, T);
        if (!r) continue;
        const sig = r.shared.filter(t => (T.df.get(t) || 0) <= docs.length * (this.topicMaxDf ?? 1));
        if (r.sim >= (this.topicSim ?? 0.10) && sig.length >= (this.topicShared ?? 3)) {
          cand.push({ a, b, sim: r.sim, terms: r.shared.slice(0, 5) });
        }
      }
    }
    cand.sort((x, y) => y.sim - x.sim);
    const K = this.topicTopK ?? 5;
    const topicPairs = [];
    for (const c of cand) {
      if ((topicDeg.get(c.a.id) || 0) >= K || (topicDeg.get(c.b.id) || 0) >= K) continue;
      topicDeg.set(c.a.id, topicDeg.get(c.a.id) + 1);
      topicDeg.set(c.b.id, topicDeg.get(c.b.id) + 1);
      topicPairs.push([c.a.id, c.b.id, c.terms, c.sim]);
    }
    const masses = this.masses(topicDeg, docs, byTitle);
    const bodies = docs.map(d => ({
      id: d.id, label: this.titleOf(d), mass: masses.get(d.id) || 2,
      tags: d.tags, words: d.words, origin: d.origin || d.id,
    }));
    const edges = [];
    const seen = new Set();
    const push = (a, b, kind, topics, sim) => {
      if (a === b) return;
      const k = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(k)) return;
      seen.add(k); edges.push({ source: a, target: b, kind, topics, sim });
    };
    // title mentions: doc A names doc B's title in plain prose → a ref tether
    const titles = new Map(docs.map(d => [d.id, normTitle(this.titleOf(d))]));
    for (const d of docs) {
      const body = String(d.text).toLowerCase();
      for (const o of docs) {
        if (o.id === d.id) continue;
        const t = titles.get(o.id);
        if (t && t.length >= 8 && body.includes(t)) push(d.id, o.id, 'ref');
      }
      for (const t of d.links) {
        const hit = byTitle(t);
        if (hit) push(d.id, hit.id, 'ref');
        // dangling targets still count for mass, but render as comets, not ghosts
      }
      const tagDf = new Map(); // stripped tag -> #docs carrying it
      for (const o of docs) for (const t of new Set(o.tags.map(stripAuto))) tagDf.set(t, (tagDf.get(t) || 0) + 1);
      const autoCap = Math.max(4, Math.round(docs.length * 0.4));
      const kept = (t) => !String(t).startsWith('auto/') || (tagDf.get(stripAuto(t)) || 0) <= autoCap;
      const mine = new Set(d.tags.filter(kept).map(stripAuto));
      for (const o of docs) {
        if (o.id >= d.id) continue;
        if (o.tags.filter(kept).map(stripAuto).some(t => mine.has(t))) push(d.id, o.id, 'tag');
      }
    }
    for (const [a, b, shared, sim] of topicPairs) push(a, b, 'topic', shared, sim);
    return { bodies, edges };
  },

  search(q) {
    q = String(q || '').trim().toLowerCase();
    // tag pills (and typed queries) carry a '#' prefix, but tags, titles and
    // prose are stored/matched without it — strip it so '#education' finds the
    // same bodies 'education' would (literal '#tag' prose still matches below).
    if (q.startsWith('#')) q = q.slice(1).trim();
    if (!q) return [];
    return this.docs
      .map(d => {
        const t = this.titleOf(d).toLowerCase();
        let s = -1;
        if (t === q) s = 100;
        else if (t.startsWith(q)) s = 80;
        else if (t.includes(q)) s = 60;
        else if (d.tags.map(stripAuto).join(' ').includes(q)) s = 40;
        else if (d.text.toLowerCase().includes(q)) s = 20;
        return s >= 0 ? { doc: d, score: s } : null;
      })
      .filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12);
  },
};


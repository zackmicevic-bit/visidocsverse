// VisiDocsVerse renderer: projects the 3D universe onto a 2D canvas with a
// perspective orbit-camera. Depth-sorted (painter's algorithm), additive-feel
// glows, neon tethers, z-scaled typography, screen-space picking.
// lerp between two #rrggbb colors; t=0 -> a, t=1 -> b. Returns [r,g,b].
function mixHex(a, b, t) {
  t = Math.max(0, Math.min(1, t));
  const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
  const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
  return pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
}
// high-contrast partner for the user's tether tint: complementary hue with
// enforced vividness, so the active body's shared-ground tethers always read
// apart from regular tethers no matter which tint is picked. Achromatic picks
// (gray/black/white) land on vivid cyan, clamped to a mid-bright band that
// reads on both dark and light canvases.
function contrastRgb(c) {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = d / (1 - Math.abs(2 * l - 1));
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const h2 = (h + 180) % 360, s2 = Math.max(s, 0.75), l2 = Math.max(0.55, Math.min(0.68, l));
  const k = (n) => (n + h2 / 30) % 12;
  const a = s2 * Math.min(l2, 1 - l2);
  const f = (n) => l2 - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
// #rrggbb (or #rgb) -> [r,g,b]; garbage in, soft blue out.
function rgbHex(h) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(h || '').trim());
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  const s = /^#([0-9a-f]{3})$/i.exec(String(h || '').trim());
  if (s) return [...s[1]].map(c => parseInt(c + c, 16));
  return [130, 170, 255];
}
// ---- circular-text (sun-dial) collision capsules: a filename is a segment
// (its text centerline) plus a thickness radius; icons and orbs are circles.
// All exact, no bounding-box bloat on diagonal rays.
function dPtSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t, cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}
function segSegInt(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
function dSegSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segSegInt(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    dPtSeg(ax, ay, cx, cy, dx, dy), dPtSeg(bx, by, cx, cy, dx, dy),
    dPtSeg(cx, cy, ax, ay, bx, by), dPtSeg(dx, dy, ax, ay, bx, by));
}
export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { yaw: 0.6, pitch: 0.42, dist: 620, auto: true, px: 0, py: 0 };
    this.focal = 700;
    this.fitFloor = 10; // Fit guarantees every orb renders at least this radius (px)
    this.hover = null;
    this.overlayImgs = []; // photo textures, index-stable (null until loaded)
    this.overlayAlpha = 0.6;
    this.overlaySeed = 0;
    this.labelScale = 1; // file-name size multiplier (0 = hidden) // bump to reshuffle assignment
    this.bgShade = 1; // canvas background shade (1 = black deep-space, 0 = white)
    this.backdrop = null; // canvas photo texture (HTMLImageElement, cover-fit, behind everything)
    this.backdropAlpha = 0.55; // photo texture opacity (0 = off)
    this.glowScale = 1; // halo radius multiplier (0 = no glow, 1 = current, 2 = double)
    this.bodyScale = 1; // orb/triangle size multiplier (slider 5-300%, button toggles 100% <-> last)
    this.compressScale = 1; // horizontal squish multiplier (1 = round, lower = narrower)
    this.spinAngle = 0; // body-rotation phase (advanced by scaled time in draw, so pause/slow-mo obey)
    this.spinBlend = 0; // eased 0..1 toward spinTarget (off settles bodies back to round)
    this.spinTarget = 0; // 1 = spinning, 0 = settling to round
    this.spinOmega = 0; // spin angular velocity, rad/s (from the Rotation speed slider)
    this.simpleOrb = false; // plain white discs + thin black outline (no gradients, halos, or photo overlays)
    this.stripOverlays = false; // "Plain Body 2": original blue orbs, photo textures skipped (glow stays)
    this.triOrb = false; // triangle mode: upside-down triangles instead of discs (same fill, same size)
    this.tetherScale = 1; // tether thickness multiplier (0 = hidden, 1 = current, 2 = double)
    this.tetherColor = '#82aaff'; // tether tint (user palette; shared-ground links auto-contrast off it)
    this.selSet = null; // marquee-selected body ids (Set, owned by app.js) — ring highlight
    this.resize();
  }
  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = Math.max(50, r.width * dpr);
    this.cv.height = Math.max(50, (r.height || 400) * dpr);
    this.cv.style.width = r.width + 'px';
    this.cv.style.height = (r.height || 400) + 'px';
    this.dpr = dpr;
  }
  resetView() { this.cam.yaw = 0.6; this.cam.pitch = 0.42; this.cam.dist = 620; this.cam.px = 0; this.cam.py = 0; }
  recenterView() {
    // steer the universe center onto the center of the VISIBLE screen slice
    // of the canvas (see fitView for why the viewport overlap, not the
    // canvas element, is the anchor)
    const r = this.cv.getBoundingClientRect();
    const W = r.width || 300, H = r.height || 400;
    const vx0 = Math.max(0, r.left), vx1 = Math.min(window.innerWidth || W, r.right);
    const vy0 = Math.max(0, r.top), vy1 = Math.min(window.innerHeight || H, r.bottom);
    this.cam.px = (vx0 + vx1) / 2 - r.left - W / 2;
    this.cam.py = (vy0 + vy1) / 2 - r.top - H / 2;
  }
  // Fit, v2 — compress-then-frame. A camera-only fit of a sprawling universe
  // needs an enormous dolly-out, which shrinks every orb to a speck. So Fit
  // first compresses the WORLD (tether lengths + body distances × k) and only
  // then frames it — compressing by k and refitting magnifies every orb 1/k
  // on screen versus a pure dolly, with a pixel-identical layout (the math:
  // projected x = X·s with s = focal/(depth+dist); scaling all of X, depth
  // and dist by k leaves every screen position unchanged while the center
  // scale focal/dist grows 1/k). Physics follows the compression: shells,
  // rest length, comet rim and corona scale by k, positions scale by k, and
  // orbital velocities re-seat instantly (positions untouched, so the morph
  // is visually seamless). k is solved from readability — the smallest orb
  // at the camera-only fit scale, lifted to fitFloor px — clamped to
  // [0.25, 1]: at k = 0.25 the innermost shell (150 → 37.5) still orbits at
  // v = √(25·600/37.5) = 20 < vmax 30, and k never exceeds 1 (never expands).
  // Any orb still below fitFloor afterwards (deep compression) is boosted
  // multiplicatively just to the floor, so size ORDER is preserved — big
  // bodies stay big, runts stop being specks. Returns a report for the toast.
  // Fit — frame the whole formation on the VISIBLE SCREEN (not the canvas
  // element: the canvas can extend past what the person actually sees; Fit
  // frames the viewport overlap instead). Recenters pan on the visible
  // center, then dollies out far enough that every CURRENT body projects
  // inside the visible region, plus slack for labels and drift. Deliberately
  // frames bodies, not the empty simulation rim: the rim is 4–9× wider than
  // the shells, so rim-framing shrinks the formation into an unreadable
  // clump. A rim-bound comet may drift out of a fitted frame over minutes —
  // Fit again. Never zooms in, never touches yaw/pitch — and never touches
  // the physics: shells, springs, rim and positions are left exactly alone,
  // so orbital mechanics survive Fit untouched. Small orbs that would render
  // as specks at the fitted distance are instead lifted to a readability
  // floor via a separate view multiplier (n._fitBoost — physics radius
  // untouched, size order preserved, repeat presses converge). Returns a
  // report for the toast.
  fitView(nodes, margin = 70, minR = 0, u = null) {
    const FLOOR = this.fitFloor || 10, SLACK = 1.25;
    // effR: physics radius × Fit's view boost — the boost rides separately so
    // repeat fits converge instead of ratcheting the world radius upward.
    const effR = (n) => (n.radius || 6) * (n._fitBoost || 1);
    const list = (nodes || []).filter(n => n && Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z));
    if (!list.length) return { fitted: false };
    const r = this.cv.getBoundingClientRect();
    const W = r.width || 300, H = r.height || 400;
    // visible slice of the canvas, in client coords (clamped to the viewport)
    const vx0 = Math.max(0, r.left), vx1 = Math.min(window.innerWidth || W, r.right);
    const vy0 = Math.max(0, r.top), vy1 = Math.min(window.innerHeight || H, r.bottom);
    const visW = Math.max(50, vx1 - vx0), visH = Math.max(50, vy1 - vy0);
    this.recenterView();
    const half = Math.max(50, Math.min(visW, visH) / 2 - margin);
    const extent = (rim) => {
      let R = rim || 0;
      for (const n of list) R = Math.max(R, Math.hypot(n.x, n.y, n.z) + effR(n));
      return R * SLACK; // slack for labels, glow, and rim overshoot between fittings
    };
    // worst-case scale is at the sphere's near side: s = focal / (dist - R),
    // so R * s <= half resolves to dist >= R + R * focal / half.
    const frame = (R) => Math.min(8000, R + (R * this.focal) / half);
    const rim = minR || 0; // the caller decides the padding: bodies-only (0)
    // keeps the formation big; passing the comet rim keeps escapees framed
    const dist0 = this.cam.dist;
    const distNeed = frame(extent(rim));
    // already fully on screen with every orb readable → nothing to do
    if (distNeed <= dist0 + 1) {
      const sNow = this.focal / Math.max(80, dist0);
      let runts = 0;
      for (const n of list) if (effR(n) * sNow * 1.6 < FLOOR) runts++;
      if (!runts) return { fitted: false };
    }
    // 1. dolly out only as far as needed — a close-up stays a close-up
    this.cam.dist = Math.max(dist0, distNeed);
    // 2. set every orb's view boost ABSOLUTELY from this distance: runts rise
    //    exactly to the floor, healthy orbs return to ×1. Absolute (never
    //    incremental), so zooming in un-boosts and repeat fits converge.
    const s1 = this.focal / Math.max(80, this.cam.dist);
    let boosted = 0;
    for (const n of list) {
      const want = Math.max(1, FLOOR / (((n.radius || 6)) * s1 * 1.6));
      if (Math.abs(want - (n._fitBoost || 1)) > 0.01) n._fitBoost = want;
      if (want > 1) boosted++;
    }
    if (boosted) this.cam.dist = Math.max(this.cam.dist, frame(extent(rim)));
    return { fitted: true, compressed: 1, boosted, dist0, dist1: this.cam.dist };
  }
  project(x, y, z) {
    // orbit camera: yaw around Y, pitch, then perspective
    const { yaw, pitch, dist } = this.cam;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let X = x * cy - z * sy, Z = x * sy + z * cy, Y = y;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const Y2 = Y * cp - Z * sp, Z2 = Y * sp + Z * cp;
    const depth = Z2 + dist;
    const s = this.focal / Math.max(80, depth);
    const r = this.cv.getBoundingClientRect();
    return { x: (r.width || 300) / 2 + X * s + (this.cam.px || 0), y: (r.height || 400) / 2 + Y2 * s + (this.cam.py || 0), s, depth };
  }
  pick(nodes, sx, sy) {
    let best = null, bd = 1e9;
    const bs = (this.bodyScale == null ? 1 : this.bodyScale);
    for (const n of nodes) {
      const p = n._p;
      if (!p) continue;
      const tol = Math.max(16, (n.radius || 6) * (n._fitBoost || 1) * p.s * bs + 8);
      const d = Math.hypot(n._p.x - sx, n._p.y - sy);
      if (d < tol && d < bd) { bd = d; best = n; }
    }
    return best;
  }
  noteHit(sx, sy) {
    // sticky-note square under the cursor (ids recorded during the last draw)
    if (!this._noteRects) return null;
    for (const [id, r] of this._noteRects) {
      if (sx >= r.x - 2 && sx <= r.x + r.s + 2 && sy >= r.y - 2 && sy <= r.y + r.s + 2) return id;
    }
    return null;
  }
  loadOverlays(urls) {
    this.overlayImgs = (urls || []).map(() => null);
    (urls || []).forEach((u, i) => {
      const im = new Image();
      im.onload = () => { this.overlayImgs[i] = im; };
      im.onerror = () => { /* that slot stays gradient */ };
      im.src = u;
    });
  }
  reshuffleOverlays() { this.overlaySeed++; }
  ovFor(id) {
    // stable per-body pick + spin + mirror from the id hash (no per-frame flicker)
    let h1 = 7, h2 = 13;
    const s = String(id);
    for (let i = 0; i < s.length; i++) { h1 = (h1 * 31 + s.charCodeAt(i)) | 0; h2 = (h2 * 37 + s.charCodeAt(i) * 7) | 0; }
    h1 = Math.abs(h1); h2 = Math.abs(h2);
    return { h1, h2 };
  }
  draw(uni, opts = {}) {
    const ctx = this.ctx, dpr = this.dpr || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = this.cv.getBoundingClientRect();
    const W = r.width, H = r.height || 400;
    // deep-space backdrop (shade slider: 1 = black as today, 0 = flat white)
    const sh = Math.max(0, Math.min(1, this.bgShade == null ? 1 : this.bgShade));
    const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
    const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.75);
    bg.addColorStop(0, rgb(mixHex('#ffffff', '#11161f', sh)));
    bg.addColorStop(1, rgb(mixHex('#ffffff', '#0d1117', sh)));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    // photo backdrop (user palette): cover-fit, own opacity, bodies/tethers draw over it
    const bi = this.backdrop;
    const ba = (typeof this.backdropAlpha === 'number' ? this.backdropAlpha : 0);
    if (bi && bi.complete && bi.naturalWidth && ba > 0.01) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, ba));
      const s = Math.max(W / bi.naturalWidth, H / bi.naturalHeight);
      const dw = bi.naturalWidth * s, dh = bi.naturalHeight * s;
      ctx.drawImage(bi, (W - dw) / 2, (H - dh) / 2, dw, dh);
      ctx.restore();
    }
    const t = opts.now ?? performance.now() / 1000;
    // body rotation: runs on the real clock so bodies keep spinning while the
    // universe is paused or at slow-motion (the old scaled-time clock froze
    // spin whenever virtT froze, so Rotation looked dead unless running).
    const realT = performance.now() / 1000;
    const ldt = Math.max(0, Math.min(0.1, realT - (this._lastSpinT ?? realT)));
    this._lastSpinT = realT;
    const spinTgt = (this.spinTarget == null ? 0 : this.spinTarget);
    const spinBl = (this.spinBlend == null ? 0 : this.spinBlend);
    this.spinBlend = spinBl + (spinTgt - spinBl) * Math.min(1, ldt * 4);
    if (this.spinBlend > 0.001) this.spinAngle = (this.spinAngle || 0) + (this.spinOmega || 0) * ldt;
    this.starfield(ctx, W, H, t);
    const match = opts.match; // Set of ids matching search (dims the rest)
    this._noteRects = new Map(); // screen-space sticky-note squares, rebuilt every frame for hit-testing
    this._assocRects = []; // associated-doc paper icons, rebuilt every frame for hit-testing
    // an emptied workspace has no universe: keep rendering the backdrop + stars.
    const u = uni || { nodes: [], edges: [], byId: new Map(), sunId: null };
    // project + sort far -> near (z-buffered draw order)
    for (const n of u.nodes) n._p = this.project(n.x, n.y, n.z);
    const order = [...u.nodes].sort((a, b) => b._p.depth - a._p.depth);
    // gold follows the reader's selection, not the physical sun: clicks never
    // move bodies, so the gilded orb is "what you're viewing", set from app
    // state each frame (falls back to the physical sun when nothing applies)
    const sel = (this.selId && u.byId.has(this.selId)) ? this.selId : null;
    // neon tethers first (under the bodies)
    ctx.lineCap = 'round';
    const tc = rgbHex(this.tetherColor); // user-picked tint
    const tint = (a) => `rgba(${tc[0]},${tc[1]},${tc[2]},${a})`;
    const tcw = tc.map(v => Math.round(v + (255 - v) * 0.35)); // whitened core: reads sharp on dark
    const sg = contrastRgb(tc); // shared-ground tint: auto high-contrast partner of the user's pick
    const sgc = `${sg[0]},${sg[1]},${sg[2]}`;
    const coreTint = (a) => `rgba(${tcw[0]},${tcw[1]},${tcw[2]},${a})`;
    const px = 1 / (dpr || 1); // device-pixel grid: snapped endpoints shimmer less while rotating
    for (const e of u.edges) {
      const a = u.byId.get(e.source)?._p, b = u.byId.get(e.target)?._p;
      if (!a || !b) continue;
      const hot = e.source === u.sunId || e.target === u.sunId;
      const sunTopic = hot && e.kind === 'topic'; // shared-ground tether of the active body
      const dim = match && !(match.has(e.source) && match.has(e.target));
      ctx.globalAlpha = dim ? 0.06 : hot ? 0.9 : 0.55;
      // neon tethers: tight halo pass + bright core pass (slider scales both, far left skips them)
      const tw = (this.tetherScale == null ? 1 : this.tetherScale);
      if (tw > 0.01) {
        const ax = Math.round(a.x / px) * px, ay = Math.round(a.y / px) * px;
        const bx = Math.round(b.x / px) * px, by = Math.round(b.y / px) * px;
        ctx.strokeStyle = sunTopic ? `rgba(${sgc},0.22)` : hot ? tint(0.28) : tint(0.18);
        ctx.lineWidth = (hot ? 3 : 2.6) * tw;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.strokeStyle = sunTopic ? `rgba(${sgc},0.95)` : hot ? tint(0.95) : coreTint(0.85);
        ctx.lineWidth = (hot ? 1.6 : 1.3) * tw;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (const n of order) {
      const p = n._p;
      const hot = sel ? (n.id === sel) : !!n.isActive;
      if (p.x < -80 || p.y < -60 || p.x > W + 80 || p.y > H + 60) continue;
      const dim = match && !match.has(n.id);
      ctx.globalAlpha = dim ? 0.15 : 1;
      const bs = (this.bodyScale == null ? 1 : this.bodyScale);
      const rad = Math.max(2, n.radius * (n._fitBoost || 1) * p.s * 1.6 * bs);
      const pulse = 1 + 0.08 * Math.sin(t * 2 + (n.phase || 0));
      // horizontal body geometry: static compress squish; spheres rotate by
      // surface motion (triangles flip like cards around the vertical axis)
      const bl = (this.spinBlend == null ? 0 : this.spinBlend);
      const spinPh = (this.spinAngle || 0) + (n.phase || 0);
      const drift = Math.sin(spinPh) * bl; // surface sweep, 0 when off (light stays fixed)
      const flip = (1 - bl) + bl * Math.cos(spinPh); // card-flip factor, 1 when off
      // silhouette: spheres stay round (their markings do the turning);
      // triangles are flat cards, so they flip edge-on and back
      const compress = (this.compressScale == null ? 1 : this.compressScale);
      let sxSil = this.triOrb ? compress * flip : compress;
      // keep an edge-on sliver so a flipping triangle never fully vanishes
      if (this.triOrb && bl > 0.001 && Math.abs(sxSil) < 0.12) sxSil = (sxSil < 0 ? -1 : 1) * 0.12;
      const R = rad * pulse;
      // outer halo (glow slider scales its radius, far left removes it) — round
      // ambiance, never squished, so the glow doesn't fight the sphere
      const gl = (this.glowScale == null ? 1 : this.glowScale);
      if (gl > 0.01 && !this.simpleOrb) {
        const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(1, rad * 4 * gl));
        const hc = hot ? '255,210,120' : '90,150,255';
        halo.addColorStop(0, `rgba(${hc},${hot ? 0.5 : 0.35})`);
        halo.addColorStop(1, `rgba(${hc},0)`);
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad * 4 * pulse * gl, 0, 7); ctx.fill();
      }
      ctx.save(); // body-geometry frame: disc/triangle, photo overlay, rings —
      ctx.translate(p.x, p.y); // silhouettes follow Compress (and triangles flip),
      ctx.scale(sxSil || 0.0001, 1); // labels stay outside it
      ctx.translate(-p.x, -p.y); // draw in body-centered coords so motion pivots on the anchor
      // body — a shaded sphere (fixed upper-left light + dark limb), or an
      // upside-down triangle in triangle mode (same screen size, same fill as
      // the disc it replaces: gradient gold/blue, or flat white with a black
      // outline under Plain Body). Spheres keep their light fixed while surface
      // markings drift — that dissociation is what reads as 3D rotation.
      const hlx = this.triOrb ? p.x - rad * 0.3 + drift * rad * 0.45 : p.x - rad * 0.3;
      const body = ctx.createRadialGradient(hlx, p.y - rad * 0.3, 0, p.x, p.y, rad);
      if (hot) {
        body.addColorStop(0, '#fff6dd'); body.addColorStop(0.5, '#ffce6b'); body.addColorStop(1, '#b36a00');
      } else {
        body.addColorStop(0, '#dcecff'); body.addColorStop(0.5, '#5f9dff'); body.addColorStop(1, '#173a7a');
      }
      const triPath = (x, y, r) => {
        ctx.beginPath();
        for (let k = 0; k < 3; k++) {
          const a = Math.PI / 2 + k * 2 * Math.PI / 3; // first vertex points down
          if (k) ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
          else ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        ctx.closePath();
      };
      if (this.triOrb) {
        triPath(p.x, p.y, R);
        ctx.fillStyle = this.simpleOrb ? '#ffffff' : body;
        ctx.fill();
        if (this.simpleOrb) { ctx.strokeStyle = '#111111'; ctx.lineWidth = 1; ctx.stroke(); }
      } else if (this.simpleOrb) {
        // plain-body mode: flat white disc + thin black outline, no gradients
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(p.x, p.y, rad * pulse, 0, 7); ctx.fill();
        ctx.strokeStyle = '#111111'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad * pulse, 0, 7); ctx.stroke();
      } else {
        ctx.fillStyle = body;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad * pulse, 0, 7); ctx.fill();
      }
      // photo-texture overlay, clipped to the disc (distinctiveness pass)
      if (!this.simpleOrb && !this.stripOverlays && this.overlayAlpha > 0.01 && this.overlayImgs.length) {
        const { h1, h2 } = this.ovFor(n.id);
        const im = this.overlayImgs[(h1 + this.overlaySeed) % this.overlayImgs.length];
        if (im) {
          ctx.save();
          if (this.triOrb) triPath(p.x, p.y, rad * pulse);
          else { ctx.beginPath(); ctx.arc(p.x, p.y, rad * pulse, 0, 7); }
          ctx.clip();
          ctx.globalAlpha *= this.overlayAlpha * (hot ? 0.45 : 1); // sun keeps its gold signal
          ctx.translate(p.x, p.y);
          ctx.rotate((h2 % 360) * Math.PI / 180); // static per-body tilt
          if (h2 % 2) ctx.scale(-1, 1);
          if (!this.triOrb) {
            // globe sweep: the photo slides behind the fixed round window,
            // drawn oversized below so the drift never exposes an edge
            ctx.translate(drift * R * 0.35, 0);
          }
          const d = this.triOrb ? rad * pulse * 2 * Math.SQRT2 : R * 3.2; // discs: oversized cover for the sweep
          ctx.drawImage(im, -d / 2, -d / 2, d, d);
          ctx.restore();
        }
      }
      if (!this.triOrb) {
        // spherical falloff over the texture: dark limbs, lit center — the ball
        // reads round even where the photo is bright to the edge
        if (!this.simpleOrb) {
          const limb = ctx.createRadialGradient(p.x, p.y, R * 0.45, p.x, p.y, R);
          limb.addColorStop(0, 'rgba(8,12,24,0)');
          limb.addColorStop(1, 'rgba(8,12,24,0.52)');
          ctx.fillStyle = limb;
          ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 7); ctx.fill();
        }
        // drifting surface bands: markings rounding the sphere (limb-faded so
        // they slow and dissolve at the edges, like a globe)
        if (bl > 0.01) {
          ctx.save();
          ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, 7); ctx.clip();
          const bandW = R * 0.34;
          for (let k = -1; k <= 1; k++) {
            const off = Math.sin(spinPh + k * 2.094) * R * 0.75;
            const limbFade = Math.pow(Math.max(0, Math.cos(Math.min(1, Math.abs(off) / R) * Math.PI / 2)), 1.5);
            const dark = (k !== 0) !== !!this.simpleOrb; // marble contrast: dark flanks on color orbs, dark bands on white ones
            const rgb = dark ? '8,15,35' : (this.simpleOrb ? '20,30,50' : '255,255,255');
            const peak = (dark ? 0.17 : 0.20) * bl * limbFade;
            if (peak < 0.01) continue;
            const g = ctx.createLinearGradient(p.x + off - bandW, 0, p.x + off + bandW, 0);
            g.addColorStop(0, `rgba(${rgb},0)`);
            g.addColorStop(0.5, `rgba(${rgb},${peak.toFixed(3)})`);
            g.addColorStop(1, `rgba(${rgb},0)`);
            ctx.fillStyle = g;
            ctx.fillRect(p.x + off - bandW, p.y - R, bandW * 2, R * 2);
          }
          ctx.restore();
        }
      }
      // (triangles flip like cards; the flip itself is the motion cue)
      if (n === this.hover || hot) {
        const ring = mixHex('#1e2d50', '#ffffff', sh);
        ctx.strokeStyle = `rgba(${ring[0]},${ring[1]},${ring[2]},0.85)`; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad * pulse + 4, 0, 7); ctx.stroke();
      }
      // marquee box selection: accent ring, shade-adapted so it reads on dark + light
      if (this.selSet && this.selSet.has(n.id)) {
        const sel = mixHex('#2f6df0', '#9cc2ff', sh);
        ctx.strokeStyle = `rgba(${sel[0]},${sel[1]},${sel[2]},0.95)`; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, rad * pulse + 7, 0, 7); ctx.stroke();
      }
      ctx.restore(); // end body-geometry frame
      // depth-sorted typography: nearer = larger/brighter (slider scales, 0 hides)
      const lsc = (this.labelScale == null ? 1 : this.labelScale);
      if (lsc > 0.01) {
        const fs = Math.max(8, Math.min(15, 11 * (0.6 + p.s))) * lsc;
        ctx.font = `${hot ? '700' : '400'} ${fs.toFixed(1)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        // label ink flips with the background so text stays readable on white
        const ink = mixHex('#1b2a45', '#bed2f5', sh);
        const inkA = mixHex('#8a5a00', '#ffe9b8', sh);
        const halo = mixHex('#ffffff', '#0d1117', sh);
        ctx.strokeStyle = `rgba(${halo[0]},${halo[1]},${halo[2]},0.9)`;
        ctx.fillStyle = hot ? rgb(inkA) : `rgba(${ink[0]},${ink[1]},${ink[2]},${(0.45 + p.s * 0.5).toFixed(2)})`;
        const label = n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label;
        ctx.strokeText(label, p.x, p.y + rad + fs + 3);
        ctx.fillText(label, p.x, p.y + rad + fs + 3);
        // sticky-note square: tight to the label's left edge, side = label font height
        const mark = opts.noteMarks ? opts.noteMarks.get(n.id) : null;
        if (mark) {
          const tw = ctx.measureText(label).width;
          const s = fs, nx = p.x - tw / 2 - Math.max(2, fs * 0.18) - s, ny = p.y + rad + 3;
          if (!this._noteRects) this._noteRects = new Map();
          this._noteRects.set(n.id, { x: nx, y: ny, s });
          if (mark === 'full') {
            ctx.fillStyle = '#eccb45';
            ctx.fillRect(nx, ny, s, s);
            ctx.strokeStyle = 'rgba(138,106,31,.9)'; ctx.lineWidth = 1;
            ctx.strokeRect(nx + 0.5, ny + 0.5, s - 1, s - 1);
            // ruled-line texture + red margin tick, like a real sticky note
            ctx.strokeStyle = 'rgba(138,106,31,.55)';
            ctx.beginPath();
            ctx.moveTo(nx + 2, ny + s * 0.38); ctx.lineTo(nx + s - 2, ny + s * 0.38);
            ctx.moveTo(nx + 2, ny + s * 0.62); ctx.lineTo(nx + s - 2, ny + s * 0.62);
            ctx.stroke();
            ctx.strokeStyle = 'rgba(200,80,60,.7)';
            ctx.beginPath();
            ctx.moveTo(nx + s * 0.24, ny + 1.5); ctx.lineTo(nx + s * 0.24, ny + s - 1.5);
            ctx.stroke();
          } else {
            // empty placeholder on the sun: dashed hollow square, invites creation
            ctx.save();
            ctx.setLineDash([2.5, 2]);
            ctx.strokeStyle = 'rgba(201,162,39,.85)'; ctx.lineWidth = 1.2;
            ctx.strokeRect(nx + 0.5, ny + 0.5, s - 1, s - 1);
            ctx.restore();
          }
        }
      }
      ctx.globalAlpha = 1;
    }
    // associated-document overlay (thematic view): paper icons pinned around
    // their seed orb — top grounding docs in the orb's own color, the rest
    // lighter. Drawn last (annotation layer, like labels).
    if (opts.assoc && opts.assoc.length) { try { this.drawAssoc(ctx, u, opts.assoc); } catch {} }
  }
  // associated-document paper icons (thematic view): one sheet per grounded
  // doc, ringed around its seed orb so neighbors never impinge. Icons shrink
  // and rings multiply as membership grows (all docs always shown, top
  // grounding docs innermost); labels widen the slots they need. Records
  // screen rects for click / right-click hit-testing.
  assocHit(sx, sy) {
    const rs = this._assocRects;
    if (!rs) return null;
    // two passes: icons first (small precise targets win over the long
    // icon→label unions), then labels — so a click on a name never catches
    // a neighboring ray's stretched hit box.
    for (let i = rs.length - 1; i >= 0; i--) {
      const r = rs[i];
      if (sx >= r.ibx && sx <= r.ibx + r.ibw && sy >= r.iby && sy <= r.iby + r.ibh) return r;
    }
    for (let i = rs.length - 1; i >= 0; i--) {
      const r = rs[i];
      if (!r.lbw) continue;
      // labels are rotated radial text anchored at one end: inverse-rotate
      const dx = sx - r.lbx, dy = sy - r.lby;
      const c = Math.cos(r.th), q = Math.sin(r.th);
      const px = dx * c + dy * q, py = -dx * q + dy * c;
      const inX = r.fl ? (px <= 3 && px >= -r.lbw - 3) : (px >= -3 && px <= r.lbw + 3);
      if (inX && Math.abs(py) <= r.lbh / 2 + 3) return r;
    }
    return null;
  }
  paperDoc(ctx, x, y, s, pal) {
    // a miniature sheet: tinted body, folded corner, ruled text lines
    const w = s * 0.74, fold = Math.min(s * 0.26, w * 0.42);
    const x0 = x - w / 2, y0 = y - s / 2, x1 = x + w / 2, y1 = y + s / 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x1 - fold, y0); ctx.lineTo(x1, y0 + fold);
    ctx.lineTo(x1, y1); ctx.lineTo(x0, y1); ctx.closePath();
    ctx.fillStyle = pal.fill; ctx.fill();
    ctx.strokeStyle = pal.edge; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1 - fold, y0); ctx.lineTo(x1 - fold, y0 + fold); ctx.lineTo(x1, y0 + fold); ctx.closePath();
    ctx.fillStyle = pal.fold; ctx.fill();
    ctx.strokeStyle = pal.edge; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = pal.ink; ctx.lineWidth = 1;
    ctx.beginPath();
    for (const yy of [y0 + s * 0.38, y0 + s * 0.54, y0 + s * 0.70]) {
      ctx.moveTo(x0 + w * 0.16, yy); ctx.lineTo(x1 - w * 0.14, yy);
    }
    ctx.stroke();
    return w;
  }
  drawAssoc(ctx, u, list) {
    const sh = Math.max(0, Math.min(1, this.bgShade == null ? 1 : this.bgShade));
    const halo = mixHex('#ffffff', '#0d1117', sh);
    const palTopGold = { fill: '#ffce6b', edge: '#8a5a00', fold: '#ffe9b8', ink: 'rgba(90,60,0,.8)' };
    const palRestGold = { fill: '#fff3d6', edge: '#d9b45c', fold: '#ffffff', ink: 'rgba(140,110,40,.75)' };
    const palTopBlue = { fill: '#5f9dff', edge: '#173a7a', fold: '#cfe0ff', ink: 'rgba(255,255,255,.85)' };
    const palRestBlue = { fill: '#d7e6ff', edge: '#7ea6e8', fold: '#ffffff', ink: 'rgba(60,90,150,.8)' };
    const palUngrGold = { fill: '#f1ede4', edge: '#b3ab99', fold: '#ffffff', ink: 'rgba(120,110,95,.8)' };
    const palUngrBlue = { fill: '#e9edf3', edge: '#a3adbf', fold: '#ffffff', ink: 'rgba(100,112,130,.8)' };
    const byTheme = new Map();
    for (const it of list) {
      if (!byTheme.has(it.theme)) byTheme.set(it.theme, []);
      byTheme.get(it.theme).push(it);
    }
    const r = this.cv.getBoundingClientRect();
    const W = r.width || 300, H = r.height || 400;
    // Phase 1 — sun-dial walk: paper icons ring the orb on a true circle of
    // uniform edge clearance (pulse-proof, zoom-aware scale); each filename
    // is drawn RADIALLY along its icon's spoke (like a reference sun-dial —
    // reading outward, flipped past vertical so glyphs never invert),
    // starting just outside its icon. Text thickness gives a thin uniform
    // angular width, so a measured walk packs rays without same-ring
    // collisions; overflow spills outward.
    const placements = []; // {tid,it,x,y,w,s,fs,pal,ox,oy,a,a0,orb,base,th,lw,showLabel,lx,ly}
    const orbDiscs = []; // every theme body's disc, so rays dodge other orbs too
    {
      const bsAll = (this.bodyScale == null ? 1 : this.bodyScale);
      for (const n of u.byId.values()) {
        if (!n || !n._p) continue;
        const q = n._p;
        orbDiscs.push({ id: n.id, x: q.x, y: q.y, r: Math.max(2, (n.radius || 6) * (n._fitBoost || 1) * q.s * 1.6 * bsAll) });
      }
    }
    for (const [tid, items] of byTheme) {
      const node = u.byId.get(tid);
      if (!node || !node._p) continue;
      const p = node._p;
      if (p.x < -140 || p.y < -120 || p.x > W + 140 || p.y > H + 120) continue;
      const bs = (this.bodyScale == null ? 1 : this.bodyScale);
      const orbR = Math.max(2, (node.radius || 6) * (node._fitBoost || 1) * p.s * 1.6 * bs);
      const showLabel = !!items[0].showLabel;
      // zoom-aware icon scale: paper sheets stay readable when the orb fills
      // the screen, and stay compact when it shrinks to a speck. p.s is the
      // perspective scale (~1.1 at the default distance, ~3.2 fully zoomed
      // in, ~0.1 fully out).
      const zf = Math.max(0.9, Math.min(1.6, 0.75 + (p.s || 1) * 0.35));
      let s = 15;
      if (items.length > 12) s = 12;
      if (items.length > 30) s = 10;
      s = Math.min(24, s * zf);
      const fs = Math.min(16, 10 * zf);
      if (showLabel) {
        ctx.font = `400 ${fs.toFixed(1)}px Inter, system-ui, sans-serif`;
        for (const it of items) {
          const t = it.title.length > 20 ? it.title.slice(0, 19) + '…' : it.title;
          it._short = t;
          it._lw = ctx.measureText(t).width;
        }
      }
      // dynamic encircling: the ring is a true circle of uniform edge
      // clearance, recomputed from the live orb radius every frame — so zoom
      // never parks icons inside the disc (pulse-proof: the sphere breathes
      // ±8%). A fixed 3-per-ring minimum used to cram icons where fewer fit;
      // the angular walk below replaces it.
      const edge = orbR * 1.08; // pulse-proof silhouette
      const gap = s * 1.1 + 8 + (showLabel ? s * 1.9 : 0);
      const step = showLabel ? s + fs + 18 : s + 12;
      let ring = 0, base = edge + gap;
      // text rides RADIALLY (like the reference sun-dial: tick, then the
      // filename reading outward along its spoke, flipped past vertical so
      // glyphs never invert). Angular half-width comes from text THICKNESS
      // at the capsule's mid radius — thin uniform wedges, many rays/ring.
      const halfAng = (it) => {
        if (!showLabel) return (s * 0.37 + 5) / Math.max(8, base);
        const lw = it._lw || 0;
        const rs = base + s * 0.62 + 5;
        // worst of the two wedges: the paper icon at the inner ring and the
        // thin text capsule at its mid radius — spacing by the max keeps both
        // clear on the same ring (the icon wedge usually binds near the hub)
        return Math.max((s * 0.37 + 5) / Math.max(8, base), (fs / 2 + 6) / Math.max(8, rs + lw / 2));
      };
      // even sun: greedily fill rings by angular width, then spread each
      // ring's rays UNIFORMLY around the circle (like the reference dial),
      // so small themes fan out instead of bunching up
      const lists = [[]];
      for (const it of items) {
        let hw = halfAng(it); // closure reads the current ring's base
        const list = lists[lists.length - 1];
        const used = list.reduce((sum, e) => sum + e.hw * 2, 0);
        if (list.length > 0 && used + hw * 2 > Math.PI * 2 - 1e-6) {
          ring++; if (ring > 12) break; // runaway guard: absurdly many/large labels
          base += step;
          hw = halfAng(it);
          lists.push([]);
        }
        lists[lists.length - 1].push({ it, hw });
      }
      lists.forEach((list, ri) => {
        const rBase = edge + gap + ri * step;
        const n = list.length;
        const rStart = -Math.PI / 2 + ri * 0.35;
        list.forEach((e, k) => {
          const ea = rStart + ((k + 0.5) * Math.PI * 2) / n;
          const it = e.it;
          const pal = it.ungr
            ? (it.seedActive ? palUngrGold : palUngrBlue)
            : it.top
            ? (it.seedActive ? palTopGold : palTopBlue)
            : (it.seedActive ? palRestGold : palRestBlue);
          placements.push({
            tid, it, s, fs, pal, showLabel, ox: p.x, oy: p.y, a: ea, a0: ea, orb: orbR, base: rBase,
            x: p.x + Math.cos(ea) * rBase, y: p.y + Math.sin(ea) * rBase,
            w: s * 0.74,
            lw: showLabel ? (it._lw || 0) : 0, lx: 0, ly: 0,
          });
        });
      });
    }
    // Phase 2 — sun-dial de-collision (convergent angular sweep). Each
    // ray's filename is a radial capsule (text centerline + thickness); icons and orbs are circles. Up to 8 sweeps run in stable
    // order; probes stay within ±0.7 rad of the even walk slot (no
    // cross-circle herding). Deterministic frame to frame (no flicker).
    const capAt = (pl, a) => {
      // radial capsule: text centerline runs outward along the spoke from
      // just outside the paper icon; rotation flips past vertical so text
      // is never upside-down (left side reads outer→inner, like reference)
      const rs = pl.base + pl.s * 0.62 + 5;
      const cx = Math.cos(a), sy = Math.sin(a);
      const x1 = pl.ox + cx * rs, y1 = pl.oy + sy * rs;
      const x2 = pl.ox + cx * (rs + pl.lw), y2 = pl.oy + sy * (rs + pl.lw);
      const flip = cx < 0;
      // text anchor: ALWAYS the inner end (just outside the icon). Flipped
      // rays use align-right + PI rotation, so glyphs still span rs→rs+lw
      // outward and read outer→inner — anchoring the outer end instead would
      // shove the whole name one full text-length too far out (the "names
      // far from their icons" bug).
      return {
        lx: x1, ly: y1, th: flip ? a + Math.PI : a, flip,
        x1, y1, x2, y2, r: pl.fs / 2 + 3,
        ix: pl.ox + cx * pl.base, iy: pl.oy + sy * pl.base,
        ir: Math.hypot(pl.w, pl.s) / 2 + 2,
      };
    };
    const discs = orbDiscs.map((d) => ({ x: d.x, y: d.y, r: d.r, orb: d.id }));
    const names = []; // orb text nameplates as horizontal capsules
    {
      const lsc = (this.labelScale == null ? 1 : this.labelScale);
      if (lsc > 0.01) {
        const bsAll = (this.bodyScale == null ? 1 : this.bodyScale);
        for (const n of u.byId.values()) {
          if (!n || !n._p || !n.label) continue;
          const q = n._p;
          const rad = Math.max(2, (n.radius || 6) * (n._fitBoost || 1) * q.s * 1.6 * bsAll);
          const fsO = Math.max(8, Math.min(15, 11 * (0.6 + q.s))) * lsc;
          ctx.font = `400 ${fsO.toFixed(1)}px Inter, system-ui, sans-serif`;
          const tw = ctx.measureText(n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label).width;
          const y0 = q.y + rad - 2, y1 = q.y + rad + 2 * fsO + 8;
          names.push({ x1: q.x - tw / 2 - 3, y1: (y0 + y1) / 2, x2: q.x + tw / 2 + 3, y2: (y0 + y1) / 2, r: (y1 - y0) / 2, orb: n.id });
        }
      }
    }
    // A, B: {c: capsule|null, i: icon circle} — every pairing, both directions
    const clash = (A, B) => {
      if (A.c && B.c && dSegSeg(A.c.x1, A.c.y1, A.c.x2, A.c.y2, B.c.x1, B.c.y1, B.c.x2, B.c.y2) < A.c.r + B.c.r) return true;
      if (A.c && B.i && dPtSeg(B.i.x, B.i.y, A.c.x1, A.c.y1, A.c.x2, A.c.y2) < A.c.r + B.i.r) return true;
      if (A.i && B.c && dPtSeg(A.i.x, A.i.y, B.c.x1, B.c.y1, B.c.x2, B.c.y2) < A.i.r + B.c.r) return true;
      if (A.i && B.i && Math.hypot(A.i.x - B.i.x, A.i.y - B.i.y) < A.i.r + B.i.r) return true;
      return false;
    };
    const shapeAt = (pl, a) => {
      const c = capAt(pl, a);
      return { c: pl.showLabel ? c : null, i: { x: c.ix, y: c.iy, r: c.ir }, cap: c };
    };
    const cur = placements.map((pl) => shapeAt(pl, pl.a));
    const hitsFixed = (pl, sh) => {
      for (const d of discs) {
        if (d.orb === pl.tid) continue; // own disc: ring clears it by construction
        if (Math.hypot(sh.cap.ix - d.x, sh.cap.iy - d.y) < sh.cap.ir + d.r) return true;
        if (sh.c && dPtSeg(d.x, d.y, sh.c.x1, sh.c.y1, sh.c.x2, sh.c.y2) < sh.c.r + d.r) return true;
      }
      for (const m of names) {
        if (sh.c && dSegSeg(sh.c.x1, sh.c.y1, sh.c.x2, sh.c.y2, m.x1, m.y1, m.x2, m.y2) < sh.c.r + m.r) return true;
        if (dPtSeg(sh.cap.ix, sh.cap.iy, m.x1, m.y1, m.x2, m.y2) < sh.cap.ir + m.r) return true;
      }
      return false;
    };
    const hitsOther = (i, sh) => {
      for (let j = 0; j < placements.length; j++) {
        if (j === i) continue;
        if (clash(sh, cur[j])) return true;
      }
      return false;
    };
    for (let sweep = 0; sweep < 8; sweep++) {
      let clean = true;
      for (let i = 0; i < placements.length; i++) {
        const pl = placements[i];
        if (!pl.showLabel) continue; // icons alone: walk spacing suffices
        let sh = shapeAt(pl, pl.a);
        if (!hitsFixed(pl, sh) && !hitsOther(i, sh)) { cur[i] = sh; continue; }
        // colliding: probe both directions in growing strides, first fully
        // clear angle wins (positive side preferred on ties); probes stay
        // within ±0.7 rad of the EVEN walk slot (no cross-circle herding),
        // and on total failure the current angle is kept.
        const midR = pl.base + pl.s * 0.62 + 5 + pl.lw / 2;
        const stride = Math.max(0.05, (pl.fs / 2 + 12) / Math.max(8, midR) / 4);
        const maxTravel = 1.0;
        let found = false;
        for (let d = stride; d <= maxTravel + 1e-9; d += stride) {
          const cands = [pl.a + d, pl.a - d].filter((c) => Math.abs(c - pl.a0) <= 0.7);
          for (const cand of cands) {
            const sh2 = shapeAt(pl, cand);
            if (!hitsFixed(pl, sh2) && !hitsOther(i, sh2)) {
              pl.a = cand; cur[i] = sh2; found = true; break;
            }
          }
          if (found) break;
        }
        if (!found) cur[i] = shapeAt(pl, pl.a);
        clean = false;
      }
      if (clean) break;
    }
    for (let i = 0; i < placements.length; i++) {
      const pl = placements[i], c = cur[i].cap;
      pl.x = c.ix; pl.y = c.iy;
      pl.lx = c.lx; pl.ly = c.ly; pl.th = c.th; pl.flip = c.flip;
    }
    // debug snapshot: final ray per placement (angle deg, ring base)
    this._assocDebug = placements.map((pl) => ({ theme: pl.tid, title: pl.it.title, base: Math.round(pl.base), deg: Math.round(pl.a * 180 / Math.PI), show: !!pl.showLabel }));
    // Phase 3 — draw everything (icons, radial labels) + hit rects.
    for (const pl of placements) {
      const { x, y, s, fs, pal, showLabel } = pl;
      this.paperDoc(ctx, x, y, s, pal);
      let rx = x - pl.w / 2 - 3, ry = y - s / 2 - 3, rw = pl.w + 6, rh = s + 6;
      if (showLabel) {
        const ink = pl.it.ungr
          ? (pl.it.seedActive ? mixHex('#78716c', '#e7e2d5', sh) : mixHex('#646e82', '#c9d2e0', sh))
          : pl.it.top
          ? (pl.it.seedActive ? mixHex('#8a5a00', '#ffe9b8', sh) : mixHex('#dcecff', '#bed2f5', sh))
          : mixHex('#1b2a45', '#bed2f5', sh);
        ctx.font = `400 ${fs.toFixed(1)}px Inter, system-ui, sans-serif`;
        ctx.save();
        ctx.translate(pl.lx, pl.ly);
        ctx.rotate(pl.th);
        ctx.textAlign = pl.flip ? 'right' : 'left';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = `rgba(${halo[0]},${halo[1]},${halo[2]},0.9)`;
        ctx.fillStyle = `rgba(${ink[0]},${ink[1]},${ink[2]},0.95)`;
        ctx.strokeText(pl.it._short, 0, 0);
        ctx.fillText(pl.it._short, 0, 0);
        ctx.restore();
        ctx.textBaseline = 'alphabetic'; // orb labels below assume the default
        // union = icon box + radial capsule's AABB (anchor + len along th)
        const tdx = Math.cos(pl.th), tdy = Math.sin(pl.th);
        const e1x = pl.lx + tdx * (pl.flip ? -pl.lw : pl.lw);
        const e1y = pl.ly + tdy * (pl.flip ? -pl.lw : pl.lw);
        const cr = fs / 2 + 3;
        rx = Math.min(x - pl.w / 2, Math.min(pl.lx, e1x) - cr) - 3;
        ry = Math.min(y - s / 2, Math.min(pl.ly, e1y) - cr) - 3;
        rw = Math.max(x + pl.w / 2, Math.max(pl.lx, e1x) + cr) - rx + 3;
        rh = Math.max(y + s / 2, Math.max(pl.ly, e1y) + cr) - ry + 3;
      }
      // lbx/lby = text ANCHOR + rotation + flip (assocHit maps into text space)
      this._assocRects.push({ theme: pl.tid, doc: pl.it.doc, title: pl.it.title, ungr: !!pl.it.ungr, x: rx, y: ry, w: rw, h: rh,
        ibx: pl.x - pl.w / 2 - 3, iby: pl.y - pl.s / 2 - 3, ibw: pl.w + 6, ibh: pl.s + 6,
        lbx: showLabel ? pl.lx : 0, lby: showLabel ? pl.ly : 0, lbw: showLabel ? pl.lw : 0, lbh: showLabel ? fs : 0, th: showLabel ? pl.th : 0, fl: showLabel && pl.flip ? 1 : 0 });
    }
  }
  starfield(ctx, W, H, t = performance.now() / 1000) {
    // deterministic twinkle field (no allocation per frame beyond gradient use)
    const sh2 = Math.max(0, Math.min(1, this.bgShade == null ? 1 : this.bgShade));
    const sc = mixHex('#42547a', '#ffffff', sh2);
    ctx.fillStyle = `rgb(${sc[0]},${sc[1]},${sc[2]})`;
    for (let i = 0; i < 90; i++) {
      const h = (i * 2654435761) % 100000;
      const x = (h % 1000) / 1000 * W, y = ((h >> 10) % 1000) / 1000 * H;
      const a = 0.12 + 0.1 * Math.sin(t * 0.7 + i);
      ctx.globalAlpha = Math.max(0.03, a);
      ctx.fillRect(x, y, 1.3, 1.3);
    }
    ctx.globalAlpha = 1;
  }
}

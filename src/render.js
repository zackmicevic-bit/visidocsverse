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
    // an emptied workspace has no universe: keep rendering the backdrop + stars.
    const u = uni || { nodes: [], edges: [], byId: new Map(), sunId: null };
    // project + sort far -> near (z-buffered draw order)
    for (const n of u.nodes) n._p = this.project(n.x, n.y, n.z);
    const order = [...u.nodes].sort((a, b) => b._p.depth - a._p.depth);
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
        const hc = n.isActive ? '255,210,120' : '90,150,255';
        halo.addColorStop(0, `rgba(${hc},${n.isActive ? 0.5 : 0.35})`);
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
      if (n.isActive) {
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
          ctx.globalAlpha *= this.overlayAlpha * (n.isActive ? 0.45 : 1); // sun keeps its gold signal
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
      if (n === this.hover || n.isActive) {
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
        ctx.font = `${n.isActive ? '700' : '400'} ${fs.toFixed(1)}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        // label ink flips with the background so text stays readable on white
        const ink = mixHex('#1b2a45', '#bed2f5', sh);
        const inkA = mixHex('#8a5a00', '#ffe9b8', sh);
        const halo = mixHex('#ffffff', '#0d1117', sh);
        ctx.strokeStyle = `rgba(${halo[0]},${halo[1]},${halo[2]},0.9)`;
        ctx.fillStyle = n.isActive ? rgb(inkA) : `rgba(${ink[0]},${ink[1]},${ink[2]},${(0.45 + p.s * 0.5).toFixed(2)})`;
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

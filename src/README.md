# Visi|Docsverse — living 3D document universe

Web adaptation of the Tauri spec: no Rust/React — vanilla JS + Canvas 2D with a
custom 3D projection renderer. Vault persists in `localStorage` (`visidocsverse.v1`).

## Standing user rules
- Glossary auto-update: every change that adds, renames, moves, or removes a
  user-facing control, label, or behavior must also update the in-app glossary
  (`#glossBody` in `index.html`) in the same edit — definitions, control
  lookalikes (`.gi` icons), and term coverage. Never leave the glossary
  describing an older UI.

## Files
- `index.html` — shell + CSS + boot (`src/app.js`)
- `src/vault.js` — local doc store, intake, mass = words + refs, links/tags parse
  (explicit `#tags` + `auto/*` title/body tags, wallpaper-guarded tethers/mass),
  TF-IDF topic correlation (topicSim/topicShared/topicMaxDf gates, topK cap,
  idf sample floor so small canvases keep webs comparable to the big universe)
- `src/physics.js` — N-body gravity, orbital-velocity init, Hooke springs, comets
- `src/render.js` — orbit camera + perspective projection, glow nodes, neon beams
- `src/app.js` — wiring, panels, folder/file/drop intake, search, universe speed
  controls (Pause + log slow-motion slider), body context menu + properties dialog

## Physics (tuned, verified headless)
- Sun (active doc) mass 600 at origin; satellites `v = sqrt(G*M/r)` tangential.
- The 600 is a physics override — every node keeps its vault mass in `trueMass`,
  which is what the meta line + Properties show, and what an ex-sun is restored to.- Linked bodies: shell tethers by BFS depth (150/250/350) + radial braking
  (no isotropic drag — it eats orbits). Peer springs (sun bonds are gravity's).
- Corona: mass-scaled radiation pressure below r=55 — nothing is swallowed.
- Comets (degree 0): outward drift, soft rim cap 1400. vmax 30, dt 0.3.
- Cruise control (tethered bodies): tangential speed is steered toward the
  circular-orbit value for its radius, so no body grinds to a crawl while a
  neighbor at the same radius races — every view keeps the same stately
  Kepler motion (outer orbits stay slower, correctly). Isolates are exempt.
- Focus: new sun GLIDES home (never teleports); old sun shoved off-center and
  blended to orbital velocity. Bounds after transitions: 50 < r < 1500.
- General state (no active body): off-click into empty space releases the sun
  (`Universe.defocus()` restores its vault mass); the canvas center itself pulls
  with sunMass so the lens holds together and orbits the origin. Orbital-velocity
  init and shell memory keep the formation instead of rescattering.

## Intake formats
- `.md/.markdown/.txt/.csv` plain text · `.pdf` (pdf.js) · `.docx` (mammoth) ·
  `.xlsx/.xls` (SheetJS, per-sheet CSV) · `.pptx` (slide text) · video
  `.mp4/.mov` · audio `.mp3/.wav` · photos `.jpg/.png` (read by OCR) · legacy
  `.doc/.ppt` rejected with a re-save message · exact-duplicate text skipped.
  All format engines are vendored in `src/vendor/` (pdf.js + worker, mammoth,
  SheetJS, fflate, tesseract + English data) — intake works fully offline.
- Embedded pictures import too: `.docx`/`.pptx` media in document order,
  `.xlsx` sheet drawings (screenshots pasted into cells), `.pdf`
  image-bearing pages as printed page images (text-only pages stay
  text). Bytes live in the `visidocsverse-img` IndexedDB sidecar (never
  localStorage); docs carry only the manifest, rendered as a click-to-zoom
  gallery below the prose. Orphaned bytes are purged on every removal.
  Restored backups keep the manifest but show a placeholder for bytes.
- OCR: stored pictures are read by a vendored tesseract.js (English, local
  worker + core + language data — no network) and
  high-confidence words join the doc in a marked "Pictures' text" section, so
  image text tags, tethers, searches — and every word counter (reader words,
  corpus totals, mass, largest-bodies) — like typed text. Bounded (8
  pictures/file, 30s each, confidence + length gates, tiny icons skipped);
  any failure skips OCR while text + pictures still import — including a 25s
  cap on the engine start itself, which used to park whole batches forever. Image-only files
  (scanned PDFs, picture-only Office docs) import on their OCR words alone;
  docs whose pictures predate OCR get one background backfill pass on load.
- Every import auto-focuses as the sun; failures toast the real reason (6s).
  In a lens there is no doc body to crown, so the upload lands instead: the
  reader goes neutral on the lens overview and every theme (Thematic) or tag
  (Tags) that grounded the new files lights gold in the inventory, centered,
  with its orb haloed — a toast names where they landed (or that they ride
  ungrounded / carry no tags). The highlight persists until the next
  selection, release, lens/tab/Return move, or upload. In Main the first file
  still crowns as the sun, but every uploaded file halos on the canvas and
  stays gold in the inventory list (Back returns to it).
- Video/audio bodies (`.mp4`/`.mov`/`.mp3`/`.wav`) and photo bodies
  (`.jpg`/`.png`): no transcript is extracted — the reader shows the file
  itself below its manifest (a native `<video>`/`<audio>` player, or the
  picture; all fed by the kept original bytes), and the body's menu downloads
  the original. The manifest names the file, format, size, length and
  (photo/video) dimensions, so filename words, tags and notes still tether,
  weigh and search the body; badges read VID (purple) / AUD (teal) / IMG
  (rose). Standalone photos additionally run through the same OCR pipeline as
  embedded pictures, so photographed text joins the body under a marked
  "Pictures' text" section.
- Originals are kept: each upload's full bytes are filed in the
  `visidocsverse-orig` IndexedDB sidecar (this browser only, >100MB files
  skipped), so the body's menu downloads the genuine original file. Bodies
  imported before this, or arrived via backup restore, have no bytes — their
  menu downloads the extracted text as `.txt` instead (plain-text names keep
  their extension; `.pdf`/`.docx`/… fall back to `Name.txt` so it opens).
- Names are trimmed (`"report.docx "` works), extensionless-but-typed files are
  accepted by MIME, and skips are named in the toast (`"archive.zip" .zip …`).
- Folder button + drag-drop recurse into subfolders (File System Access when
  available, `webkitdirectory`/DataTransfer entries otherwise, 60-file cap).

## Labels
- Left panel Labels row: slider 0–300% for file-name size under bodies
  (far left = hidden), button toggles show/hide (restores last nonzero).
  Persisted in `visidocsverse.ui` as lbScale/lbLast, applied as ren.labelScale.

## Body size, rotation + compress
- Three body-geometry rows under Labels (all apply to orbs and ▼ triangles):
  Size (🔵) slider 5–400% scales bodies (picking follows the scale),
  button toggles 100% and the last size; Rotation (🔄) spins bodies around
  the vertical axis — orbs stay round like spheres (surface bands and texture
  drift around while the light stays fixed; limb shading keeps them ball-like)
  and triangles flip edge-on like cards — slider sets speed, button toggles
  (off eases surfaces back to rest, and spin keeps running while the universe
  is paused — it has its own clock); the glow stays a round ambiance, and the
  speed slider uses a perceptual curve (low speeds still visibly turn);
  Compress (↔) squishes bodies along the horizontal axis, slider 20–100%
  (100 = round), button toggles round and the last squish. Size and spin
  compose (spin × squish). Persisted in `visidocsverse.ui` (sizeScale/sizeLast,
  spinOn/spinSpeed, compressScale/compressLast), applied as ren.bodyScale /
  ren.spinTarget+spinOmega / ren.compressScale, and included in cloud backups
  / master files.

## Hover peek
- Bottom pill Hover peek button (first in the row, before Fit): a persisted
  (default on). When on and the canvas is in the released general view,
  hovering a body lights up its row (gold) in the general-view document list —
  expanding the list past the 6 largest automatically (once) and scrolling
  the row into view when it isn't rendered yet, so off-list bodies still
  light up. Otherwise lighting only: it never unfolds or rebuilds the reader, so the
  pane holds still under the cursor. The gold stays
  lit the whole time the body is hovered or selected (and the selected orb's
  own row stays lit too). The reader never
  leaves the general view; click the body to focus it for real. The highlight
  lingers ~1.4s after the cursor leaves the body, and gliding onto the lit row
  holds it — so you can travel from the orb to the reader pane and click the
  row to open that exact document. On/off shows through the tab's .on fill,
  same pill-button styling as the rest of the row.
  Persisted in `visidocsverse.ui` as hoverPrev, included in cloud backups /
  master files (`settings.hoverPrev`).

## Selection spotlight
- Selecting never moves a body. The pick is marked exactly where it sits:
  gold halo + bold label + hot tethers on the canvas, gold rows in the
  inventory (an open Notes pane keeps its document's row gold too). The
  camera pans only when the pick is off-screen, and only just enough to
  bring it into view; hover only ever lights rows. The physical sun changes
  solely through explicit sun controls.
- Reader-driven locates glide instead of snapping: picking a document from
  the reader to find it on the canvas eases the pan when its body already
  projects on-screen (a calm drift for near-center nudges), and snaps fast
  only when the body sits off the screen edge. Right-click empty canvas in
  any view mode for "Snap to center: ON/OFF" — off stops every automatic
  recenter on picks (rows still light gold, orbs stay where they are).
  Persisted in `visidocsverse.ui` and in cloud backups / master files
  (`settings.snapCenter`). Any fresh canvas gesture (press, drag,
  double-click recenter, Fit, reset, Return, lens/tab switch) cancels the
  glide and hands the camera back immediately.

## Background shade
- Left panel Shade row (under Labels): slider 0–100% for canvas background
  brightness — far left = flat white, far right = black deep-space (as today);
  button flips between the two extremes. Label ink, selection rings and the
  starfield invert with the shade so text stays readable on white.
  Persisted in `visidocsverse.ui` as bgShade, applied as ren.bgShade, and included
  in cloud backups / master files (`settings.bgShade`). The top pill's
  top-left corner carries the same flip as a ☾/☀ DARK/LIGHT MODE button —
  one click sets the whole workspace light or dark (canvas, pills, panes,
  tabs and buttons all follow; no new setting, it drives bgShade).

## Glow radius
- Left panel Glow row (under Shade): slider for the halo radius around bodies —
  far left = no glow, middle (50) = current look, far right = double radius;
  button toggles glow on/off (restores last nonzero). Persisted in
  `visidocsverse.ui` as glow/glowLast, applied as ren.glowScale, and included in
  cloud backups / master files (`settings.glow`).

## Tether thickness
- Left panel Tether row (under Glow): slider for tether line thickness —
  far left = hidden, middle (50) = current look, far right = double thickness;
  button toggles tethers on/off (restores last nonzero). Persisted in
  `visidocsverse.ui` as tether/tetherLast, applied as ren.tetherScale, and included
  in cloud backups / master files (`settings.tether`).
- The palette swatches in the same row set the tether color (persisted as
  `tetherColor`). The active body's shared-ground tethers auto-contrast:
  the renderer derives their color as the complementary hue of the selected
  tether color (vividness enforced, achromatic picks land on cyan), so the
  shared-ground links always stand apart — default sky-blue tethers keep
  the classic gold shared-ground links.

## Column collapse
- ▲ arrows at the top-right of the Visi|Docsverse column and the Active Body column
  shrink that column upward into a slim top tab (▼ restores it). Persisted in
  `visidocsverse.ui` and in cloud backups / master files.

## Pills (top and bottom)
- The bottom pill's hanging book tabs (every function tab plus all three split-tab
  frames) wear the live canvas fill — the same white → #11161f shade mix the
  renderer paints at the canvas center — so they always read as cut from the
  canvas below, tracking the background slider continuously (not just the
  light/dark flip). Resting tabs match; the active tab keeps its canvas fill
  with only a red frame/underline (no blue fill) so toggled states still
  read; hover keeps its blue tint.
- The top pill (project tabs, Universe view modes, stats) wears a book-tab shape with a gold glowing edge (flat top, rounded bottom corners, mirroring the bottom pill's Tips tab), and the bottom pill
  (canvas controls + tips) each keep their own natural size — never stretched
  to match each other. The top pill's right edge never passes the bottom
  pill's right edge, so the pair always stays vertically aligned on the right:
  docked, the top pill wraps to the bottom pill's width on their shared left
  edge; hand-moved, it slides back left instead. Drag either by any blank
  background to move it (grab hand; buttons and controls are unaffected); the
  position persists in `visidocsverse.ui` and backups, and the right edge
  always stays inside the screen. Double-click a pill's background to send it
  back to the dock beside the left pane. The top pill also never shrinks below its seated width — with zero tabs the ghost cluster itself goes live (red frame) holding a "Create a project" tab plus "add tab" placeholders across the full row, and with projects the live cluster fills past the last tab with the same static frames (click one to add a tab to that cluster; with no projects it starts the first one). No cluster frame ever shrinks: deleting a tab backfills its space with a placeholder, and every cluster shares one fixed frame width. The cluster sits centered in the pill width in a static frame that never stretches sideways; it only grows downward by wrapping.

## Tethers toggle (bottom pill)
- Tethers partition (left half of the Tethers|2 split tab): shows/hides the tether lines
  between bodies — bodies themselves always stay put. It drives the same
  setting as the left-panel Tether row, so both stay in sync. (The hint pill
  hides on narrow phone screens, so this shortcut is desktop-wide only.)
- "2" partition after Tethers: dotted tethers — the same lines drawn as
  spaced round dots instead of solid strokes (airy 8px+ spacing that grows
  with tether thickness, so fat tethers don't crowd). Independent of
  show/hide and thickness; toggling off restores solid lines. Persisted in
  `visidocsverse.ui`.
- Distribute partition (left half of the snug split tab next to Tethers): auto-distribute pins every body in a
  fit-to-canvas orb (sun at the center, other bodies on mass-ranked fibonacci
  shells, scaled to an ellipse matching the viewport) and freezes orbital
  motion — pan/zoom/orbit still work, but bodies hold still with zero drift.
  Toggling off re-seats every body settled (the same composed golden-angle
  seating fresh canvases open with) and restores orbital dynamics — a bare
  release would drop the zeroed-velocity orb down the gravity well into one
  pile. Persisted in
  `visidocsverse.ui`. Small formations (a 2-theme lens, a 2-doc canvas) fan across the full orb — no inner-shell parking, opening on the lateral axis — so Distribute visibly spreads them instead of huddling a speck at center. While on, a ◈ VERSE MAP glass pane docks bottom-right: a live
  top-down map of every body (gold sun, blue rest, white ring on the
  active body, auto-fit framing, body count in the header) so the full verse
  stays visible while the main view is close. Its header – collapses the map to a slim bar (+ restores, geometry and state persist in backups); header-drags move it, corner ⤴ resizes it. The markers mirror the main
  canvas body shape — dots normally, upside-down ▼ triangles while Body to ▼
  is on — and the main canvas rotation: markers are plotted in the camera's
  own frame, so drag-rotating the view revolves the map with it (right on the
  map is right in the view). Header-drags to move,
  corner-drags to resize (both persist); the silver orb top-right switches
  the polished-glass finish on/off like every other pane; hidden again when
  Distribute goes off, hidden on phone widths.
- Alt-drag a body to move it — every view (Main, Thematic, Tags), with Fit on
  or off, distribute on or off. The drag follows the pointer in the camera's
  world plane (switchable mid-drag: release Alt and it orbits instead); the
  drop rejoins orbital mechanics from its new spot — the body is seated onto
  its circular orbit there, so it keeps orbiting instead of freezing or
  plunging (the stepper never overrides it; mid-drag the pointer owns it).
  The sun keeps its center-homing glide; distribute drops stay owned by the
  pinned orb.
- Plain Body partition after Distribute: renders every body as a flat white
  disc with a thin black outline — gradient shading, glow halos and
  photo-texture overlays are all skipped (labels, tethers, selection rings
  stay). Toggling off restores the textured orbs. Persisted in
  `visidocsverse.ui`.
- "2" partition after Plain Body: keeps the original blue orbs
  (gradients + glow halos) but strips only the photo-texture overlays.
  Mutually exclusive with Plain Body — turning one on turns the other off.
  Toggling off restores the photo overlays. Persisted in `visidocsverse.ui`.
- Body to ▼ partition after the "2" partition: shape swap — every body renders as an
  upside-down triangle with the same fill (gold sun / blue gradient / flat
  white under Plain Body) and the same size as the orb it replaces (photo
  overlays clip to the triangle). Combines with any color mode. Persisted in
  `visidocsverse.ui`.
- Document-icon partition after Body to ▼: shape swap — every document
  and tag body renders as a plain white page icon with a folded corner (gold
  when focused), ruled with three text lines, area-matched to the orb it replaces; photo textures,
  gradients and glow stay off while labels, tethers, sticky squares and
  selection rings stay as they are; while Rotation spins, pages flip edge-on
  like cards. Theme bodies keep their orbs (only
  available in MAIN and TAGS view modes). Shape-exclusive with Body to ▼. The verse-map minimap mirrors the pages.
  Toggling off restores the orbs. Persisted in `visidocsverse.ui`.
- Fit partition (right half of the Distribute|Fit split tab): a TOGGLE that frames the bodies actually
  visible screen — recenters pan, dollies out until every current body
  projects inside the visible region plus drift slack (never zooms in on a
  close-up), and lifts any orb that would render as a speck up to a 10px
  readability floor via a separate view multiplier (physics radii untouched,
  size order preserved, repeat presses converge). Deliberately does NOT
  frame the empty simulation rim (4–9× wider than the shells — rim-framing
  shrinks the formation into an unreadable clump); a rim-bound comet may
  drift out of a fitted frame over minutes, Fit again. Toggling Fit off
  restores the exact pre-fit camera (dist + pan) and per-orb view boosts
  from a snapshot (session-only; selection is untouched). Structural changes
  — canvas switches, rebuilds, lens/distribute toggles — clear the toggle.
  Physics — shells,
  springs, rim, positions, velocities — is never touched by a normal Fit, so
  orbital mechanics survive Fit exactly. One exception: if the bodies have
  already piled up into an overlapping heap (half or more touching — healthy
  shell systems never overlap), Fit re-seats them settled first, then frames;
  the toast says so ("piled-up bodies re-seated"), and Fit-off still restores
  the pre-fit camera. Pressing Fit while Distribute is on switches
  Distribute off first (physics freed, hand placements cleared), re-seats the
  freed bodies settled (the same composed golden-angle seating fresh canvases
  open with — the pinned ball would otherwise frame as a tiny clump), then fits
  normally; toggling Fit back off restores the pre-fit camera while Distribute
  stays off. Double-clicking empty space only recenters pan (never touches the
  zoom, fitted or not); the full camera reset lives in the right-click menu.

## Thematic view (Universe view modes row → Thematic)
- The Thematic entry redraws the canvas: the universe drops its document bodies and
  shows THEME BODIES ONLY — the ideas the files share, distilled into
  first-class bodies labeled with their concepts (e.g. "self-efficacy ·
  alignment").
- Themes are earned, not given: a concept must evidence across several bodies
  to seed or join one (so one-off citation surnames never become labels), and
  terms smeared across the whole corpus ("teacher", "report", "canvas" …) are
  treated as boilerplate wallpaper and excluded — what you see is the genuine
  common ground. Each theme's mass follows its thematic weight, so heavier
  ideas pull harder and anchor their clusters; themes web together through the
  grounded documents they share (every theme gets ≥1 tether — nothing drifts
  off), while explicit [[ref]] links are left out so citation structure can't
  warp the map. The view opens pre-settled — clusters arrive webbed even while
  paused or in slow motion.
- Clicking a theme shows its concepts + grounded member bodies; clicking a
  member drills down — the view exits and the doc opens as sun in the Main
  view. Canvas clicks, search picks, and reader rows drive the reader (gold
  marks what you're viewing) while every body stays exactly where it is;
  the physical sun is crowned through an inventory dot
  box (theme/tag rows; document rows carry an eye-preview + reserved slot
  instead), which does move it home. A Main-view sun carries into the lens: with
  nothing selected but a sun crowned, the lens opens on its anchor theme
  (or anchor tag) as sun instead of sunless, so inner orbits stay fast and
  all three views feel the same tempo; true general state (no sun anywhere)
  still opens sunless. Search in the view lights up the themes grounding the hits; with
  nothing selected, Thematic distills the whole Visi|Docsverse at once (shared
  canvases only, copies counted once — members can jump canvases). Toggling
  off restores the Main view exactly as it was (formation included).
  The view persists across canvas switches, in `visidocsverse.ui`, and in cloud
  backups / master files.
- Associated documents (Thematic view only): right-click a theme orb for "Show
  all associated documents" (with or without name labels) — every grounded
  member document appears as a small paper icon ringed around its seed orb.
  The top grounding documents (the 3 members with the most theme-term evidence
  in their text) draw in the orb's own color (gold when it is the sun, blue
  otherwise); all other members draw in a lighter shade of it. The gold follows
  the reader's selection — clicking a different theme re-gilds its icons in
  place without moving any orb. Icons shrink
  and spill into wider rings as membership grows (labels widen the ring), so
  every related document shows without impinging on neighboring orbs. The ring
  is zoom-aware: its radius tracks the live orb size every frame with uniform
  edge clearance (pulse-proof, so zooming in never parks icons inside the
  disc), and icons + labels scale modestly with zoom to stay readable. Labels
  ride outward along their spoke and de-collide angularly into an even
  sun-dial: each ring's rays spread UNIFORMLY around the circle (small
  themes fan out instead of bunching), each file one ray with its paper
  icon on the inner ring hugging the orb and its filename reading OUTWARD
  along the same spoke (rotated radial text, flipped past vertical so
  glyphs never invert), starting just outside its icon, so no name ever
  sits on any icon. When two rays would print over each other, the later
  one slides a step around the ring until clear — probes stay near their
  even slot so rays never herd across the circle — and every collision
  test is exact (text centerlines as capsules, icons and orbs as circles).
  There are no connecting lines.
  Left-click an icon while its seed theme is the selected sun to reveal that
  document's position in the reader's bodies inventory: the theme inventory
  is restored first (a parked doc pin drops, a collapsed pane reopens),
  then the row lights gold and centers (grounded bodies plus the ungrounded
  files riding that orb, in their own section below) — and the row stays lit
  gold for as long as the selection stands (no fade); right-click an icon for "Remove
  from this canvas" (canvas-only, same confirm as the body menu). Right-click
  the seed orb again for "Remove associated documents from view"; right-click
  empty canvas to show every theme's documents at once (with/without labels)
  or "Clear all associated documents from view". Empty-canvas right-click also
  offers "Remove ungrounded documents from view" (toggle; count shown) — lifts
  the palest ungrounded icons off the canvas while the reader's UNGROUNDED
  inventory keeps them; persisted like the other view flags. The thematic right-click
  menus (theme orb and empty canvas) also offer "Document labels: ON/OFF —
  tap to hide/show associated-document names" — the toggle moved off the
  bottom pill; orb labels are untouched and stay on the
  left-panel Labels row; with nothing in view the menu explains how to
  show documents first. Files grounded in no theme are still shown, palest
  of all, each riding the single orb whose terms hit its text hardest (or
  the largest orb when nothing hits) — every file in the project displays.
  Mixed label states normalize (if any shown name is
  on, one tap turns them all off). Return sits in its own
  tight row atop the pill buttons. Overlay state is session-only and keyed by
  scope (whole-Visi|Docsverse vs one canvas), so tab switches can never show
  another verse's icons.
- "See Tags Inventory" — the gold tag beside the TAGS view mode in the top pill —
  opens every tag in the verse as its original pill on a near-transparent
  glass card — true frosted milk-white glass (milky gradient, 26px
  backdrop blur + saturate/brightness lift, hairline bright edge, etched
  grain, centered bold title, dark-outlined pills) + dark font on a white
  canvas, dark smoked glass + white font on a black canvas (maximum
  contrast either way); pills feed search as
  usual (hover one for its × delete, drag one onto another to merge — thin
  tips at the foot of the card explain both); click out or Esc closes; drag the header to move the card
  anywhere (double-click re-centers; position persists). Its "◈ Show tags view" button enters the Tags view — a separate lens built from the documents' own labels (explicit #tags plus auto-derived ones, prefix-blind), NOT from text concepts: one body per tag, webbed wherever two tags share member documents, tag mass = grounding-body count, so the map shows how your labeling connects the corpus. Tag bodies drill down the same way (tag → grounded members → member opens as sun in the Main view), with their own general/active reader, search light-up, and an "Exit tags view" option; mutually exclusive with the Thematic view; persists the same way.
  Entering from the pop-out closes it. Seating is tuned for dense label meshes: only pairs
  sharing ≥2 docs web directly in big views (loners re-home onto their single
  best partner instead of chaining to the anchor), weak short springs
  (0.005/80) so the mesh can't rope into a ball, rank-tier shells
  (heaviest tags innermost, one-doc tags across three roomy outer lanes), and
  a teleport-free glide into those tiers so the view inherits calm orbital
  motion instead of a settle slingshot. Whenever the reader shows a document
  while the Tags view stands (TAGS jump or a parked member row), every tag
  grounding that document lights gold together — the jump still seats and pans
  on the first (alphabetical) one, and its toast names it plus how many more.
- Universe view modes: the discrete row under the top tabs — MAIN, Thematic and Tag alike as manila folder tabs (fill tracks the canvas shade live with gold ink, bases plugged through the pill's bottom edge with gold outlines joined continuous to the pill's; unselected tabs dim)
  as golden pills, each carrying its own "?" explicator (hover/tap to read,
  ✎ to rewrite). Main shows every document body as itself; Thematic redraws the canvas around
  the ideas the documents share; Tag redraws it around the labels on the
  documents. The live view is highlighted gold. A ▴ arrow after See Tags Inventory
  collapses the whole projects pill to just the view-modes row (▾ restores it);
  the collapse persists like the other pill settings. See the glossary's Main
  (Universe) view, thematic view, tags view, and Universe view modes entries.
- Glossary of Terms: a thin vertical book tab riding the Visi|Docsverse pane's
  right border (gold while open) toggles a tall draggable, resizable
  glass pane docked beside the left panel (always reopens at its dock) — 25+ A–Z in-app definitions (verse, sun, body,
  mass, backlinks, shared ground, center of gravity,
  orbital mechanics, general/active view, thematic tag, delete tag, merge
  tags, rename tag, Main view, thematic view, tags view, view modes) plus a
  side-by-side comparison of the tags view vs the thematic view.
  Terms for on-screen controls carry miniature lookalikes of the real thing
  beside the term name — the reader-edge buttons, the Main/Thematic/Tag
  pills, tag pills with the gold M, the Notes tab, sticky-note squares, and
  the like — so the definition points at exactly what to press.
  Geometry, visibility, and the glass dot persist like the verse map.
  In the editor preview, every term carries an ✎ edit button — wording is
  personal (kept in this browser's localStorage only) and never rides cloud
  backups or installers, which always ship the default text.
  Scrolling the glossary down summons an ↑ Top tab at its bottom-right
  (clear of the resize grip) for an instant jump back; it vanishes at the top.
  Every term ends with a "📌 pin as tab" button that extracts it into its
  own slim book tab stacked under the glossary tab — clicking a pin tab
  opens a small glass pane with just that term (gold tab while open,
  unpin/✕ in the pane header, Esc closes; pins persist like other settings
  and ride backups). Only two pins fit under the tab — a third pin is
  refused with a reminder to unpin one first.
- General state: off-click into empty space releases the sun (◌ Document
  universe view mode: MAIN) — no active body, the canvas center holds gravity, and the
  reader shows a live overview (counts + largest bodies as drill-down rows).
  Beside the LARGEST BODIES caption, a "View all bodies" option lists every
  remaining body underneath (amber ● dots, matching the option's own amber
  text, vs the white ◉ of the largest; toggles back to "Show fewer"; offered
  only past 6 bodies; rows whose document has notes carry a miniature of the canvas sticky square at the row's end — same yellow fill, ruled lines and red
  margin tick — clicking it opens that document's Notes pane directly (the universe stays released); while that pane stands, its row's note mark carries a red frame, which
  switches off again when the pane closes; every row's sub-caption carries words · mass ·
  backlinks; the pane has a wide easy-grab scrollbar for the long
  list). A new canvas always opens on its 6 largest. Clicking any body claims a new sun.
  Every document row in the reader is a tight unit: a left two-box stack, the
  title box, and the gold note box. The stack's top box is 👁 — it pins the
  120-word source preview of that document (anchored at the eye; it stays gold
  while pinned; click again, Esc, or canvas click to close) — and the lower
  box is + #tag, which opens a floating name editor that writes the tag into
  that exact document's text (same rules as the reader's + #tag). Every
  document row also carries a small file-type badge in the title box's
  top-right corner (above the ×): PDF red, WORD blue, TXT grey, PPT orange,
  XLS green, VID purple, AUD teal, IMG rose — taken from the document's original filename extension
  (.doc counts as WORD, .md/.csv as TXT, .mp4/.mov as VID, .mp3/.wav as AUD, .jpg/.png as IMG). The title
  box ONLY parks the document in the pane (gold, sun, camera and even the lens
  stay exactly as they are; kicker reads READING — CANVAS UNCHANGED). Theme/
  tag rows keep the old left dot box instead (it ONLY puts that body on the
  canvas as the sun; lens members take the canvas to the Main first; the
  sun's dot keeps a red border). A VIEW
  IN cluster docked left of the reader (below the side find bar when that
  stands) carries MAIN / THEMATIC / TAGS for the shown document; rows
  themselves carry no pills. THEMATIC / TAGS enter the lens and halo the
  grounding node on the canvas while the reader keeps the document (parked
  pin, READING kicker) — the switch cannot lose it; clicking the haloed node
  itself selects it for real, with Return walking back. The
  active theme pane (GROUNDED BODIES + UNGROUNDED) and the active tag pane
  (GROUNDED DOCUMENTS) use this exact same inventory design — eye + #tag,
  words · mass · backlinks sub-caption, and gold note box included. Pane
  pins never push Return history; any canvas move (canvas click, dot crown,
  release, Return, lens/tab switch) drops the pin and the pane follows again.
  Gold row marks follow the live selection and persist while it stands; an open Notes pane keeps its document's row gold too, unfolding View-all and centering the row when it hides far down the list.
  Clicking a tag pill spotlights only its bodies (the rest fade) via the search
  box — the same empty-space click that releases the sun also clears that
  highlight, restoring the full non-faded view.
- Whole Visi|Docsverse: pressing Thematic with nothing selected distills EVERY
  shared canvas at once (copies deduped by lineage; isolated verses stay out)
  into one theme map (kicker ◈ Document universe view mode: THEMATIC).
  Member rows can ground bodies from other canvases — clicking one jumps to
  that canvas and opens the doc as sun.

## Canvases (top tabs)
- The dark pill at the top holds one tab per Visi|Docsverse canvas. Tabs are separate
  doc sets — switch to compartmentalize views, or copy bodies between canvases
  (right-click a body → Copy to …) to build related constellations elsewhere.
- Right-click a body for two delete scopes: Remove (stays
  everywhere else) vs Remove from everywhere (purges every copy on every
  canvas, found by copy-lineage even after renames, plus same-name duplicates).
- Box-select: shift-drag stretches a crisp selection box (shift-click toggles
  one body, plain click / Esc clears). Right-click the selection for two more
  delete scopes, both confined to the active tab (other canvases keep their
  copies): delete just the selected bodies + their docs, or delete the entire
  tab universe + docs.
- + creates a canvas (starts empty), × closes one (confirm; its bodies are
  deleted), double-click renames. Right-click offers solo copy (just this body)
  or constellation copy (a picker lists every proposed body with the shared
  words behind it — uncheck anything that shouldn't travel, so nothing random
  ever arrives). The transferred sun becomes the destination canvas's new sun
  (when it travels — otherwise that canvas keeps its own). Bodies already there
  are skipped.
- Quantum twins: a copy mirrors its original's live position and velocity in
  every canvas, each frame (first canvas holding the root is the source of
  truth) — transferred bodies keep the exact same rotation and motion as the
  main canvas. Each canvas also keeps its own persistent universe, so switching
  tabs never re-scatters formations. Each canvas remembers its own sun — or its sunless general state.

## Notes (one shared notepad per body)
- Every body owns one notepad: a list of entries (2000 chars each) stored on
  the vault doc (persisted in localStorage, cloud backups and master files).
  Three surfaces read and write the SAME list, so they always agree: the
  yellow sticky square beside the body label (solid when entries exist; the
  sun shows a dashed hollow placeholder so a first note can be created
  in-canvas), the yellow `notes` button after the tag pills in the Active-body
  reader (opens a pop-out showing the latest entry, with `copy` / `delete` /
  `edit` plus a `notes pane` jump), and the Notes book tab on the reader's
  left margin. Copies in other tabs share the lineage's list — a note made
  anywhere appears everywhere, and every square fills solid yellow.
- The Notes book tab is fixed (never draggable). Clicking it opens a glass
  pane parked left of the reader, 30% narrower than the glossary dock, with a
  smooth fade/slide both ways. The pane lists every entry (newest last, with
  timestamp and a per-entry × delete), an entry counter, a composer, and
  Save / Delete all / Cancel plus an Auto-save checkbox (persisted): on, every
  pause in typing lands in one pending entry (created once, then updated —
  clearing the composer drops it); off, nothing is kept until Save pushes it.
  Save finalizes the composer into an entry, Cancel discards the composer and
  this session's auto entry, ✕ just closes (draft kept). Esc closes the pane;
  collapsing the reader closes it too.
- Highlight any text in the body and right-click it for "Send selection to
  notes", or press "＋ Add selection from document" in the pane with text highlighted — the
  highlight is appended as a new entry, stays marked in the body while that
  entry lives (deleting it removes the mark), and clicking the entry's box
  jumps the reader to its passage. A ↑ Top tab appears at the entries list's
  bottom-right once scrolled and jumps back to the top. Opening a Notes pane
  for a body while the reader shows a different body parks that body in the
  Active-body pane too (pane-only pin — sun, camera and lens never move);
  overview/lens readers keep their view.
- The floating square editor edits the latest entry (Save rewrites it, Delete
  drops it) and has a "Notes pane →" jump that opens the pane on that body even with no active body (released view); empty-save clears the latest
  entry. A pane opened this way stays on its notepad across reader re-renders until closed. The reader pop-out mirrors it, and `copy` copies all entries joined.
- Visi|Docsverse pane: "View notes: All / Active body" checkboxes (both ticked by
  default, persisted in `visidocsverse.ui`). All shows solid yellow squares only on
  bodies that actually have notes — never placeholders. Active body always
  marks the selected body: solid when it has a note, hollow frame when not.
- Active-body reader: yellow `notes` button after the tag pills opens the
  Notes pane on this body (same shared notepad as the sticky square and the
  Notes book tab). Every mutation re-renders all mirrors.
- Glass finish: the Visi|Docsverse, Active body and DEV panes share a crisp glass
  overlay — diagonal sheen gradients + 18px blur/saturate, painted as the pane
  background so all text, toggles, thumbnails and filenames render in front.
  On a white canvas (`body.light-canvas`) the same panes deepen to a near-solid
  dark base with muted sheen and a harder edge/shadow so they stay sharp and
  readable; the black-canvas look is untouched.
  Each pane has a small glossy dot in its top-right corner that toggles its own
  glass off (flat background, dimmed dot) and back on; hovering the dot shows
  an explainer caption. Per-pane state (`glazeLeft/glazeDoc/glazeCloud`,
  persisted in `visidocsverse.ui`); hidden when its pane is collapsed.

## Tags (explicit + auto)
- Explicit `#tags` in the text work as before (shared tag = tether + mass).
- Manual tags: select any block of text in the Active body reader, right-click
  it, and choose Tag — the selection becomes a `manual/<slug>` tag on that
  body (whole-word snapped, `a–z 0–9 _` only), badged with a gold M on its
  pills in the reader and the tags pop-out. The menu's suggested name is only
  a starting point: “Name the tag yourself…” opens an inline field (prefilled with
  the suggestion) where any name can be typed — it is slugified the same way
  and lands as a manual tag with the same spot anchor and gold M. Manual tags match, tether, weigh,
  and search exactly like written #tags, but they live outside the body text:
  recounts, renames, and text edits never touch them. Deleting the tag (tags
  view × / delete) or merging it drops the manual entry directly; a merge
  whose source lived only as a manual tag carries the manual-ness onto the
  target name. Glossary: "Tags (manually created)". A pill can also be
  dragged straight from ALL TAGS onto the reader — but it pins ONLY onto
  highlighted (blue-selected) text, never onto plain prose: hovering the
  selection glows gold, hovering elsewhere shows a neutral outline, and
  hovering with nothing highlighted shows red plus a one-per-drag reminder
  to highlight first; dropping anywhere but the blue highlight toasts
  instead of tagging. Highlighting wraps each
  text run of the spot separately, so marks and the jump flash survive
  selections crossing #tags, [[links]], bold, or paragraph breaks.
- Explicit tags (hand-written into the prose): the + #tag button in the
  reader's tag row writes one in-app — type any name (same slug rules, Enter
  to commit, Esc to cancel) and it is appended to the body's text, then
  recounted so it tethers, weighs, and searches like any written tag. The
  in-app counterpart to typing #tag in an imported file; suppression only ever
  hides the auto/ form, so a written tag always (re)brings its name back.
  Glossary: "explicit tag".
- Auto tags: every doc also derives `auto/*` tags from its filename/title words
  (STOP words and pure numbers skipped; long titles keep the longest/most
  distinctive words first, capped at 6) plus, for one- or two-word titles,
  the body's top terms. A plain-prose title like "…arrange the educational
  Programs" therefore pills `#educational` `#programs` … in blue with no
  `#markup` required. Renames recompute the auto portion; explicit tags are
  never touched. Old workspaces heal on load (deterministic recompute).
- Matching is prefix-blind (`auto/educational` ≡ `#educational`) for tethers,
  mass, and search — but a wallpaper guard applies to AUTO tags only: an
  auto tag carried by more than `max(4, 40%)` of the corpus ("evidence" on
  16/18 files) tethers nothing and weighs nothing, while small shared auto
  tags ("screenshot" on 4) tether normally. Explicit tags always count.
- Delete + merge + rename (tags pop-out only — the "ALL TAGS" glass card):
  hover a pill and click its × to delete the tag from every body on the
  canvas (confirmed once; explicit uses are stripped from body texts and the
  auto form is suppressed so title words can't resurrect it — writing #tag
  in any body brings it back); drag one pill onto another to merge the
  dragged tag into the receiving tag (the drop target keeps its name, the
  moved tag disappears); right-click any pill (there, in the reader, or on
  its canvas body) — or double-click a pill right in the card — to rename
  the tag everywhere on the canvas — explicit
  uses are rewritten, manual anchors move with it, auto-only bodies are
  grounded under the new name, the old name is suppressed and the new name
  unsuppressed (renaming onto an existing name folds in like a merge). All
  three dialogs offer “Don't ask again for tag deletes, merges and renames”
  (persisted on this machine; the Confirms row in the tags pane tips shows
  the state and toggles it back on). The card itself header-drags to move and
  corner-drags (⤡ grip, bottom-right) to resize — position and size persist on
  this machine and ride cloud backups; double-clicking the header resets both.
  A "The Art of Tagging: A Quick Guide on
  How to Tag" button under the tips opens a dev-editable glass guide pane
  (machine-only wording, like the glossary). Thin static tips at the foot of the
  card explain all three; the glossary defines "delete tag", "merge tags"
  and "rename tag" (right-click any pill, in the reader, on its canvas body,
  or in the tags card).
  Clicking a pill (no drag) opens the tag's origin body — the first body
  carrying it, preferring explicitly-written tags over auto derivations —
  as the canvas sun AND in the Active body reader, so verse and reader agree. Manual
  tags jump further: the reader scrolls to the exact creation spot (snippet
  anchor stored on the doc, whitespace-blind match, gold flash that nests
  inside the persistent marker). Every manual-tag spot stays visibly marked
  in the reader (subtle gold .spot-mark, re-applied on each render, removed
  with the tag). Anchors persist through backups/copies/restores and move with merges;
  deleting the tag drops its anchor. Anchors are rich (snippet + stripped
  offset + DOM path of the creation range): the jump verifies the path first,
  else takes the occurrence nearest the recorded offset — repeated boilerplate
  can't misroute it. Tags made before this upgrade keep plain-string anchors
  (first occurrence); re-tagging gives them exact-block jumps. Both ops are
  per-canvas (copies elsewhere keep their tags), ride cloud backups / master
  files (`tabs[].suppressedTags`), and apply to merged/copied arrivals too.

## Verse associations (link canvases)
- The top bar reads Visi|Docsverse Projects with no open project and Active Visi|Docsverse Projects once the first exists; the first/starting tab is
  the ★ main verse. Right-click any tab for its associations menu: a
  checkable list of every other verse by full name (✓ linked, ○ unlinked,
  ★ main, isolated verses marked). Tapping a verse links or unlinks it —
  links are always mutual, the menu stays open for multi-select, and no
  confirms interrupt.
- A verse with no links is isolated (◌ dashed tab): uploads land only in
  that tab, searches/tags/indexes are already per-tab, copies neither leave
  nor enter (the body menu says so, with an associate hint), Delete spans
  only that tab, and quantum-twin lockstep skips it so its formation evolves
  independently. Copies made before an unlink stay untouched wherever they
  are.
- Each universe — even a lone tab, which is a universe of one — wears one
  thin wireframe box around its tabs with its carrier "+" after its last box
  (★ main verse, else first tab): one click adds a canvas already joined to
  that universe, parked next to it (double-click a tab to rename). Member
  tabs never carry a "+". Hover a frame for the full member list; a universe
  split by manual moves shows a frame per run. The bar-end "+" always starts
  a fresh separate canvas. The tab row wraps onto extra rows inside the
  pill instead of pushing sideways — even a long universe frame breaks
  across lines — and the whole pill stays in the free lane between the
  side panes (never under the left panel, the reader, or their protruding
  Glossary/Notes book tabs), re-centering
  whenever panes collapse, resize or drag. Once the tab rows themselves
  reach 35% of the screen's pixel height (label and view-mode rows
  excluded), new creates are refused with a
  save-and-close prompt instead of taller rows. Linked tabs share uploads, copies, deletes and
  twin lockstep; copies made before an unlink stay untouched wherever they
  are. The tab menu's "Associated with" lists fellow members as information
  only (not clickable). Tabs can never leave their universe: no menu option
  sends a tab to another (outside) universe — universes grow only through
  their own "+", and moves stay inside the group span. Universes never fuse.
- Linked tabs wear the shared accent color in the top pill (blue tint,
  glowing when active); the moment a tab's last link is removed it drops to
  a dim dashed grey, and linking restores the shared color instantly.
- Every isolated verse owns a distinctive high-contrast identity color
  (assigned from a fixed palette, unused-first, kept when it links and
  unlinks again). While isolated the tab wears its color — solid border,
  tinted fill, matching glow; linking hands it the shared blue back.
- Tab order is user-arranged: each tab's menu has a Position section with
  "← Move left" / "Move right →", bounded by its own universe — a tab can
  only slide within its group's span, so it can never land mid-group and
  split another universe's wireframe (a lone tab offers no arrows at all —
  tabs can never leave their universe). Order persists,
  ships in backups, and never affects links.
- Copy all content: each tab's menu has a Content section — "⧉ Copy all
  content" stashes every body in that tab, then any other tab's "⤓ Paste"
  drops them in (same skip + lineage rules as body copies, pictures shared
  by key; already-here bodies are skipped). The stash survives reloads and
  stays put for repeated pastes.
- Closing the main verse promotes the oldest remaining tab to main; closing
  any verse drops its id from everyone else's link lists.
- Stored in `visidocsverse.tabsV1` as mutual `assoc` id lists (legacy
  `disassociated` flags migrate: shared rows join the legacy pool, isolated
  rows start alone; legacy `visidocsverse.v1` migrates into Universe 1 on first
  run); cloud backups / master files carry every canvas plus links.
- The store never seeds over existing bytes: if the saved payload fails to
  parse or validate at boot, the raw bytes are stashed under a timestamped
  `visidocsverse.tabsV1.corrupt.*` key (newest 3 kept) before any fresh seed
  is written, so the workspace can always be diagnosed and restored.

## Reader pane
- Carousel (two-pages button under the reader's stretch arrow): re-reads the Active body as a
  curved left/right-scrollable coverflow of glass panes floating over the
  canvas. The reader's text is cloned into at least 3 page panes (3–10 by word
  count, paragraph-aware; the body's pictures ride the last page in their
  original format). The center pane sits flat with a gold frame while the sides
  swing back in 3D; arrows, wheel, drag and ←/→ keys all page, and the header
  counts pages. Any click outside the panes, ✕ or Esc closes it (the toggle
  re-opens). A header slider enlarges the panes up to 45% (pane width, text and height scale together; persisted). Double-click a pane (or its ⤢ button — or the jump-to-original icon above the carousel trigger) to open the whole original document over the carousel — full reader format with pictures, own 100–200% zoom (slider or Ctrl+scroll), scrolled to that page; Esc returns. Photo/video/audio originals lead on the first page; extracted text and tagged pictures follow on later pages, and spreadsheets preview as a table with the original one click away.
- Top of the pane is a SHARED GROUND hover menu (topic-tethered bodies +
  shared terms, up to 12); hover the label to open, tap it on touch, Esc or a
  selection closes it. Explicit [[links]] stay inline below as before.
- Search (top-left bar, `/` focuses) matches titles, then tags, then full
  body text (up to 12 rows; matching bodies light up in the universe).
  Ctrl/Cmd+A outside a text field selects the open document only, never the
  whole app. Opening a body from a search carries the term into the reader:
  every occurrence highlights, the first scrolls into view, and the find bar
  (‹ › count) steps through them. The find bar sits permanently under the
  tag row in every view — type to highlight live, ‹ › steps, Esc clears
  the term (the bar itself stays put). Clicking the
  bar's ‹ or › summons a redundant copy parked left of the reader, centered on
  its height — same term, same count, Esc clears both. A search-result
  click whose jump lands past the top of the body summons it too. The side
  copy stays until Esc dismisses it, so retyping never loses it. Typing highlights live, Enter steps, Esc
  clears. Scrolling the reader down summons an ↑ Top tab at the pane's
  bottom-right for an instant jump back; it vanishes at the top. Highlights are spans only — stored text, tags, and manual-tag spots
  are untouched. Find works on whatever the reader shows — a document, a
  theme, a tag, or an overview — and survives switching bodies (the new body
  re-highlights the same term); remove/delete/preview stay document-only.

## Source preview (right-hold preview)
- Press and HOLD right mouse on a body to preview the first 120 words of its
  source in a glass pop-out (same frost recipe as the tags pane); release to
  dismiss. A plain quick right-click keeps the existing context menu.
- Smart excerpt: Abstract for papers, Foreword/Preface/Prologue/Introduction
  for books, opening lines otherwise; picture-only bodies show a thumbnail.
- Works mid-orbit too: the pop-out is pinned at the press point, so a running
  universe doesn't smear it (the body may drift on underneath, harmlessly).
  Never in the Thematic lens (theme bodies have no source text).
- No right-click? No problem: the 👁 box on any document row pins the same
  120-word pop-out (it stays gold while pinned; click again, ✕ in the
  pop-out, Esc, or the canvas to close). Touchscreens too.
- From the quick right-click menu: its first item is 👁 Preview source, which
  pins the same pop-out (handy when the hold-preview vanishes the moment you
  try to click into it — pin it via the menu or the reader instead).
- Overlays never stack: opening the preview dismisses the image zoom + any
  menu, and clicking a reader image while the preview/menu is up dismisses
  them instead of zooming (click the image again for the zoom once clear).
- While shown, the body stays lit in the reader's body list (which
  auto-expands past the 6 largest if needed) — when the reader pane is open.

## "?" explicators (editable in the editor, locked on desktop)
- All twenty helpers are editable: the left-pane Search (? beside the search bar),
  SHARED GROUND (? in the reader pane),
  mass (? in the doc meta line),
  GROUNDED DOCUMENTS ("BODIES") (? in the tag pane's grounded-members header,
  shared key) + GROUNDED BODIES (? in the theme pane's grounded-members header) +
  UNGROUNDED (? in the theme pane's ungrounded-guests header) + MAIN / THEMATIC /
  TAGS (? beside each Universe-view-mode pill in the top pill) + the three
  bottom-pill tip rows (inline ✎ in each row, editing the row's HTML) + the
  seven reader overview blurbs (inline ✎ after the muted text in every
  inventory view: Main, Thematic, empty-Thematic, sun-release, Tags,
  empty-canvas, no-open-canvas) + the top pill's header ? (autosave
  explanation, inline ✎ in its pop-out) + the three "+" hover captions
  (inside-frame join, outside-frame standalone, empty-state Create
  Project — reworded via right-click on the button itself) + the
  close-canvas confirm notice
  (✎ edit button inside the dialog itself; `{name}`/`{n}`/`{bodies}`
  placeholders fill in per canvas — one template for canvases with
  bodies, one for blank ones).
  Closing a ? (click or Esc) hides its pop-out at once instead of riding the
  hover grace — otherwise gliding down onto the rows below crosses the
  still-visible pop and its :hover re-shows it right after closing.
  Hover/tap a ? to read it, click its ✎ edit button to rewrite it.
- Wording persists in `localStorage` (`visidocsverse.help`) and rides along in
  cloud backups / master files (`settings.help`).
- The ✎ buttons only appear in the Perchance editor/preview (`body.help-can-edit`).
  Desktop shells are read-only: file:// / tauri: / wry: / app: protocols,
  Tauri/Electron user-agents, and `window.VISIDOCSVERSE_HELP_LOCKED === true` all
  hide the buttons. For a desktop export, add
  `<script>window.VISIDOCSVERSE_HELP_LOCKED = true</script>` before src/app.js
  (or append `?helpedit=0` to preview the locked state).

## Body overlays
- Each body gets a stable photo texture from `src/overlays/` (35 256px
  thumbs built from the Pexels set, manifest in `src/overlays.json`),
  picked + spun/mirrored by id hash so neighbours differ; sun keeps 45%.
- Left panel: Overlay slider = opacity (persisted in `visidocsverse.ui`),
  Overlay button = on/off toggle (restores last nonzero). Loader is
  index-stable: a failed image leaves that body gradient.

## DEV pane: cloud backup + installer links (stripped from installers)
- One merged bottom-left pane titled ◇ DEV, always visible on web:
  cloud-backup items above the divider, DEV BUILDS installer links + note
  below (`hide` puts it away; desktop installers strip it entirely via
  `src/tools/desktop/strip-dev.mjs` — run it after copying the frontend
  into `dist/`).
- Push backup → JSON snapshot (live src/* + main.pjs via API + vault docs +
  settings) uploaded to a permanent uploads.dev URL; last 8 kept in
  `visidocsverse.backups`. Master file = same schema, downloaded locally.
- Load… restores a master file (confirm → prefs + docs + rebuild, with an
  explicit "already matches — nothing changed" line when the file holds the
  same docs). Merge… adds the file's documents into the current canvas instead
  (keeps what is open; exact-text duplicates are skipped, same-name arrivals
  land as "Name (2).md"). The same two rows also live in "Open Existing
  Project" under "From a computer file" — that copy is desktop-safe (bundled
  helpers only, no cloud, no dev pane) and ships in installers.
  Dropping a downloaded
  `visidocsverse-master-settings.json` onto the canvas offers the Load path. The
  loader accepts current files plus tabs-only / vault-only / legacy `{docs}` /
  bare-array shapes, normalizes ragged doc rows (missing id/links/tags/words
  are repaired, never abort the restore), and reports the exact problem (bad
  JSON vs not-a-backup vs empty) instead of silently doing nothing. All
  personalization ships in `settings` (speed, overlay, labels, shade, glow,
  tether + color, backdrop, panes, glaze, collapse, width, lens, notes filters,
  topics, help wording).
- index.html isn't fetchable at runtime in preview, so the shell is
  best-effort (saved-page fallback) — src/ + main.pjs carry all logic.

## Licensing (Lemon Squeezy online activation + offline key file)
- EULA first: every desktop shell shows the End User License Agreement modal
  before the Activate modal — the I Accept button stays disabled until the
  "I have read and accept" box is ticked (text in `src/eula.js`, identical
  to `src/tools/desktop/EULA.txt`; acceptance is versioned localStorage
  `visidocsverse.eula.v1`). The Windows installers additionally gate the
  setup wizard itself via `bundle.licenseFile` — see `README-DESKTOP.md`.
  The preview never gates either.
- First launch in a desktop shell shows an Activate modal with two paths.
  ONLINE (new): the buyer pastes their Lemon Squeezy license key and hits
  "Activate online" — one internet check against
  `api.lemonsqueezy.com/v1/licenses/activate`. The activation is cached
  locally (`localStorage` `visidocsverse.lemon.v1`) with an HMAC-SHA256
  signature (see `src/licensing-manager.js`); fresh caches unlock with zero
  network for 30 days, expired ones re-validate in the background
  (`/v1/licenses/validate`) and keep working while offline (grace). Tampered
  caches fail closed (wiped). OFFLINE (original): the buyer pastes/loads the
  license key file delivered with their purchase; `src/license.js` verifies it
  LOCALLY with the embedded ECDSA P-256 public key — no network, no expiry
  ping. Either path passing unlocks; verified keys re-check every launch.
  The preview never gates (`LICENSE.enforceOnWeb` ships `false`).
- Update checker: a few seconds after startup, desktop shells make ONE
  anonymous GET of `https://visidocsverse.com/version.json` (no key, email,
  machine id, cookies, or headers — nothing is sent; offline/failure is
  silent). If `latestVersion` is strictly newer than `APP_VERSION`
  (`src/update-check.js`), a slim banner parks under the top pill with the
  release notes and a "Copy receipt search" button (copies
  `VisiDocsverse Lemon Squeezy receipt` — paste into email search to find
  the purchase email for the free patch re-download). Dismissal is stored
  per machine (`visidocsverse.update.v1`) for that version only. The web
  preview never checks. Release checklist: bump `APP_VERSION` +
  `tauri.conf.json` "version" together, then deploy the new `version.json`
  (schema: `{"latestVersion","releaseDate","releaseNotes":[]}`).
- Mint offline key files with `node src/tools/desktop/make-key.mjs gen`
  (once) + `sign` per sale. The private half lives ONLY on your machine
  (encrypted drive / password manager, never the repo, never a build).
  Rotate by swapping the public block and re-issuing files. Seat limit is
  honor-system for key files (nothing phones home); Lemon instances are
  tracked server-side per activation. Casual licensing, not DRM: never put
  secrets in the app; only the public key ships.
- `src/icon.png` (master) + `src/icon-512.png` (tab icon) are the packaged icons.
- Desktop shells: scaffold + build recipe in `src/tools/desktop/`
  (Tauri v2: `.dmg` arm64/x64, `.msi`/NSIS `.exe` x64). Installers must be
  compiled on a Mac / Windows machine — see `README-DESKTOP.md`.
- Client-side checks are bypassable by design — casual licensing, not DRM.
  Never put Gumroad access tokens in this code; only the public permalink +
  the customer-typed key are ever sent.

## Gotchas
- `caretRangeFromPoint`-style APIs don't apply; picking is manual screen-space.
- Synthetic pointer events work for tests (native caret rules don't apply here).
- window.__visidocsverse = {uni, ren, vault, activeId, ingestFiles, getDropFiles} debug handle.
- showDirectoryPicker used when available, else file picker fallback.

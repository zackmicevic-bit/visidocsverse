# VisiDocsVerse — living 3D document universe

Web adaptation of the Tauri spec: no Rust/React — vanilla JS + Canvas 2D with a
custom 3D projection renderer. Vault persists in `localStorage` (`visidocsverse.v1`).

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
- Focus: new sun GLIDES home (never teleports); old sun shoved off-center and
  blended to orbital velocity. Bounds after transitions: 50 < r < 1500.
- General state (no active body): off-click into empty space releases the sun
  (`Universe.defocus()` restores its vault mass); the canvas center itself pulls
  with sunMass so the lens holds together and orbits the origin. Orbital-velocity
  init and shell memory keep the formation instead of rescattering.

## Intake formats
- `.md/.markdown/.txt/.csv` plain text · `.pdf` (pdf.js) · `.docx` (mammoth) ·
  `.xlsx/.xls` (SheetJS, per-sheet CSV) · `.pptx` (slide text) · legacy
  `.doc/.ppt` rejected with a re-save message · exact-duplicate text skipped.
- Embedded pictures import too: `.docx`/`.pptx` media in document order,
  `.xlsx` sheet drawings (screenshots pasted into cells), `.pdf`
  image-bearing pages as printed page images (text-only pages stay
  text). Bytes live in the `visidocsverse-img` IndexedDB sidecar (never
  localStorage); docs carry only the manifest, rendered as a click-to-zoom
  gallery below the prose. Orphaned bytes are purged on every removal.
  Restored backups keep the manifest but show a placeholder for bytes.
- OCR: stored pictures are read by tesseract.js (English, lazy CDN worker) and
  high-confidence words join the doc in a marked "Pictures' text" section, so
  image text tags, tethers, searches — and every word counter (reader words,
  corpus totals, mass, largest-bodies) — like typed text. Bounded (8
  pictures/file, 30s each, confidence + length gates, tiny icons skipped);
  any failure skips OCR while text + pictures still import. Image-only files
  (scanned PDFs, picture-only Office docs) import on their OCR words alone;
  docs whose pictures predate OCR get one background backfill pass on load.
- Every import auto-focuses as the sun; failures toast the real reason (6s).
- Names are trimmed (`"report.docx "` works), extensionless-but-typed files are
  accepted by MIME, and skips are named in the toast (`"archive.zip" .zip …`).
- Folder button + drag-drop recurse into subfolders (File System Access when
  available, `webkitdirectory`/DataTransfer entries otherwise, 60-file cap).

## Labels
- Left panel Labels row: slider 0–150% for file-name size under bodies
  (far left = hidden), button toggles show/hide (restores last nonzero).
  Persisted in `visidocsverse.ui` as lbScale/lbLast, applied as ren.labelScale.

## Background shade
- Left panel Shade row (under Labels): slider 0–100% for canvas background
  brightness — far left = flat white, far right = black deep-space (as today);
  button flips between the two extremes. Label ink, selection rings and the
  starfield invert with the shade so text stays readable on white.
  Persisted in `visidocsverse.ui` as bgShade, applied as ren.bgShade, and included
  in cloud backups / master files (`settings.bgShade`).

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
- ▲ arrows at the top-right of the VisiDocsVerse column and the Active Body column
  shrink that column upward into a slim top tab (▼ restores it). Persisted in
  `visidocsverse.ui` and in cloud backups / master files.

## Tethers toggle (bottom pill)
- ◉ Tethers button in the bottom hint pill: shows/hides the tether lines
  between bodies — bodies themselves always stay put. It drives the same
  setting as the left-panel Tether row, so both stay in sync. (The hint pill
  hides on narrow phone screens, so this shortcut is desktop-wide only.)
- ◉ Distribute button next to Thematic: auto-distribute pins every body in a
  fit-to-canvas orb (sun at the center, other bodies on mass-ranked fibonacci
  shells, scaled to an ellipse matching the viewport) and freezes orbital
  motion — pan/zoom/orbit still work, but bodies hold still with zero drift.
  Toggling off re-seats every body settled (the same composed golden-angle
  seating fresh canvases open with) and restores orbital dynamics — a bare
  release would drop the zeroed-velocity orb down the gravity well into one
  pile. Persisted in
  `visidocsverse.ui`. While on, a ◈ VERSE MAP glass pane docks bottom-right: a live
  top-down map of every body (gold sun, blue rest, white ring on the
  active body, auto-fit framing, body count in the header) so the full verse
  stays visible while the main view is close. The markers mirror the main
  canvas body shape — dots normally, upside-down ▼ triangles while Orb to ▼
  is on — and the main canvas rotation: markers are plotted in the camera's
  own frame, so drag-rotating the view revolves the map with it (right on the
  map is right in the view). Header-drags to move,
  corner-drags to resize (both persist); the silver orb top-right switches
  the polished-glass finish on/off like every other pane; hidden again when
  Distribute goes off, hidden on phone widths.
- ○ Plain Body button after Distribute: renders every body as a flat white
  disc with a thin black outline — gradient shading, glow halos and
  photo-texture overlays are all skipped (labels, tethers, selection rings
  stay). Toggling off restores the textured orbs. Persisted in
  `visidocsverse.ui`.
- ○ Plain Body 2 button after Plain Body: keeps the original blue orbs
  (gradients + glow halos) but strips only the photo-texture overlays.
  Mutually exclusive with Plain Body — turning one on turns the other off.
  Toggling off restores the photo overlays. Persisted in `visidocsverse.ui`.
- ○ Orb to ▼ button after Plain Body 2: shape swap — every body renders as an
  upside-down triangle with the same fill (gold sun / blue gradient / flat
  white under Plain Body) and the same size as the orb it replaces (photo
  overlays clip to the triangle). Combines with any color mode. Persisted in
  `visidocsverse.ui`.
- ○/◉ Fit button first in the pill row: a TOGGLE that frames the bodies actually
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

## Thematic lens (bottom pill)
- ◉ Thematic button next to Tethers: the universe holds THEME BODIES ONLY —
  no doc bodies. Co-related concepts (terms that travel together across the
  shared-vocabulary web) are distilled into first-class theme bodies labeled
  with their concepts (e.g. "self-efficacy · alignment").
- Each theme's mass follows its thematic weight, so heavier themes pull harder
  and anchor their clusters under the same orbital mechanics and slider
  settings. Themes web together through shared grounded docs (every theme gets
  ≥1 tether — nothing drifts off); explicit [[ref]] tethers are left out so
  citation structure can't warp the map.
- Theme hygiene: a concept must evidence in ≥3 docs (≥2 on small canvases) to
  seed or join a theme, so one-off citation surnames never become labels; a
  term present in the full text of more than ~30% of the corpus ("teacher",
  "report", "canvas" …) is treated as boilerplate wallpaper and can neither
  seed nor join either. The lens opens pre-settled — clusters arrive webbed
  even when the universe is paused or at slow-motion.
- Clicking a theme shows its concepts + grounded member bodies; clicking a
  member drills down — the lens exits and the doc opens as sun in the regular
  view. Search in the lens lights up the themes grounding the hits. Toggling
  off restores the regular universe exactly as it was (formation included).
  The lens persists across canvas switches, in `visidocsverse.ui`, and in cloud
  backups / master files.
- "All thematic tags" in the general-state reader (beside View all bodies)
  opens every tag in the verse as its original pill on a near-transparent
  glass card — true frosted milk-white glass (milky gradient, 26px
  backdrop blur + saturate/brightness lift, hairline bright edge, etched
  grain, centered bold title, dark-outlined pills) + dark font on a white
  canvas, dark smoked glass + white font on a black canvas (maximum
  contrast either way); pills feed search as
  usual; click out or Esc closes; drag the header to move the card
  anywhere (double-click re-centers; position persists). Its "◈ Show tags verse" button enters the  TAGS VERSE — a separate lens built from the docs' own tags (explicit +
  auto/, prefix-blind), NOT from text concepts: one body per tag, webbed by
  shared member docs, tag mass = grounding-body count. Tag bodies drill down
  the same way (tag → grounded members → doc exits to regular view), with
  their own general/active reader, search light-up, and an "Exit tags verse"
  option; mutually exclusive with the Thematic lens; persists the same way.
  Entering from the pop-out closes it. Tag-specific seating tuning: only pairs
  sharing ≥2 docs web directly in big verses (loners re-home onto their single
  best partner instead of chaining to the anchor), weak short springs
  (0.005/80) so the dense tag mesh can't rope into a ball, rank-tier shells
  (heaviest tags innermost, one-doc tags across three roomy outer lanes), and
  a teleport-free glide into those tiers so the verse inherits calm orbital
  motion instead of a settle slingshot.
- Glossary of Terms: a centered full-width strip at the foot of the bottom
  pill (same frosted glass) opens a draggable, resizable minimap-style glass
  pane docked bottom-right — 23 A–Z in-app definitions (verse, sun, body,
  mass, backlinks, shared ground, center of gravity, system energy, rim,
  orbital mechanics, general/active view, thematic tag, both verses) plus a
  side-by-side comparison of the Thematic Tags Verse vs the general Thematic
  Verse. Geometry, visibility, and the glass dot persist like the verse map.
- General state: off-click into empty space releases the sun (◌ GENERAL STATE
  — CENTER GRAVITY) — no active body, the canvas center holds gravity, and the
  reader shows a live overview (counts + largest bodies as drill-down rows).
  Beside the LARGEST BODIES caption, a "View all bodies" option lists every
  remaining body underneath (amber ● dots, matching the option's own amber
  text, vs the white ◉ of the largest; toggles back to "Show fewer"; offered
  only past 6 bodies; every row's sub-caption carries words · mass ·
  backlinks; the pane has a wide easy-grab scrollbar for the long
  list). A new canvas always opens on its 6 largest. Clicking any body claims a new sun.
  Clicking a tag pill spotlights only its bodies (the rest fade) via the search
  box — the same empty-space click that releases the sun also clears that
  highlight, restoring the full non-faded view.
- Whole visidocsverse: pressing Thematic with nothing selected distills EVERY
  shared canvas at once (copies deduped by lineage; isolated verses stay out)
  into one theme map (◉ Thematic ⋃, kicker ◈ THEMATIC — WHOLE VISIDOCSVERSE).
  Member rows can ground bodies from other canvases — clicking one jumps to
  that canvas and opens the doc as sun.

## Canvases (top tabs)
- The dark pill at the top holds one tab per VisiDocsVerse canvas. Tabs are separate
  doc sets — switch to compartmentalize views, or copy bodies between canvases
  (right-click a body → Copy to …) to build related constellations elsewhere.
- Right-click a body for two delete scopes: Remove from this canvas (stays
  everywhere else) vs Delete from entire universe (purges every copy on every
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

## Sticky notes (140 chars per body)
- One sticky note per body, stored on the vault doc (persisted in localStorage,
  cloud backups and master files). Click its yellow square — drawn tight to the
  left of the label, sized to the label's font height, with ruled-line texture —
  to open a floating editor (140-char counter, Save / Delete / Cancel) without
  moving the sun. Bodies with notes show a solid square; the sun shows a dashed
  hollow placeholder so a first note can be created in-canvas. Right-clicking a
  body offers the same editor via a "Sticky note…" menu item.
- VisiDocsVerse pane: "View notes: All / Active body" checkboxes (both ticked by
  default, persisted in `visidocsverse.ui`). All shows solid yellow squares only on
  bodies that actually have notes — never placeholders. Active body always
  marks the selected body: solid when it has a note, hollow frame when not.
- Active-body reader: yellow `notes` button after the tag pills opens a pop-out
  with the note plus `copy` / `delete` captions (top-right), `edit` and `✕`.
  Empty pop-outs offer an inline add form. Every mutation re-renders both
  mirrors (square + pop-out); copy uses the clipboard with a fallback.
- Glass finish: the VisiDocsVerse, Active body and DEV panes share a crisp glass
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

## Verse associations (link canvases)
- The top bar is labeled Active VisiDocsVerse Projects; the first/starting tab is
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
  are. New canvases (+) join the association they were built from.
- Linked tabs wear the shared accent color in the top pill (blue tint,
  glowing when active); the moment a tab's last link is removed it drops to
  a dim dashed grey, and linking restores the shared color instantly.
- Every isolated verse owns a distinctive high-contrast identity color
  (assigned from a fixed palette, unused-first, kept when it links and
  unlinks again). While isolated the tab wears its color — solid border,
  tinted fill, matching glow; linking hands it the shared blue back.
- Tab order is user-arranged: each tab's menu has a Position section with
  "← Move left" / "Move right →" (end tabs offer only the one way that
  exists). Order persists, ships in backups, and never affects links.
- Closing the main verse promotes the oldest remaining tab to main; closing
  any verse drops its id from everyone else's link lists.
- Stored in `visidocsverse.tabsV1` as mutual `assoc` id lists (legacy
  `disassociated` flags migrate: shared rows join the legacy pool, isolated
  rows start alone; legacy `visidocsverse.v1` migrates into Universe 1 on first
  run); cloud backups / master files carry every canvas plus links.

## Reader pane
- Top of the pane is a SHARED GROUND hover menu (topic-tethered bodies +
  shared terms, up to 12); hover the label to open, tap it on touch, Esc or a
  selection closes it. Explicit [[links]] stay inline below as before.

## "?" explicators (editable in the editor, locked on desktop)
- All four helpers are editable: SHARED GROUND (? in the reader pane),
  mass (? in the doc meta line), system energy + rim (? in the left panel).
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
  land as "Name (2).md"). Dropping a downloaded
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

## Licensing (Option A — Gumroad verify + local persistence)
- First launch shows an Activate modal (logo, key field, Get-a-key link to
  `https://gumroad.com/l/ltsmdc`). One key = one device (seat limit 1).
- `src/license.js` verifies once via
  `POST https://api.gumroad.com/v2/licenses/verify`
  (`product_permalink=ltsmdc`, `increment_uses_count=true`) and caches the
  activation in `localStorage` (`visidocsverse.license.v1`) for 30 days offline.
  Silent re-checks use `increment_uses_count=false` (no seat consumed).
- Keys already showing >1 use are refused — reset uses in Gumroad (Customers
  → sale → reset uses) for reinstalls. CloudBox shows `Licensed: <email>`
  with a per-device deactivate (server-side uses still need a Gumroad reset).
- `LICENSE.enforceOnWeb` gates the web build too; set `false` to only gate
  desktop shells (Tauri / file://). `src/icon.png` (master) + `src/icon-512.png`
  (tab icon, also `$meta.icon`) are the packaged icons.
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

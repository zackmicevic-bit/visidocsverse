# VisiDocsVerse — standalone offline build

A living 3D document universe driven by orbital physics. Gravity equals relevance.
This folder is the clean, dependency-free export: **no CDNs, no web fonts, no
remote calls, no Perchance hooks.** Everything runs locally, offline.

## Layout

- `index.html` — main entry (links local CSS/JS only).
- `src/css/style.css` — complete dark-cosmic theme (`#0d0f12`, gold `#e2c99b`,
  multi-layered 3D box-shadow luxury skins).
- `src/js/app.js` — all app wiring + 3D document visualization/canvas code
  (entry module; imports `vault.js`, `physics.js`, `render.js`, stores,
  licensing, EULA and update-check beside it).
- `src/js/vendor/` — vendored parsers (PDF, Word, ZIP, spreadsheets, OCR +
  OCR data). No network fetch anywhere.
- `src/assets/` — icons (`logo.png`, `icon.png`, `icon-512.png`),
  backdrops, overlays + manifest, `samples/welcome.md` default dataset,
  local `version.json`.
- `tools/` — desktop packaging recipe (Tauri config, EULA, offline key tool,
  dev-strip script) + `dcp-scan.mjs` directory scanner for DCP Setup Maker.
- `package.json` / `settings.json` — versioning + DCP directory-scan config.

## Run it

Serve over local HTTP (ES modules and `fetch()` are blocked on raw
`file://` by browser CORS — unrelated to this app):

```sh
npx serve .
# or: python3 -m http.server 8080
```

Then open the printed localhost URL. All data stays on your machine
(localStorage + IndexedDB + File System Access intake).

## Offline notes

- Parsing (PDF/Word/Excel/ZIP/OCR) is 100% local via `src/js/vendor/`.
- Licensing: one-time online Lemon Squeezy activation when you have internet;
  afterwards fully offline (30-day grace revalidation, plus a fully-offline
  ECDSA key-file path in `src/js/license.js`).
- Update check reads only the local `src/assets/version.json` (same-origin,
  silent when absent). No external domain is ever contacted by this build.
- The Perchance cloud-backup / dev-builds pane was stripped from this export
  (same DEV-ONLY strip the desktop installer uses).

## DCP Setup Maker

Point it at this folder: entry `index.html`, scan dirs per `settings.json`
(`dcpSetupMaker.scanDirectories`), or run `node ./tools/dcp-scan.mjs` to
list the packaged file set.

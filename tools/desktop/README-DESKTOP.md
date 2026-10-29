# Visi|Docsverse desktop builds (Tauri v2) — .dmg (macOS) + .msi/.exe (Windows)

The installers themselves must be compiled on real hardware (or CI runners):
a Mac for `.dmg`, Windows for `.msi`/NSIS `.exe`. This folder is the recipe
and config — the web app in `src/` + `index.html` + `main.pjs` is the frontend.

Product: **Visi|Docsverse** · Gumroad permalink `ltsmdc` (`https://gumroad.com/l/ltsmdc`)
· 1 seat per key · icon source: `src/icon.png` (2024px master) / `src/icon-512.png`.

## 0. Prereqs

- Rust stable: https://rustup.rs
- Node 18+ with **pnpm**: `npm i -g pnpm`
- macOS: Xcode CLT (`xcode-select --install`). For universal arm64+x86_64 add
  the Intel target: `rustup target add x86_64-apple-darwin`
- Windows: WebView2 (preinstalled on Win10 1803+), Visual Studio Build Tools
  with the C++ workload.

## 1. Scaffold the shell (once, on your machine)

```sh
cd src/tools/desktop
pnpm install
# Rust plugins (re-run all of these on a fresh scaffold):
cargo add tauri-plugin-store
cargo add tauri-plugin-http
cargo add tauri-plugin-fs      # vault-folder mirror (originals on disk)
cargo add tauri-plugin-dialog  # vault-folder picker
cargo add tauri-plugin-opener  # reveal-in-Finder/Explorer + open folder
# JS bindings (already in package.json, but harmless to re-run):
pnpm add @tauri-apps/plugin-store @tauri-apps/plugin-http
```

## 2. Icons (once)

```sh
cd src/tools/desktop
pnpm dlx tauri icon ../../src/icon.png   # writes src-tauri/icons/{.icns,.ico,.png}
```

(`tauri.conf.json` already points at those paths. Apple shows transparency as
black on Home Screen — the logo has a solid dark background, so it is fine.)

## 3. Export the frontend into `dist/`

Save/publish the generator, then copy the shipped files:

```sh
cd src/tools/desktop
rm -rf dist && mkdir dist
cp ../../index.html dist/
cp ../../main.pjs dist/      # harmless; the shell boots index.html
cp -r ../../src dist/src
node strip-dev.mjs            # REQUIRED: removes the DEV pane (cloud backup +
                              # dev-build links) so installers ship without it
```

(`index.html` is the `<body>` fragment Perchance wraps — for the desktop shell
serve it as-is; the app boots `src/app.js` as a module. No secrets are
embedded and nothing phones home: licensing is a local key-file check,
intake libraries are vendored in `src/vendor/`, storage is device-local.)

`strip-dev.mjs` deletes every `DEV-ONLY` range from `dist/index.html` and
`dist/src/app.js` (the whole DEV pane plus cloud push, the DEV-pane
master-file buttons, drag-to-load and their console fallbacks) and drops the
dev handles from the `__visidocsverse` console object. It fails loudly on
missing or unbalanced markers, so a half-stripped build can never ship
silently. The desktop-safe Load… / Merge… rows in "Open Project"
("From a computer file") survive the strip — they only call bundled helpers
(`readBackupFile`, `applyBackupObject`, `mergeBackupObject`, …). The desktop
app keeps the user-facing paths: in-app autosave, "Open Project", and
the per-tab "save project" downloads (`buildBackupObject` stays bundled).
`upload-plugin` is then unused on desktop — `main.pjs` still imports it,
harmlessly.

## DEV pane (never in installers)
- One merged bottom-left pane titled ◇ DEV: cloud-backup items on top
  (status, Push backup, Master file download, Load…, Merge…), a divider,
  then the DEV BUILDS installer links + note + edit-links below.
- Always visible on web (`hide` puts it away on that machine). Installers
  strip the whole pane; its Load…/Merge… rows are duplicated desktop-safe in
  "Open Project" ("From a computer file"), which is what ships.
- Desktop exports strip it entirely — see `strip-dev.mjs` above.

## 4. Build

```sh
cd src/tools/desktop
# macOS Apple Silicon .dmg:
pnpm tauri build --target aarch64-apple-darwin --bundles dmg
# macOS Intel .dmg (on the same Mac):
pnpm tauri build --target x86_64-apple-darwin --bundles dmg
# Universal .dmg (lipo-merge the two app bundles, then hdiutil — or ship both):
# Windows (on Windows) NSIS .exe + .msi:
pnpm tauri build --target x86_64-pc-windows-msvc --bundles nsis,msi
```

Artifacts land in `src-tauri/target/<triple>/release/bundle/{dmg,nsis,msi}/`.

## 5. Signing (required for clean installs)

- macOS: sign + notarize or Gatekeeper will block it —
  `APPLE_SIGNING_IDENTITY`, then `xcrun notarytool submit … --wait`.
- Windows: sign the `.exe`/`.msi` with an EV/code-signing cert or SmartScreen
  will warn.

## 6. Installer smoke test (on the built installer, before signing)

1. `pnpm tauri dev` (or the built app): left panel shows the Open Project
   button under the Folder/Files row (the vault-folder disk mirror is removed —
   originals live in the in-app store and download from the body menu).
2. Open Project → menu shows "From a computer file" (Load/Merge) + the
   recently-closed shelf; both pickers work.
3. Drop in a `.md` + a `.pdf`: both bodies appear; the body menu offers
   "Download original" byte-identical (diff them).
4. If anything reports denied/unknown: compare
   `src-tauri/capabilities/default.json` identifiers against the installed
   plugins (`cargo add` pulls current v2 names; correct and rebuild). (The
   fs/dialog/opener permissions once used by the vault folder are now unused
   by the frontend but harmless — leave them unless you're auditing perms.)
5. Windows installers: the setup wizard shows the EULA license page (from
   `bundle.licenseFile` → `../EULA.txt`) with an I-Agree / accept control —
   Next stays blocked until the user accepts (NSIS), or the LicenseAgreement
   radio must be set to accept (MSI). Declining aborts the install.
   Cancel/decline on purpose once to confirm nothing installs.
6. First launch of the installed app (any OS, incl. macOS where the .dmg
   cannot show a wizard page): a blocking End User License Agreement modal
   appears with the same text — the I Accept button stays disabled until
   the "I have read and accept" box is ticked. Acceptance is stored per
   machine profile (`visidocsverse.eula.v1`, versioned: bumping
   `EULA_VERSION` in `src/eula.js` re-prompts).

## 7. Licensing notes (`src/license.js` + `src/licensing-manager.js`)

- First launch in a desktop shell shows the Activate modal with two paths.
  ONLINE: the buyer pastes their Lemon Squeezy license key and activates
  (one internet check against `api.lemonsqueezy.com/v1/licenses/activate`).
  The activation caches locally in `localStorage`
  (`visidocsverse.lemon.v1`) with an HMAC-SHA256 tamper seal: fresh caches
  unlock offline for 30 days, expired ones re-validate in the background
  (`/v1/licenses/validate`) and keep working while offline (grace);
  hand-edited caches fail closed. Needs internet only for the activation
  call itself (plain `fetch`; inside Tauri it falls back to the http plugin's
  fetch, which is not bound by WebView CORS). OFFLINE: the buyer pastes (or
  loads) their license key FILE — verified LOCALLY with the embedded
  ECDSA P-256 public key, no network ever. Either path passing unlocks.
- Mint offline key files with `node src/tools/desktop/make-key.mjs gen`
  (once — keep the private half OFF the repo, encrypted drive / password
  manager) and `node make-key.mjs sign <private.json> <buyer@email>
  [issued]`. To rotate: generate a new pair, swap the public block,
  re-issue files. Lemon Squeezy products/keys are managed in the Lemon
  dashboard (no tooling needed here); instance counts are tracked there.
- Seat limit for key files is honor-system: a key file says who it belongs
  to, but nothing phones home, so one file *can* be shared —
  price/support accordingly.
- `LICENSE.enforceOnWeb` in `src/license.js` gates the web preview too;
  ship it `false` so only desktop shells gate.
- Client-side checks are bypassable — treat as casual licensing, not DRM.
  Never put secrets in the app: only the public key ships.

## 8. EULA acceptance (installer wizard + first-run gate)

- Canonical text: `src/tools/desktop/EULA.txt`. It is what the user signs:
  keep its substance identical everywhere it appears.
- Windows installers read it via `bundle.licenseFile` in
  `src-tauri/tauri.conf.json` (path is relative to `src-tauri/`). Verified
  against the stock Tauri v2.11 bundler templates: a non-empty
  `bundle.licenseFile` renders an NSIS `MUI_PAGE_LICENSE` page (I Agree
  required to continue) in the `.exe`, and sets `WixUILicenseRtf` so the
  `.msi` keeps its LicenseAgreement dialog (accept-radio required) instead
  of skipping it. Plain `.txt` is intentional: NSIS consumes it as-is
  (bundler prepends a UTF-8 BOM) and the MSI bundler auto-wraps non-`.rtf`
  text into RTF. Declining aborts the install without copying files.
- macOS `.dmg` has no wizard-page support in stock Tauri, so the gate lives
  in the app instead: `src/eula.js` embeds the SAME text (copy it verbatim
  from `EULA.txt` when the legal text changes) and `boot()` blocks on
  `ensureEulaAccepted()` before the license gate on every desktop shell
  (Tauri/file:///app-protocol). The web preview never gates. Acceptance is
  `localStorage` `visidocsverse.eula.v1` = `{v: EULA_VERSION, at}` —
  bumping `EULA_VERSION` re-prompts all installs.
- The EULA modal (`#eulaModal` in `index.html`) is desktop-safe by design:
  it sits outside every `DEV-ONLY` range and uses no stripped identifiers,
  so `strip-dev.mjs` carries it into `dist/` untouched.

## 9. In-app update checker (`src/update-check.js` + `#updateBanner`)

- A few seconds after startup, desktop shells (Tauri/file/tauri.localhost —
  never the web preview) make ONE anonymous GET of
  `https://visidocsverse.com/version.json` (plain no-preflight GET, no
  cookies, no headers, no identifiers; 5s timeout; Tauri http-plugin
  fallback like the Lemon path). Offline/DNS/non-200/bad-JSON/timeout all
  fail silently — no toast, no banner, no console error.
- If `latestVersion` is strictly newer than `APP_VERSION`, a slim glass
  banner parks under the top pill (top edge follows the pill's live bottom)
  with the version, release date, and up to 6 release notes, plus a "Copy
  receipt search" button (copies `VisiDocsverse Lemon Squeezy receipt` —
  paste into the mail-app search to find the Lemon Squeezy receipt email
  for the free patch re-download) and Later/✕ dismiss. Dismissal is stored
  per machine (`visidocsverse.update.v1`) for that version only — the next
  newer version nags again.
- Like the EULA modal, the banner sits outside every `DEV-ONLY` range and
  uses no stripped identifiers, so installers keep it.
- Release checklist (all three, every release): bump `APP_VERSION` in
  `src/update-check.js`, bump `"version"` in
  `src-tauri/tauri.conf.json` to match, and deploy the new `version.json`
  to the site root with schema
  `{"latestVersion":"1.0.1","releaseDate":"2026-10-25","releaseNotes":["..."]}`.
- Smoke test on the built installer: with no network (or with
  `version.json` unreachable), launch is clean and silent; with a stubbed
  newer version the banner shows notes + copy works (in dev, drive it via
  the `update.check()` debug handle with a stubbed `fetch`).
- Step 3 bridge (Electron-spec compatible, no Electron files): `initUpdateChecker()`
  also exposes `window.electronAPI.checkForUpdates()` — same name and
  promise<string> shape as the Electron preload snippet — backed by the
  frontend checker. No `src/preload/preload.ts` / `ipcMain.handle` exists
  here on purpose: this project has no Electron main process, and the
  Tauri WebView needs no IPC for a plain HTTPS GET.

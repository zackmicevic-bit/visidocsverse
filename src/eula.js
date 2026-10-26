// eula.js — End User License Agreement: text + first-run acceptance gate.
//
// The canonical text lives in src/tools/desktop/EULA.txt (the file the
// Windows installers show in the setup wizard). This module embeds the SAME
// text so desktop shells can also gate first launch on it — macOS .dmg
// installers cannot show a wizard license page, so the in-app gate is the
// enforcement there. Do NOT hand-edit EULA_TEXT below: copy it verbatim
// from src/tools/desktop/EULA.txt instead (that file is what the Windows
// installers show).
//
// Desktop-only: the web preview never gates (needsEulaGate mirrors the
// shell detection in license.js). Acceptance is versioned localStorage
// (`visidocsverse.eula.v1`); bumping EULA_VERSION re-prompts.
export const EULA_VERSION = 1;
export const EULA_TEXT = `END USER LICENSE AGREEMENT (EULA)

PLEASE READ THIS END USER LICENSE AGREEMENT ("AGREEMENT") CAREFULLY BEFORE DOWNLOADING, INSTALLING, OR USING VISI|DOCSVERSE ("SOFTWARE").

BY DOWNLOADING, INSTALLING, ACTIVATING, OR USING THE SOFTWARE, YOU AGREE TO BE BOUND BY THE TERMS OF THIS AGREEMENT. IF YOU DO NOT AGREE TO THESE TERMS, DO NOT DOWNLOAD, INSTALL, OR USE THE SOFTWARE.

---

1. GRANT OF PERPETUAL LICENSE

Subject to the terms of this Agreement and your purchase of a valid license key through an authorized distributor (e.g., Lemon Squeezy), the developer grants you a non-exclusive, non-transferable, limited, perpetual license to install and use the current version of Visi|Docsverse on up to the maximum number of devices permitted by your license tier for personal or professional purposes. "Perpetual" means your right to use the acquired version of the Software does not expire.

2. LOCAL-FIRST DATA & PRIVACY

Local Processing: Visi|Docsverse is a local-first application. All visualization, analysis, indexing, and document processing occur entirely on your local hardware.
No Cloud Hosting: The developer does not host, collect, store, or transmit your private documents, research files, or visualization maps to any remote servers.
Data Backups: You acknowledge and agree that you are solely responsible for maintaining adequate local backups of your files, document databases, and application data.

3. RESTRICTIONS

You agree not to, and you will not permit others to:

- Reverse engineer, decompile, disassemble, or attempt to derive the source code of the Software (except to the extent permitted by applicable law).
- Rent, lease, sublicense, distribute, sell, or commercially exploit the Software or your license key to any third party.
- Modify, bypass, or defeat any cryptographic license verification or local security mechanisms implemented in the Software.

4. OWNERSHIP & INTELLECTUAL PROPERTY

The Software, including all code, interface designs, visual lenses, graphics, and documentation, is protected by copyright and intellectual property laws. The developer retains all right, title, and interest in and to the Software. This Agreement grants you a license to use the Software, not a transfer of ownership.

5. EXCLUSION OF SOFTWARE UPDATES & UPGRADES

- Version-Locked Purchase: Your purchase grants you a perpetual license strictly for the version of the Software downloaded at the time of purchase (or minor bug fixes directly tied to that version).
- No Updates Included: This Agreement and purchase do not include future software updates, major version upgrades, new feature releases, or technical support.
- Future Releases: Any subsequent versions, major feature updates, or standalone releases of Visi|Docsverse may be offered separately and will require an additional purchase or upgrade fee at the developer's sole discretion.

6. DISCLAIMER OF WARRANTY

THE SOFTWARE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. THE DEVELOPER DOES NOT WARRANT THAT THE SOFTWARE WILL BE UNINTERRUPTED, ERROR-FREE, OR FREE OF BUGS.

7. LIMITATION OF LIABILITY

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL THE DEVELOPER BE LIABLE FOR ANY INDIRECT, INCIDENTAL, CONSEQUENTIAL, SPECIAL, OR PUNITIVE DAMAGES WHATSOEVER (INCLUDING, WITHOUT LIMITATION, DAMAGES FOR LOSS OF BUSINESS PROFITS, DATA LOSS, OR BUSINESS INTERRUPTION) ARISING OUT OF THE USE OR INABILITY TO USE THE SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

8. TERMINATION

This Agreement is effective until terminated. Your rights under this Agreement will terminate automatically without notice if you fail to comply with any of its terms or if your license purchase is refunded or revoked. Upon termination, you must cease all use of the Software and uninstall all copies from your devices.

9. GOVERNING LAW

This Agreement shall be governed by and construed in accordance with applicable governing laws, without regard to its conflict of law principles.
`;

const EULA_KEY = 'visidocsverse.eula.v1';

// True only inside a real install (desktop shell). The web preview always
// returns false, so this gate can never fire there.
export function needsEulaGate() {
  try {
    if (window.__TAURI__ || window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__) return true;
    const p = location.protocol;
    if (p === 'file:' || p === 'tauri:' || p === 'wry:' || p === 'app:') return true;
    if (/tauri\.localhost$/i.test(location.hostname)) return true;
  } catch {}
  return false;
}

export function eulaAccepted() {
  try {
    const o = JSON.parse(localStorage.getItem(EULA_KEY) || 'null');
    return !!(o && o.v === EULA_VERSION && o.at);
  } catch { return false; }
}

export function recordEulaAcceptance() {
  try { localStorage.setItem(EULA_KEY, JSON.stringify({ v: EULA_VERSION, at: new Date().toISOString() })); } catch {}
}

// Resolve true once this machine's user has accepted the EULA. Shows the
// blocking acceptance modal (no dismiss) when gating and not yet accepted.
export async function ensureEulaAccepted() {
  if (!needsEulaGate()) return true;
  if (eulaAccepted()) return true;
  return showEulaModal();
}

export function showEulaModal() {
  return new Promise((resolve) => {
    const m = document.getElementById('eulaModal');
    const body = document.getElementById('eulaText');
    const box = document.getElementById('eulaCheckBox');
    const ok = document.getElementById('eulaOk');
    if (!m || !body || !box || !ok) { resolve(false); return; }
    body.textContent = EULA_TEXT;
    body.scrollTop = 0;
    box.checked = false;
    ok.disabled = true;
    const sync = () => { ok.disabled = !box.checked; };
    box.onchange = sync;
    ok.onclick = () => {
      if (!box.checked) return;
      recordEulaAcceptance();
      m.hidden = true;
      resolve(true);
    };
    m.hidden = false;
  });
}

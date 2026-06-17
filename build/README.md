# Building the Orbit MSI (self-signed)

Produces a signed `dist\Orbit-<version>.msi` that installs Orbit to
`C:\Program Files\Orbit` with Start-Menu shortcuts. **Run on Windows** (PyInstaller,
WiX and signtool are Windows tools).

## Prerequisites

| Tool | Install |
|------|---------|
| Python 3.10+ | https://python.org (tick "Add to PATH") |
| .NET SDK | https://dotnet.microsoft.com/download (needed for the WiX tool below) |
| WiX 5 | `dotnet tool install --global wix --version 5.0.2` — pin v5 (v6/v7 require enrolling in the paid Open Source Maintenance Fee EULA; v5 is the last freely-usable release and uses the same schema) |
| signtool | *optional* — only if you have the Windows SDK; otherwise the script signs with PowerShell's built-in `Set-AuthenticodeSignature` (no SDK needed) |

PyInstaller is installed automatically by the build script.

## Build

```powershell
# from the repo root
pwsh -ExecutionPolicy Bypass -File build\build.ps1                 # -> dist\Orbit-0.1.0.msi
pwsh -File build\build.ps1 -Version 0.2.0                          # custom version
pwsh -File build\build.ps1 -TrustCert                              # also trust the cert on THIS machine (elevated)
```

What it does: freezes `agent\orbit_agent.py` (+ `web\`, deps) into `dist\orbit\` with
PyInstaller → creates/reuses a self-signed code-signing cert in your user store →
signs `orbit.exe` → adds the WiX UI + Util extensions → builds the MSI (a real install
wizard) with WiX → signs the MSI. (The built-in `powershell` works too — the script
targets Windows PowerShell 5.1+.)

## Installing (the wizard)

Double-click the MSI (or `msiexec /i dist\Orbit-0.1.0.msi`). Steps:
Welcome → **License** (MIT) → **choose install folder** (default `C:\Program Files\Orbit`)
→ confirm → install → **Finish**. The Finish screen explains Npcap is needed only for
live capture and offers a checkbox (ticked by default) that opens the Npcap download
page in your browser when you click Finish.

Per-machine install to Program Files + two Start-Menu shortcuts: **Orbit** (live capture)
and **Orbit (Demo)** (synthetic traffic, no admin/Npcap).

The agent runs **hidden** — its UI is a chromeless browser window, so there's no console
to manage. **Closing that window quits Orbit** (the backend exits a few seconds later);
if the backend stops, the window closes itself. Diagnostics go to
`%LOCALAPPDATA%\Orbit\orbit.log`. Need the old console output? Run `orbit.exe` (or
`orbit.exe --list-ifaces`, `--verbose`) **from a terminal** and it reattaches to it.

> **Upgrades & reinstalls are automatic.** Installing any build — newer *or the same
> version* — cleanly removes the previous one first, so you never get duplicate
> entries. Close Orbit before reinstalling (or Windows will ask you to if its files
> are in use). Installing an *older* version over a newer one is refused (uninstall
> first if you really need to). The installer also requires 64-bit Windows and stops
> with a clear message otherwise.

## Uninstall (clean)

Settings → Apps → Orbit → Uninstall (or `msiexec /x dist\Orbit-0.1.0.msi`). Removes the
program files, both shortcuts, and the runtime GeoIP cache in `%LOCALAPPDATA%\Orbit`.

## Self-signed: what to expect

A self-signed certificate is **not trusted by other machines**. Until the cert is
trusted on a given machine, Windows shows **"Unknown publisher"** (and SmartScreen
may warn) at install. Options:

- **Your own machine** — run `build.ps1 -TrustCert` (elevated): imports the cert into
  *LocalMachine\Root* and *TrustedPublisher*, after which the MSI installs cleanly.
- **Another machine** — export the cert (`Cert:\CurrentUser\My`) as a `.cer` and import
  it into that machine's *Trusted Root Certification Authorities* + *Trusted Publishers*
  (Group Policy for fleets), **or** accept the publisher prompt.
- **Public distribution** — a self-signed cert is not appropriate; use a real
  code-signing / EV certificate from a CA. The build is otherwise identical (point the
  script at that cert's thumbprint).

The signature is RFC3161-timestamped, so it stays valid after the cert expires.

## Npcap (live capture)

Npcap is **not** bundled — its free license forbids redistribution and it is a kernel
driver. The MSI installs the app only:

- **Demo / Replay** need neither Npcap nor admin → the *Orbit (Demo)* shortcut works
  immediately.
- **Live capture** needs Npcap + administrator. If `npcap.sys` is missing the agent
  prints the install URL (https://npcap.com — enable "WinPcap API-compatible mode";
  uncheck "Restrict to Administrators" to capture without elevation). Right-click the
  *Orbit* shortcut → *Run as administrator* for live capture.

## Notes

- GeoIP/ASN is downloaded once on first run into `%LOCALAPPDATA%\Orbit\.geoip`
  (writable; the install dir is read-only). Offline → enrichment simply stays off.
- `build\orbit.ico` brands the exe, Start-Menu shortcuts and the Add/Remove Programs
  entry. It's generated from the in-app mark by `python build\make_icon.py` (Pillow);
  re-run that after tweaking, or drop in your own `orbit.ico` to override.
- Bump the version via `-Version`; the `UpgradeCode` GUID in `Orbit.wxs` is fixed so
  upgrades replace the prior install.

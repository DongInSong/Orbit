# Building the Orbit MSI (self-signed)

Produces a signed `dist\Orbit-<version>.msi` that installs Orbit to
`C:\Program Files\Orbit` with Start-Menu shortcuts. **Run on Windows** (PyInstaller,
WiX and signtool are Windows tools).

## Prerequisites

| Tool | Install |
|------|---------|
| Python 3.10+ | https://python.org (tick "Add to PATH") |
| .NET SDK | https://dotnet.microsoft.com/download (needed for the WiX tool below) |
| WiX v4+ | `dotnet tool install --global wix` |
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
signs `orbit.exe` → builds the MSI with WiX → signs the MSI.

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
- `build\orbit.ico` is optional; drop one in to brand the exe/shortcuts.
- Bump the version via `-Version`; the `UpgradeCode` GUID in `Orbit.wxs` is fixed so
  upgrades replace the prior install.

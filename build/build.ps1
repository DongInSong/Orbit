#requires -Version 5.1
<#
  Orbit MSI build + self-sign.  Run on Windows from the repo root:

      pwsh -ExecutionPolicy Bypass -File build\build.ps1
      pwsh -File build\build.ps1 -Version 0.2.0 -TrustCert

  Prerequisites (checked below, with a hint if missing):
    - Python 3.10+ on PATH
    - WiX v4+    :  dotnet tool install --global wix
    - signtool   :  Windows 10/11 SDK (usually already installed)

  A self-signed cert is NOT trusted by other machines — SmartScreen / "Unknown
  publisher" will still warn unless the cert is imported into the target
  machine's Trusted Root + Trusted Publishers stores. -TrustCert does that for
  THIS machine (requires an elevated shell).
#>
[CmdletBinding()]
param(
  [string]$Version      = "0.1.0",
  [string]$CertSubject  = "CN=Orbit Self-Signed",
  [string]$TimestampUrl = "http://timestamp.digicert.com",
  [switch]$TrustCert
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot      # repo root (this script lives in build\)
Set-Location $root
Write-Host "== Orbit MSI build  (version $Version) ==" -ForegroundColor Cyan

function Run {
  param([string]$Exe, [Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
  & $Exe @Args
  if ($LASTEXITCODE -ne 0) { throw "$Exe $($Args -join ' ')  ->  exit $LASTEXITCODE" }
}
function Need($name, $cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$name not found ($cmd). $hint" }
}

# ---- preflight ----------------------------------------------------------
Need "Python" "python" "Install from https://python.org and put it on PATH."

# WiX: prefer PATH, else the default global-tools location — PATH is often not
# refreshed in the shell right after `dotnet tool install --global wix`
$wix = (Get-Command wix -ErrorAction SilentlyContinue).Source
if (-not $wix) {
  $cand = Join-Path $env:USERPROFILE ".dotnet\tools\wix.exe"
  if (Test-Path $cand) { $wix = $cand }
}
if (-not $wix) { throw "WiX not found. Install with: dotnet tool install --global wix" }
Write-Host "  wix: $wix"
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if ($signtool) { Write-Host "  signtool: $signtool" }
else { Write-Host "  signtool: not found -> using PowerShell's built-in Set-AuthenticodeSignature" -ForegroundColor DarkYellow }

# sign a file with signtool if present, else the built-in cmdlet (no SDK needed)
function Sign-File($path) {
  if ($signtool) {
    & $signtool sign /sha1 $script:cert.Thumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $path
    if ($LASTEXITCODE -ne 0) { throw "signtool failed on $path" }
  } else {
    $sig = Set-AuthenticodeSignature -FilePath $path -Certificate $script:cert -HashAlgorithm SHA256 -TimestampServer $TimestampUrl
    # a self-signed (untrusted) cert reports UnknownError — the file is still
    # signed AS LONG AS a signer cert got embedded.
    if ($sig.Status -notin 'Valid', 'UnknownError') { throw "signing failed on $path : $($sig.Status) - $($sig.StatusMessage)" }
    # But Windows PowerShell's Set-AuthenticodeSignature cannot sign .msi at all:
    # it embeds nothing yet still returns the *input* cert in .SignerCertificate,
    # so re-read the FILE (not $sig) to tell whether a signature actually landed.
    # Warn loudly instead of silently shipping an unsigned MSI — real MSI signing
    # needs signtool (the Windows SDK).
    if ($null -eq (Get-AuthenticodeSignature $path).SignerCertificate) {
      Write-Host "  WARN: $path is UNSIGNED — Set-AuthenticodeSignature can't sign this file type (MSI needs signtool / the Windows SDK). It will install but show 'Unknown publisher'." -ForegroundColor Red
    }
  }
}

# ---- 1. python deps + PyInstaller --------------------------------------
Write-Host "`n[1/5] Installing build deps..." -ForegroundColor Yellow
Run python -m pip install --upgrade pip
Run python -m pip install -r agent\requirements.txt pyinstaller

# ---- 2. freeze the agent -----------------------------------------------
Write-Host "`n[2/5] Freezing agent with PyInstaller..." -ForegroundColor Yellow
Remove-Item dist\orbit, build\_work -Recurse -Force -ErrorAction SilentlyContinue
Run python -m PyInstaller build\orbit.spec --noconfirm --distpath dist --workpath build\_work
if (-not (Test-Path dist\orbit\orbit.exe)) { throw "PyInstaller did not produce dist\orbit\orbit.exe" }

# ---- 3. self-signed code-signing cert ----------------------------------
Write-Host "`n[3/5] Locating / creating self-signed cert..." -ForegroundColor Yellow
$cert = Get-ChildItem Cert:\CurrentUser\My |
        Where-Object { $_.Subject -eq $CertSubject -and $_.NotAfter -gt (Get-Date) } |
        Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $CertSubject `
            -CertStoreLocation Cert:\CurrentUser\My -KeyUsage DigitalSignature `
            -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(3)
  Write-Host "  created cert $($cert.Thumbprint)"
} else {
  Write-Host "  reusing cert $($cert.Thumbprint)"
}

# ---- 4. sign exe, build + sign MSI -------------------------------------
Write-Host "`n[4/5] Signing orbit.exe..." -ForegroundColor Yellow
Sign-File dist\orbit\orbit.exe

Write-Host "`n[5/5] Building + signing the MSI..." -ForegroundColor Yellow
# WiX writes the .msi through the Windows Installer service (msiserver), which
# ships Manual/Stopped; WiX's implicit auto-start can fail with MSI 1631
# ("service failed to start"), so nudge it up first. Needs admin (the build is
# typically run elevated anyway).
try {
  if ((Get-Service msiserver -ErrorAction Stop).Status -ne 'Running') {
    Start-Service msiserver
    Write-Host "  started Windows Installer service (msiserver)"
  }
} catch { Write-Host "  WARN: could not start msiserver ($($_.Exception.Message)) — wix may fail with 1631" -ForegroundColor DarkYellow }
$msi = "dist\Orbit-$Version.msi"
# absolute SourceDir: the <Files Include> harvest glob is resolved relative to
# the .wxs file (build\), NOT the working dir, so a relative path matches nothing.
# Use .ProviderPath (native FS path), not .Path — on a UNC working dir (e.g.
# building the WSL repo from Windows via \\wsl.localhost\...) .Path returns a
# provider-qualified "Microsoft.PowerShell.Core\FileSystem::\\..." string that
# WiX treats as relative, mangling the harvest path.
$src = (Resolve-Path dist\orbit).ProviderPath
$lic = (Resolve-Path build\license.rtf).ProviderPath
# the wizard + clean-uninstall need the UI and Util extensions, pinned to the
# wix tool version (a newer extension won't load into wix 5.0.2)
& $wix extension add -g WixToolset.UI.wixext/5.0.2
& $wix extension add -g WixToolset.Util.wixext/5.0.2
# call wix directly (not via Run): Run is an advanced function, so PowerShell
# would try to bind wix's -d/-o as the function's own common parameters
# MsiOpenDatabase (the Windows Installer DB API WiX binds the .msi through)
# CANNOT create the database on a UNC path — emitting straight to
# \\wsl.localhost\...\dist fails with MSI 1631. So when SourceDir is UNC
# (building the WSL repo from Windows), build to a local temp file, sign it
# there, then copy the finished MSI back. A normal drive-letter checkout is
# unaffected ($outMsi == $msi, no copy).
$outMsi = if ($src -like '\\*') { Join-Path $env:TEMP "Orbit-$Version.msi" } else { $msi }
Remove-Item $outMsi -ErrorAction SilentlyContinue
& $wix build build\Orbit.wxs -arch x64 -ext WixToolset.UI.wixext -ext WixToolset.Util.wixext -d Version=$Version -d SourceDir=$src -d LicenseRtf=$lic -o $outMsi
if ($LASTEXITCODE -ne 0) { throw "wix build failed (exit $LASTEXITCODE)" }
if ((Get-Item $outMsi).Length -lt 1MB) {
  throw "MSI is only $((Get-Item $outMsi).Length) bytes — the file harvest matched nothing. Check SourceDir / Orbit.wxs <Files Include>."
}
Sign-File $outMsi
if ($outMsi -ne $msi) { Copy-Item $outMsi $msi -Force; Remove-Item $outMsi -ErrorAction SilentlyContinue }

# ---- optional: trust the cert on THIS machine --------------------------
if ($TrustCert) {
  Write-Host "`nTrusting the self-signed cert (LocalMachine Root + TrustedPublisher)..." -ForegroundColor Yellow
  foreach ($storeName in "Root", "TrustedPublisher") {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, "LocalMachine")
    $store.Open("ReadWrite"); $store.Add($cert); $store.Close()
  }
  if ($signtool) { & $signtool verify /pa /v $msi } else { (Get-AuthenticodeSignature $msi) | Format-List Status, SignerCertificate }
  Write-Host "  cert trusted — Orbit installs without a publisher warning on this machine." -ForegroundColor Green
} else {
  Write-Host "`n  NOTE: signed with a self-signed cert. Other machines will still show" -ForegroundColor DarkYellow
  Write-Host "  'Unknown publisher' until the cert is trusted there. Re-run with -TrustCert" -ForegroundColor DarkYellow
  Write-Host "  (elevated) on the target machine, or import the cert manually." -ForegroundColor DarkYellow
}

Write-Host "`nDone -> $msi" -ForegroundColor Green

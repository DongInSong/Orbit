@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (set PY=py) else (set PY=python)

%PY% --version >nul 2>nul
if errorlevel 1 (
  echo [Orbit] Python 3.10+ is required. Install from https://python.org
  pause & exit /b 1
)

REM ---- install deps as the CURRENT user, BEFORE any self-elevation, so a
REM      compromised/typosquatted package cannot run its setup as administrator ----
%PY% -c "import aiohttp, scapy, maxminddb" >nul 2>nul
if errorlevel 1 (
  echo [Orbit] Installing dependencies...
  %PY% -m pip install -r agent\requirements.txt
)

REM ---- demo / replay: synthetic or recorded data, no capture / Npcap / admin ----
set DEMO=0
for %%A in (%*) do if /i "%%A"=="--demo" set DEMO=1
for %%A in (%*) do if /i "%%A"=="--replay" set DEMO=1
for %%A in (%*) do if /i "%%A"=="--list-ifaces" set DEMO=1
if "%DEMO%"=="1" goto run

REM ---- live mode requires the Npcap driver ----
if not exist "%SystemRoot%\System32\drivers\npcap.sys" (
  echo.
  echo  [Orbit] Npcap is not installed -- it is required for live capture.
  echo.
  echo    1^) Install it from https://npcap.com
  echo         - check  "WinPcap API-compatible mode"
  echo         - to run WITHOUT admin every time, UNcheck
  echo           "Restrict Npcap driver's access to Administrators only"
  echo    2^) Run run.bat again
  echo.
  echo    To preview the interface right now without capture:
  echo         run.bat --demo
  echo.
  pause & exit /b 1
)

REM ---- self-elevate so the capture driver has permission ----
net session >nul 2>nul
if errorlevel 1 (
  echo [Orbit] Requesting administrator rights for packet capture...
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
  exit /b
)

:run
%PY% agent\orbit_agent.py %*
pause

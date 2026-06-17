# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Orbit — produces a one-folder build (dist/orbit/) that
WiX packages into the MSI. Build from the repo root:

    pyinstaller build/orbit.spec --noconfirm --distpath dist --workpath build/_work

scapy resolves protocol layers dynamically, so its submodules are collected
explicitly; the frontend (web/) is bundled as data and resolved at runtime via
sys._MEIPASS (see the frozen branch in orbit_agent.py). GeoIP is NOT bundled —
the agent downloads it once into %LOCALAPPDATA%\\Orbit on first run.
"""
import os
from PyInstaller.utils.hooks import collect_submodules

ROOT = os.path.dirname(SPECPATH)                 # repo root (this spec lives in build/)
AGENT = os.path.join(ROOT, "agent", "orbit_agent.py")
DEPS = os.path.join(ROOT, ".deps")               # dev deps (pip install --target .deps)

hidden = collect_submodules("scapy") + ["maxminddb", "aiohttp"]

datas = [(os.path.join(ROOT, "web"), "web")]     # served frontend → _MEIPASS/web

a = Analysis(
    [AGENT],
    pathex=[DEPS] if os.path.isdir(DEPS) else [],
    binaries=[],
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "PyQt5", "PySide2", "matplotlib", "numpy"],
    noarchive=False,
)
pyz = PYZ(a.pure)

_icon = os.path.join(ROOT, "build", "orbit.ico")
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="orbit",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                                   # UPX trips antivirus heuristics
    console=False,                               # hidden backend: the browser app window is the
                                                 # only UI. Logs go to %LOCALAPPDATA%\Orbit\orbit.log;
                                                 # launched from a terminal it reattaches to that
                                                 # console (see _attach_console) so CLI output shows.
    icon=_icon if os.path.exists(_icon) else None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="orbit",
)

# ◉ Orbit

A real-time network packet observatory — watch the internet orbit your PC as a living galaxy.

![Orbit](docs/screenshot.png)

Orbit is **fully passive**: it only listens and never sends a packet to the network. Windows only.

## Install

### Installer (recommended)

Download the latest **`Orbit-*.msi`** from the [Releases page](https://github.com/DongInSong/Orbit/releases/latest)
and run it — **no Python needed**, everything is bundled. It installs to `C:\Program Files\Orbit`
with two Start-Menu shortcuts:

- **Orbit** — live capture (needs Npcap; right-click → *Run as administrator*)
- **Orbit (Demo)** — synthetic traffic, no Npcap or admin, works immediately

The app opens as a chromeless browser window; **closing that window quits Orbit**. The MSI is
self-signed, so Windows shows an "Unknown publisher" warning at install — that's expected, click
through to proceed.

### From source

Needs **Python 3.10+** (dependencies install themselves on first run):

```
run.bat            # live capture — requests admin automatically, opens a chromeless app window
run.bat --demo     # synthetic traffic, no Npcap or admin needed
```

## Npcap (live capture)

Live capture needs the [Npcap](https://npcap.com) driver — tick **"WinPcap API-compatible mode"** on
install (and uncheck *"Restrict to administrators"* to capture without elevation). Demo and replay
need neither Npcap nor admin.

## Reading the galaxy

- **Center** — this machine (LOCAL); it brightens with total traffic and dims to **NO TRAFFIC** when idle.
- **Stars** — remote hosts you're talking to: size = throughput, color = protocol.
- **Streams** — live packets, falling inward (download) or flying out (upload).
- **Country flags** — every host shows its flag in the sidebar, connection list and detail card,
  rendered via a bundled [Twemoji](https://github.com/twitter/twemoji) font so they display on Windows.
- **Constellation lines** — hosts owned by the same process are linked.
- **Red rings** — an alert on that host: port scan, dark/unsolicited traffic, failed/refused
  connection, or packet loss.
- **Sidebar** — a filterable host list plus a tabbed **CONNECTIONS / ALERTS** panel with alert history.
  The header tracks packets/s, active hosts, outbound loss %, and session totals.

Hover a star for a detail card (flag, operator/ASN, process); left-click copies its IP, right-click
pins the card. Click the **?** for an in-app legend.

## Replay & save — in-app

The bottom bandwidth chart is a live 120-second timeline. **Drag across it** to select a window, then:

- **▶ REPLAY** — replay just that window in the galaxy. Capture never pauses — it's 100% local.
- **⤓ SAVE** — write that window to a `.jsonl` file to replay later.
- **↺ LIVE** — snap back to the live view.

### Headless record / replay (CLI)

```
run.bat --record                 # live capture + record to orbit-live-<timestamp>.jsonl
run.bat --demo --record demo.jsonl
run.bat --replay demo.jsonl      # play it back at the original pace
run.bat --replay demo.jsonl --loop
```

Recordings are newline-delimited JSON (one tick per line) and keep their GeoIP/ASN labels.

## Capture interface

Orbit auto-selects the interface that owns your default route (the one online) and prints which one
it chose. **If you switch networks (Ethernet ↔ Wi-Fi), restart Orbit** — the capture interface and
your local IP are fixed at startup.

```
run.bat --list-ifaces            # show adapters (no admin needed)
run.bat --iface "Wi-Fi"          # capture on a named adapter
```

## GeoIP / ASN

Hosts are labelled with their country and network operator, **100% offline**: on first run Orbit
downloads the [DB-IP Lite](https://db-ip.com) databases once (into `.geoip/`, or `%LOCALAPPDATA%\Orbit`
when installed from the MSI), then never makes a per-IP network request. If the download fails
(offline), enrichment simply stays off and capture is unaffected.

<a href='https://db-ip.com'>IP Geolocation by DB-IP</a> (CC BY 4.0).
Country flags use [Twemoji](https://github.com/twitter/twemoji) (CC BY 4.0).

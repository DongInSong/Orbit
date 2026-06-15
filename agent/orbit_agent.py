#!/usr/bin/env python3
"""Orbit — passive network observatory agent.

Sniffs packet headers (Npcap/libpcap), aggregates into 100ms ticks,
and streams them to the browser frontend over a localhost WebSocket.
Serves the frontend itself: run this, open http://localhost:8420, done.

Live mode never sends a single packet to the network — capture is
copy-only, DNS names come from passively observed responses.
"""

import argparse
import asyncio
import gzip
import json
import math
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from collections import defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / ".deps"))

# Windows + redirected output falls back to cp949, which can't encode the
# banner glyphs — force UTF-8 so printing never crashes the agent
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

from aiohttp import web, WSMsgType

TICK_SEC = 0.1
DEFAULT_PORT = 8420
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
CONN_TTL = 60.0          # a (ip, port, proto) seen again after this counts as "new"
TOP_HOSTS_PER_TICK = 30

PROTOS = ("tls", "quic", "dns", "tcp", "udp", "icmp", "other")

SCAN_WINDOW = 10.0       # port-scan heuristic: distinct ports per remote ip
SCAN_PORTS = 12          # within SCAN_WINDOW seconds triggers an alert
SCAN_COOLDOWN = 60.0
DARK_BYTES = 5 * 1024 * 1024   # unnamed public host exceeding this → alert

SYN_TIMEOUT = 6.0        # outbound SYN with no SYN-ACK within this → failed conn
FAIL_COOLDOWN = 30.0     # per-host cooldown between connection-failure alerts

# ----------------------------------------------------------------------- geoip
GEO_DIR = Path(__file__).resolve().parent.parent / ".geoip"
GEO_MAX_AGE = 40 * 86400       # re-download a cached build once it is older
GEO_CACHE_MAX = 50000
DBIP_BASE = "https://download.db-ip.com/free"


def _is_private(ip):
    import ipaddress
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return True


# --------------------------------------------------------- geoip + asn (DB-IP)

def _month_candidates(n=3):
    """Current YYYY-MM first, then earlier months. DB-IP publishes a new Lite
    build early each month and the current one may not be up yet, so we fall
    back a couple of months rather than failing."""
    y, m = date.today().year, date.today().month
    out = []
    for _ in range(n):
        out.append(f"{y:04d}-{m:02d}")
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return out


class GeoDB:
    """Offline GeoIP + ASN enrichment from DB-IP Lite (CC BY 4.0).

    Loads cached .mmdb files if present; otherwise a daemon thread downloads
    them once (gzip → atomic replace) and enrichment activates when ready.
    Lookups are 100% local — no per-IP network access, ever. If the one-time
    download fails (offline), enrichment simply stays off; there is no retry
    storm and capture is never affected."""

    def __init__(self):
        self._country = None     # maxminddb readers, published atomically
        self._asn = None
        self._cache = {}         # ip -> {cc,country,asn,org} | {} (miss/private)
        self._lock = threading.Lock()

    def start(self):
        threading.Thread(target=self._bootstrap, daemon=True).start()
        return self

    def lookup(self, ip):
        """Local-only lookup. Runs on the asyncio thread; never under agg.lock."""
        country, asn = self._country, self._asn
        if country is None and asn is None:
            return None
        hit = self._cache.get(ip)
        if hit is not None:
            return hit or None       # {} sentinel → private/miss, cached
        if _is_private(ip):
            self._cache[ip] = {}
            return None
        out = {}
        try:
            if country is not None:
                r = country.get(ip)
                if r:
                    co = r.get("country") or {}
                    if co.get("iso_code"):
                        out["cc"] = co["iso_code"]
                    names = co.get("names") or {}
                    nm = names.get("en")
                    if nm:
                        out["country"] = nm
            if asn is not None:
                r = asn.get(ip)
                if r:
                    n = r.get("autonomous_system_number")
                    if n is not None:
                        out["asn"] = n
                    org = r.get("autonomous_system_organization")
                    if org:
                        out["org"] = org
        except (ValueError, KeyError):
            out = {}
        if len(self._cache) > GEO_CACHE_MAX:
            self._cache = {}         # atomic rebind — safe vs the bootstrap thread
        self._cache[ip] = out
        return out or None

    def enrich(self, snap):
        """Add cc/country/asn/org to each host and conn dict of a snapshot.
        Called from the tick loop AFTER snapshot() returns — the dicts are
        already detached from the live aggregator, so no lock is held."""
        if self._country is None and self._asn is None:
            return
        for rec in snap.get("hosts", ()):
            g = self.lookup(rec["ip"])
            if g:
                rec.update(g)
        for rec in snap.get("conns", ()):
            g = self.lookup(rec["ip"])
            if g:
                rec.update(g)

    # ---- bootstrap / one-time download (daemon thread) ---------------------

    def _bootstrap(self):
        try:
            import maxminddb
        except Exception:
            return                   # dep missing → enrichment stays off
        try:
            GEO_DIR.mkdir(parents=True, exist_ok=True)
        except OSError:
            return
        cpath = self._ensure("dbip-country-lite")
        apath = self._ensure("dbip-asn-lite")
        country = asn = None
        try:
            if cpath:
                country = maxminddb.open_database(str(cpath), maxminddb.MODE_MEMORY)
        except Exception:
            country = None
        try:
            if apath:
                asn = maxminddb.open_database(str(apath), maxminddb.MODE_MEMORY)
        except Exception:
            asn = None
        with self._lock:
            self._country, self._asn = country, asn
            self._cache = {}

    def _ensure(self, slug):
        """Return a path to a usable .mmdb for slug, downloading if needed."""
        existing = sorted(GEO_DIR.glob(f"{slug}-*.mmdb"))
        newest = existing[-1] if existing else None
        if newest is not None:
            try:
                if time.time() - newest.stat().st_mtime < GEO_MAX_AGE:
                    return newest
            except OSError:
                pass
        got = self._download(slug)
        if got is None:
            return newest            # fall back to a stale copy if we have one
        for old in existing:
            if old != got:
                try:
                    old.unlink()
                except OSError:
                    pass
        return got

    def _download(self, slug):
        for ym in _month_candidates():
            dest = GEO_DIR / f"{slug}-{ym}.mmdb"
            if dest.exists():
                return dest
            url = f"{DBIP_BASE}/{slug}-{ym}.mmdb.gz"
            try:
                print(f"  ◉ GeoIP: downloading {slug} {ym}…", flush=True)
                req = urllib.request.Request(url, headers={"User-Agent": "orbit"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    raw = gzip.decompress(resp.read())
                tmp = dest.with_name(dest.name + ".part")
                tmp.write_bytes(raw)
                os.replace(tmp, dest)
                return dest
            except Exception:
                continue             # try the previous month, then give up
        return None


# ------------------------------------------------- process attribution (win)

class ProcessMap:
    """Maps (l4, local_port) -> owning process name via GetExtendedTcp/UdpTable.
    Windows-only, pure ctypes, no admin needed for the table itself."""

    REFRESH = 2.0

    def __init__(self):
        self._map = {}
        self._names = {}
        self._lock = threading.Lock()

    def start(self):
        if sys.platform == "win32":
            threading.Thread(target=self._loop, daemon=True).start()
        return self

    def lookup(self, l4, port):
        with self._lock:
            return self._map.get((l4, port))

    def _loop(self):
        import ctypes
        from ctypes import wintypes
        iphlp = ctypes.WinDLL("iphlpapi")
        k32 = ctypes.WinDLL("kernel32")
        DWORD = wintypes.DWORD

        class TCP4(ctypes.Structure):
            _fields_ = [("state", DWORD), ("laddr", DWORD), ("lport", DWORD),
                        ("raddr", DWORD), ("rport", DWORD), ("pid", DWORD)]

        class TCP6(ctypes.Structure):
            _fields_ = [("laddr", ctypes.c_ubyte * 16), ("lscope", DWORD),
                        ("lport", DWORD), ("raddr", ctypes.c_ubyte * 16),
                        ("rscope", DWORD), ("rport", DWORD),
                        ("state", DWORD), ("pid", DWORD)]

        class UDP4(ctypes.Structure):
            _fields_ = [("laddr", DWORD), ("lport", DWORD), ("pid", DWORD)]

        class UDP6(ctypes.Structure):
            _fields_ = [("laddr", ctypes.c_ubyte * 16), ("lscope", DWORD),
                        ("lport", DWORD), ("pid", DWORD)]

        def table(fn, af, row_cls, level):
            size = DWORD(0)
            fn(None, ctypes.byref(size), False, af, level, 0)
            if not size.value:
                return []
            buf = ctypes.create_string_buffer(size.value)
            if fn(buf, ctypes.byref(size), False, af, level, 0) != 0:
                return []
            n = ctypes.cast(buf, ctypes.POINTER(DWORD)).contents.value
            return ctypes.cast(ctypes.byref(buf, ctypes.sizeof(DWORD)),
                               ctypes.POINTER(row_cls * n)).contents

        def pname(pid):
            if pid in self._names:
                return self._names[pid]
            name = "System" if pid == 4 else None
            if name is None and pid:
                h = k32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFO
                if h:
                    ubuf = ctypes.create_unicode_buffer(260)
                    sz = DWORD(260)
                    if k32.QueryFullProcessImageNameW(h, 0, ubuf, ctypes.byref(sz)):
                        name = ubuf.value.rsplit("\\", 1)[-1]
                    k32.CloseHandle(h)
            if len(self._names) > 4096:
                self._names.clear()
            self._names[pid] = name
            return name

        while True:
            try:
                fresh = {}
                for af, cls in ((2, TCP4), (23, TCP6)):
                    for r in table(iphlp.GetExtendedTcpTable, af, cls, 5):
                        fresh[("tcp", socket.ntohs(r.lport & 0xFFFF))] = r.pid
                for af, cls in ((2, UDP4), (23, UDP6)):
                    for r in table(iphlp.GetExtendedUdpTable, af, cls, 1):
                        fresh[("udp", socket.ntohs(r.lport & 0xFFFF))] = r.pid
                named = {k: n for k, pid in fresh.items()
                         if (n := pname(pid))}
                with self._lock:
                    self._map = named
            except Exception:
                pass
            time.sleep(self.REFRESH)


# ---------------------------------------------------------------- aggregation

class Aggregator:
    """Accumulates per-tick stats. Fed by the sniffer thread (live) or the
    demo generator; drained by the asyncio tick loop via snapshot()."""

    def __init__(self, dark_threshold=DARK_BYTES):
        self.lock = threading.Lock()
        self.dns_cache = {}            # ip -> domain (passively observed)
        self.conn_last_seen = {}       # (ip, port, proto) -> monotonic ts
        self.totals = {"up": 0, "down": 0, "pkts": 0}
        self.started = time.time()
        self.dark_threshold = dark_threshold
        self.scan_track = defaultdict(list)   # ip -> [(t, port), ...]
        self.scan_alerted = {}                # ip -> last alert t
        self.dark_bytes = defaultdict(int)    # unnamed public ip -> bytes
        self.dark_alerted = set()
        self.private_cache = {}
        self.syn_pending = {}          # (ip, rport) -> ts of an unanswered SYN
        self.fail_alerted = {}         # ip -> last connection-failure alert t
        self._reset()

    def _reset(self):
        self.up = 0
        self.down = 0
        self.pkts = 0
        self.proto = defaultdict(int)
        self.hosts = defaultdict(lambda: {"up": 0, "down": 0, "pkts": 0,
                                          "proto": defaultdict(int),
                                          "procs": defaultdict(int)})
        self.new_conns = []
        self.dns_events = []
        self.alerts = []

    def _private(self, ip):
        v = self.private_cache.get(ip)
        if v is None:
            v = self.private_cache[ip] = _is_private(ip)
            if len(self.private_cache) > 20000:
                self.private_cache.clear()
        return v

    def add(self, ip, port, proto, size, direction, proc=None):
        """direction: 'up' (we sent) or 'down' (we received)."""
        now = time.monotonic()
        with self.lock:
            self.pkts += 1
            self.totals["pkts"] += 1
            if direction == "up":
                self.up += size
                self.totals["up"] += size
            else:
                self.down += size
                self.totals["down"] += size
            self.proto[proto] += size
            h = self.hosts[ip]
            h[direction] += size
            h["pkts"] += 1
            h["proto"][proto] += size
            if proc:
                h["procs"][proc] += size

            key = (ip, port, proto)
            last = self.conn_last_seen.get(key)
            if last is None or now - last > CONN_TTL:
                if len(self.new_conns) < 80:
                    self.new_conns.append({
                        "ip": ip, "port": port, "proto": proto,
                        "dir": direction, "proc": proc,
                        "name": self.dns_cache.get(ip),
                    })
                self._check_scan(ip, port, now)
            self.conn_last_seen[key] = now
            if len(self.conn_last_seen) > 50000:
                cutoff = now - CONN_TTL
                self.conn_last_seen = {k: v for k, v in
                                       self.conn_last_seen.items() if v > cutoff}

            # dark traffic: sustained volume with a public host nothing resolved
            if ip not in self.dns_cache and ip not in self.dark_alerted \
                    and not self._private(ip):
                self.dark_bytes[ip] += size
                if self.dark_bytes[ip] > self.dark_threshold:
                    self.dark_alerted.add(ip)
                    mb = self.dark_bytes[ip] / 1048576
                    self.alerts.append({"type": "dark", "ip": ip,
                                        "detail": f"{mb:.1f} MB, no DNS name"})
                # bound the accumulator like the other long-lived maps — a lossy
                # link churns through many distinct public IPs otherwise
                elif len(self.dark_bytes) > 20000:
                    self.dark_bytes.clear()

    def note_tcp(self, ip, port, direction, flags):
        """Track TCP handshakes to flag failed connections — an outbound SYN
        with no SYN-ACK (timeout, swept in snapshot) or answered by a RST
        (refused). LAN hosts count too (router/switch), so unlike scan/dark
        this does NOT skip private IPs."""
        SYN, ACK, RST = 0x02, 0x10, 0x04
        now = time.monotonic()
        key = (ip, port)
        with self.lock:
            if direction == "up" and (flags & SYN) and not (flags & ACK):
                self.syn_pending.setdefault(key, now)   # keep the first SYN's clock
                if len(self.syn_pending) > 20000:
                    self.syn_pending.clear()
            elif direction == "down" and (flags & SYN) and (flags & ACK):
                self.syn_pending.pop(key, None)         # handshake completed
            elif direction == "down" and (flags & RST):
                if self.syn_pending.pop(key, None) is not None:
                    self._fail(ip, "reset", f":{port} connection refused", now)

    def note_unreach(self, ip, port, icmp_type):
        """ICMP destination-unreachable (3) / TTL-exceeded (11), attributed to
        the real unreachable host unwrapped from the embedded packet."""
        now = time.monotonic()
        label = "unreachable" if icmp_type == 3 else "TTL exceeded"
        detail = f":{port} {label}" if port else label
        with self.lock:
            self._fail(ip, "unreach", detail, now)

    def _fail(self, ip, kind, detail, now):
        """Emit a failure alert with a per-host cooldown. Caller holds the lock."""
        if now - self.fail_alerted.get(ip, -1e9) > FAIL_COOLDOWN:
            self.fail_alerted[ip] = now
            self.alerts.append({"type": kind, "ip": ip, "detail": detail})
        if len(self.fail_alerted) > 20000:
            self.fail_alerted.clear()

    def _sweep_failed(self, now):
        """Outbound SYNs unanswered past SYN_TIMEOUT → failed connection.
        Caller holds the lock (invoked from snapshot)."""
        expired = [k for k, t in self.syn_pending.items() if now - t > SYN_TIMEOUT]
        for key in expired:
            del self.syn_pending[key]
            ip, port = key
            self._fail(ip, "failed", f":{port} no reply", now)

    def _check_scan(self, ip, port, now):
        if self._private(ip):
            return
        track = self.scan_track[ip]
        track.append((now, port))
        if len(track) > 200:
            del track[:100]
        cutoff = now - SCAN_WINDOW
        recent = {p for t, p in track if t > cutoff}
        if len(recent) >= SCAN_PORTS and \
                now - self.scan_alerted.get(ip, -1e9) > SCAN_COOLDOWN:
            self.scan_alerted[ip] = now
            self.alerts.append({"type": "scan", "ip": ip,
                                "detail": f"{len(recent)} ports / {int(SCAN_WINDOW)}s"})
        if len(self.scan_track) > 5000:
            self.scan_track.clear()

    def add_dns(self, domain, ip):
        with self.lock:
            self.dns_cache[ip] = domain
            if len(self.dns_events) < 40:
                self.dns_events.append({"q": domain, "ip": ip})
            if len(self.dns_cache) > 20000:
                self.dns_cache.clear()

    def snapshot(self):
        with self.lock:
            self._sweep_failed(time.monotonic())
            top = sorted(self.hosts.items(),
                         key=lambda kv: kv[1]["up"] + kv[1]["down"],
                         reverse=True)[:TOP_HOSTS_PER_TICK]
            hosts = []
            for ip, h in top:
                dom = max(h["proto"].items(), key=lambda kv: kv[1])[0]
                proc = max(h["procs"].items(), key=lambda kv: kv[1])[0] \
                    if h["procs"] else None
                hosts.append({
                    "ip": ip, "up": h["up"], "down": h["down"],
                    "pkts": h["pkts"], "proto": dom, "proc": proc,
                    "name": self.dns_cache.get(ip),
                })
            # ensure hosts referenced by fresh alerts have a node so their marker
            # (broken ring / pulse) renders — a failed/unreachable host often
            # carries too little traffic to make the top-N on its own
            shown = {r["ip"] for r in hosts}
            for a in self.alerts:
                aip = a.get("ip")
                if not aip or aip in shown:
                    continue
                shown.add(aip)
                h = self.hosts.get(aip)
                if h:
                    dom = max(h["proto"].items(), key=lambda kv: kv[1])[0]
                    hosts.append({"ip": aip, "up": h["up"], "down": h["down"],
                                  "pkts": h["pkts"], "proto": dom, "proc": None,
                                  "name": self.dns_cache.get(aip)})
                else:
                    hosts.append({"ip": aip, "up": 0, "down": 0, "pkts": 0,
                                  "proto": "other", "proc": None,
                                  "name": self.dns_cache.get(aip)})
            tick = {
                "t": int(time.time() * 1000),
                "up": self.up, "down": self.down, "pps": self.pkts * 10,
                "proto": {p: self.proto.get(p, 0) for p in PROTOS},
                "hosts": hosts,
                "conns": self.new_conns,
                "dns": self.dns_events,
                "alerts": self.alerts,
                "totals": dict(self.totals, since=int(self.started * 1000)),
            }
            self._reset()
        return tick


# ---------------------------------------------------------------- live capture

def local_ip_set():
    ips = {"127.0.0.1", "::1"}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None):
            ips.add(info[4][0].split("%")[0])
    except socket.gaierror:
        pass
    # primary outbound addr (no packet is actually sent for UDP connect)
    for fam, probe in ((socket.AF_INET, "192.0.2.1"), (socket.AF_INET6, "2001:db8::1")):
        try:
            s = socket.socket(fam, socket.SOCK_DGRAM)
            s.connect((probe, 9))
            ips.add(s.getsockname()[0].split("%")[0])
            s.close()
        except OSError:
            pass
    return ips


def classify(sport, dport, l4):
    if 53 in (sport, dport):
        return "dns"
    if l4 == "tcp":
        return "tls" if 443 in (sport, dport) or 8443 in (sport, dport) else "tcp"
    if l4 == "udp":
        return "quic" if 443 in (sport, dport) else "udp"
    return l4


def _resolve_iface(iface):
    """Pick the capture interface. An explicit --iface always wins. Otherwise
    bind to the interface that owns the default route — i.e. the one actually
    online — which is more reliable than scapy's global default when several
    adapters exist (e.g. a still-enabled Ethernet port lingering after you
    switch to Wi-Fi)."""
    if iface:
        return iface
    try:
        from scapy.all import conf
        dev, _, _ = conf.route.route("0.0.0.0")
        return dev or conf.iface
    except Exception:
        return None      # let scapy fall back to its own default


def _iface_label(dev):
    """Human-friendly name for a capture device — Windows hands back raw
    \\Device\\NPF_{GUID} names, so map those back to e.g. 'Wi-Fi'."""
    if not dev:
        return "default"
    try:
        from scapy.all import conf
        if not isinstance(dev, str):
            return getattr(dev, "name", None) or str(dev)
        if "NPF_" in dev.upper():
            ni = conf.ifaces.dev_from_networkname(dev)
            return getattr(ni, "name", None) or dev
        return dev
    except Exception:
        return str(dev)


def list_ifaces():
    from scapy.all import conf
    print("\n  Capture interfaces — use the NAME with --iface:\n")
    try:
        conf.ifaces.show()
    except Exception:
        from scapy.all import get_if_list
        for n in get_if_list():
            print("   ", n)
    try:
        dev, _, _ = conf.route.route("0.0.0.0")
        print(f"\n  default route → {dev}")
    except Exception:
        pass
    print()


def start_live_capture(agg, iface):
    from scapy.all import (AsyncSniffer, DNS, ICMP, IP, IPv6, TCP, UDP,  # noqa: lazy
                           IPerror, TCPerror, UDPerror)
    try:
        from scapy.layers.inet6 import ICMPv6EchoRequest  # noqa: F401
    except ImportError:
        pass

    iface = _resolve_iface(iface)
    local = local_ip_set()
    procmap = ProcessMap().start()

    def handle(pkt):
        if IP in pkt:
            src, dst, size = pkt[IP].src, pkt[IP].dst, len(pkt)
        elif IPv6 in pkt:
            src, dst, size = pkt[IPv6].src, pkt[IPv6].dst, len(pkt)
        else:
            return

        if src in local and dst not in local:
            direction, remote = "up", dst
        elif dst in local:
            direction, remote = "down", src
        else:
            return

        sport = dport = 0
        tcp_flags = None
        if TCP in pkt:
            sport, dport, l4 = pkt[TCP].sport, pkt[TCP].dport, "tcp"
            tcp_flags = int(pkt[TCP].flags)
        elif UDP in pkt:
            sport, dport, l4 = pkt[UDP].sport, pkt[UDP].dport, "udp"
        elif ICMP in pkt or (IPv6 in pkt and pkt[IPv6].nh == 58):
            l4 = "icmp"
        else:
            l4 = "other"

        proto = classify(sport, dport, l4)
        rport = dport if direction == "up" else sport
        proc = None
        if l4 in ("tcp", "udp"):
            lport = sport if direction == "up" else dport
            proc = procmap.lookup(l4, lport)
        agg.add(remote, rport, proto, size, direction, proc)

        # connection-health signals
        if tcp_flags is not None:
            agg.note_tcp(remote, rport, direction, tcp_flags)
        elif l4 == "icmp" and ICMP in pkt and pkt[ICMP].type == 3 \
                and IPerror in pkt:   # 3 = dest-unreachable (11/TTL is normal traceroute)
            oport = pkt[TCPerror].dport if TCPerror in pkt else \
                pkt[UDPerror].dport if UDPerror in pkt else None
            agg.note_unreach(pkt[IPerror].dst, oport, pkt[ICMP].type)

        if proto == "dns" and DNS in pkt and pkt[DNS].qr == 1 and pkt[DNS].ancount:
            try:
                rr = pkt[DNS].an
                for i in range(pkt[DNS].ancount):
                    r = rr[i] if pkt[DNS].ancount > 1 else rr
                    if r.type in (1, 28):
                        name = r.rrname.decode().rstrip(".")
                        agg.add_dns(name, str(r.rdata))
            except Exception:
                pass

    sniffer = AsyncSniffer(prn=handle, store=False, filter="ip or ip6",
                           iface=iface or None)
    sniffer.start()
    return _iface_label(iface)    # friendly name of the interface being captured


# ----------------------------------------------------------------- demo mode

DEMO_HOSTS = [
    # ip, name, proto, port, base down B/s, base up B/s, burstiness, proc
    ("140.82.112.3",   "github.com",            "tls",  443, 4_000,   1_500, 3.0, "Code.exe"),
    ("142.250.207.78", "youtube.com",           "quic", 443, 900_000, 9_000, 1.4, "chrome.exe"),
    ("104.16.132.229", "cloudflare.com",        "tls",  443, 22_000,  3_000, 2.2, "chrome.exe"),
    ("13.107.42.14",   "onedrive.live.com",     "tls",  443, 9_000,   45_000, 2.5, "OneDrive.exe"),
    ("151.101.1.140",  "reddit.com",            "tls",  443, 14_000,  2_000, 2.8, "chrome.exe"),
    ("203.133.167.16", "kakaocdn.net",          "tls",  443, 30_000,  2_500, 2.4, "KakaoTalk.exe"),
    ("23.46.196.139",  "steamcontent.com",      "tcp",  80,  0,       0,     1.0, "steam.exe"),
    ("8.8.8.8",        "dns.google",            "dns",  53,  500,     400,   1.6, "svchost.exe"),
    ("162.159.135.232","discord.gg",            "udp",  50001, 12_000, 11_000, 1.3, "Discord.exe"),
    ("44.226.243.85",  "telemetry.example.io",  "tls",  443, 700,     1_800, 2.0, "svchost.exe"),
    ("110.76.143.22",  "navercorp.com",         "tls",  443, 7_000,   1_200, 2.6, "whale.exe"),
    # unnamed host quietly uploading — trips the dark-traffic alert
    ("91.219.238.7",   None,                    "tcp",  8443, 900,    80_000, 1.2, None),
]

DEMO_EPHEMERAL = [
    ("184.25.{}.{}",  "cdn.akamai.net",     "tls"),
    ("99.84.{}.{}",   "d1.cloudfront.net",  "tls"),
    ("34.120.{}.{}",  "fonts.gstatic.com",  "quic"),
    ("13.224.{}.{}",  "static.megacdn.io",  "tls"),
]


async def run_demo(agg):
    rng = random.Random()
    for ip, name, *_ in DEMO_HOSTS:
        if name:
            agg.add_dns(name, ip)

    yt_on, yt_until = True, time.monotonic() + 30
    steam_until = 0.0
    next_scan = time.monotonic() + rng.uniform(25, 40)
    t0 = time.monotonic()

    while True:
        now = time.monotonic()
        wave = 0.75 + 0.25 * math.sin((now - t0) / 9.0)

        if now > yt_until:
            yt_on = not yt_on
            yt_until = now + rng.uniform(15, 45)
        if now > steam_until and rng.random() < 0.004:
            steam_until = now + rng.uniform(12, 25)

        for ip, name, proto, port, down, up, burst, proc in DEMO_HOSTS:
            if name == "youtube.com" and not yt_on:
                down, up = 200, 100
            if name == "steamcontent.com":
                if now < steam_until:
                    down, up = 2_800_000, 30_000
                elif rng.random() > 0.05:
                    continue
                else:
                    down, up = 800, 300
            mult = wave * rng.uniform(0.3, burst)
            db = int(down * mult * TICK_SEC)
            ub = int(up * mult * TICK_SEC)
            for total, direction in ((db, "down"), (ub, "up")):
                while total > 0:
                    size = min(total, rng.randint(400, 1500))
                    agg.add(ip, port, proto, size, direction, proc)
                    total -= size

        if rng.random() < 0.06:
            tmpl, name, proto = rng.choice(DEMO_EPHEMERAL)
            ip = tmpl.format(rng.randint(1, 254), rng.randint(1, 254))
            agg.add_dns(name, ip)
            for _ in range(rng.randint(4, 30)):
                agg.add(ip, 443, proto, rng.randint(500, 1500), "down", "chrome.exe")
            agg.add(ip, 443, proto, rng.randint(100, 600), "up", "chrome.exe")

        if rng.random() < 0.02:
            agg.add("192.168.0.1", 0, "icmp", 84, "up")
            agg.add("192.168.0.1", 0, "icmp", 84, "down")

        # periodic inbound port sweep — exercises the real scan detector
        if now > next_scan:
            next_scan = now + rng.uniform(40, 70)
            scanner = f"185.220.{rng.randint(100, 103)}.{rng.randint(2, 254)}"
            for p in rng.sample(range(20, 9000), 18):
                agg.add(scanner, p, "tcp", 60, "down")

        await asyncio.sleep(TICK_SEC)


# -------------------------------------------------------------------- server

async def ws_handler(request):
    app = request.app
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    await ws.send_json({"type": "hello", "mode": app["mode"],
                        "iface": app["iface"] or "default"})
    app["clients"].add(ws)
    if app["mode"] == "replay":
        app["replay_restart"] = True   # rewind so the new viewer sees frame 0
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
    finally:
        app["clients"].discard(ws)
    return ws


async def index_handler(_):
    return web.FileResponse(WEB_DIR / "index.html")


@web.middleware
async def no_cache(request, handler):
    """Localhost dev tool — never serve a stale frontend from browser cache.
    no-cache makes the browser revalidate via ETag every load (304 when the
    file is unchanged, so it stays fast)."""
    resp = await handler(request)
    if not resp.prepared:        # skip the already-sent WebSocket response
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# --------------------------------------------------------------- record / replay

REC_VERSION = 1
REC_CLAMP_HI = 1.0       # cap replay inter-tick delay so long gaps don't stall


class TickRecorder:
    """Appends each emitted (already geo-enriched) tick to a JSONL file: a
    header line first, then one compact tick per line. Append-only and line
    buffered, so a crash loses at most the final partial line, which the
    replayer tolerates. No fsync — that would stall the event loop."""

    def __init__(self, path, mode, iface):
        self.path = path
        self.f = open(path, "a", buffering=1, encoding="utf-8")
        header = {"orbit": "rec", "v": REC_VERSION, "mode": mode,
                  "iface": iface, "started": int(time.time() * 1000)}
        self.f.write(json.dumps(header, separators=(",", ":")) + "\n")

    def write(self, line):
        self.f.write(line + "\n")

    def close(self):
        try:
            self.f.close()
        except OSError:
            pass


def _read_rec_header(f):
    """Return (header_dict, first_data_line_or_None). A leading {"orbit":"rec"}
    line is the header; anything else is treated as the first data tick so a
    headerless file still replays fully."""
    line = f.readline()
    if not line:
        return {}, None
    s = line.strip()
    try:
        obj = json.loads(s)
    except ValueError:
        return {}, None
    if isinstance(obj, dict) and obj.get("orbit") == "rec":
        return obj, None
    return {}, s


def _iter_ticks(f, first=None):
    if first:
        try:
            yield json.loads(first)
        except ValueError:
            pass
    for line in f:
        s = line.strip()
        if not s:
            continue
        try:
            yield json.loads(s)
        except ValueError:
            if not line.endswith("\n"):
                return            # truncated final line (crash during record)
            continue              # corrupt middle line — skip, keep neighbours


async def _play_once(app):
    """Stream the recording once, paced by the recorded 't' deltas. Aborts
    early (returning the count so far) if a viewer joins/leaves."""
    clients = app["clients"]
    try:
        f = open(app["replay"], encoding="utf-8")
    except OSError:
        await asyncio.sleep(0.5)
        return 0
    n = 0
    prev_t = None
    with f:
        _, first = _read_rec_header(f)
        for tick in _iter_ticks(f, first):
            if app["replay_restart"] or not clients:
                return n
            t = tick.get("t")
            delay = TICK_SEC
            if prev_t is not None and isinstance(t, (int, float)):
                d = (t - prev_t) / 1000.0
                delay = d if 0.0 <= d <= REC_CLAMP_HI else TICK_SEC
            if isinstance(t, (int, float)):
                prev_t = t
            await asyncio.sleep(delay)
            payload = json.dumps({"type": "tick", **tick}, separators=(",", ":"))
            for ws in list(clients):
                try:
                    await ws.send_str(payload)
                except (ConnectionResetError, RuntimeError):
                    clients.discard(ws)
            n += 1
    return n


async def replay_loop(app):
    clients = app["clients"]
    while True:
        if not clients:
            await asyncio.sleep(0.2)
            continue
        app["replay_restart"] = False
        emitted = await _play_once(app)
        if app["replay_restart"]:
            continue                      # a new viewer joined → restart at 0
        if app["loop"] and emitted:
            await asyncio.sleep(0.5)       # brief gap, then loop
            continue
        # reached the end (or empty/corrupt file): hold here until a viewer
        # reconnects — the sleep floor guarantees we never busy-spin
        while clients and not app["replay_restart"]:
            await asyncio.sleep(0.3)


async def tick_loop(app):
    agg, clients, geo = app["agg"], app["clients"], app["geo"]
    rec = app["recorder"]
    while True:
        await asyncio.sleep(TICK_SEC)
        if not clients and rec is None:
            agg.snapshot()  # keep windows bounded even with no viewers
            continue
        snap = agg.snapshot()
        if geo is not None:
            geo.enrich(snap)            # geo fields added outside agg.lock
        if rec is not None:
            rec.write(json.dumps(snap, separators=(",", ":")))
        if not clients:
            continue
        payload = json.dumps({"type": "tick", **snap}, separators=(",", ":"))
        dead = []
        for ws in clients:
            try:
                await ws.send_str(payload)
            except (ConnectionResetError, RuntimeError):
                dead.append(ws)
        for ws in dead:
            clients.discard(ws)


async def on_startup(app):
    if app["mode"] == "replay":
        app["replay_task"] = asyncio.create_task(replay_loop(app))
        return
    app["tick_task"] = asyncio.create_task(tick_loop(app))
    if app["mode"] == "demo":
        app["demo_task"] = asyncio.create_task(run_demo(app["agg"]))


async def on_cleanup(app):
    rec = app["recorder"]
    if rec is not None:
        rec.close()


# --------------------------------------------------------------- browser launch

# Edge ships with every modern Windows; Chrome covers the rest. %VARS% that
# don't resolve are left intact by expandvars and filtered out below.
CHROMIUM_CANDIDATES = (
    r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
    r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
    r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
    r"%LocalAppData%\Google\Chrome\Application\chrome.exe",
)


def open_app(url, port):
    """Open the UI in a chromeless app window (no tabs/address bar) via a
    Chromium browser's --app mode. Falls back to the default browser."""
    exe = None
    for cand in CHROMIUM_CANDIDATES:
        path = os.path.expandvars(cand)
        if "%" not in path and os.path.exists(path):
            exe = path
            break
    if exe is None:   # PATH lookup for non-Windows / portable installs
        for name in ("chrome", "google-chrome", "chromium", "chromium-browser", "msedge"):
            if (exe := shutil.which(name)):
                break
    if exe is None:
        webbrowser.open(url)
        return
    # dedicated profile → reliably opens its own window even if the browser is
    # already running, and remembers this app window's size/position
    profile = Path(tempfile.gettempdir()) / f"orbit-app-{port}"
    try:
        subprocess.Popen([exe, f"--app={url}", f"--user-data-dir={profile}",
                          "--no-first-run", "--no-default-browser-check"])
    except OSError:
        webbrowser.open(url)


def main():
    ap = argparse.ArgumentParser(description="Orbit network observatory agent")
    ap.add_argument("--demo", action="store_true",
                    help="synthetic traffic, no capture (no Npcap/admin needed)")
    ap.add_argument("--iface", default=None, help="capture interface name")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--record", nargs="?", const="", default=None, metavar="FILE",
                    help="record every tick to a .jsonl session file")
    ap.add_argument("--replay", default=None, metavar="FILE",
                    help="replay a recorded .jsonl session (no capture/admin)")
    ap.add_argument("--loop", action="store_true",
                    help="loop the replay when it reaches the end")
    ap.add_argument("--list-ifaces", action="store_true",
                    help="list capture interfaces and exit")
    args = ap.parse_args()

    if args.list_ifaces:
        list_ifaces()
        return

    mode = "replay" if args.replay else "demo" if args.demo else "live"
    # demo lowers the dark-traffic bar so the alert shows up within ~20s
    agg = Aggregator(dark_threshold=1_500_000 if args.demo else DARK_BYTES)
    geo = None

    if mode == "replay":
        if not os.path.exists(args.replay):
            print(f"\n  [!] replay file not found: {args.replay}\n")
            sys.exit(1)
        iface = os.path.basename(args.replay)
    else:
        iface = args.iface
        geo = GeoDB().start()        # offline GeoIP/ASN; downloads once if needed
        if mode == "live":
            try:
                iface = str(start_live_capture(agg, args.iface) or args.iface or "default")
            except Exception as e:
                print(f"\n  [!] capture failed to start: {e}")
                print("      Check that Npcap is installed and you ran as administrator.")
                print("      Npcap: https://npcap.com  (enable 'WinPcap API-compatible mode' on install)")
                print("      To preview the UI without capture: python orbit_agent.py --demo\n")
                sys.exit(1)

    recorder = None
    if args.record is not None and mode != "replay":
        path = args.record or f"orbit-{mode}-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
        try:
            recorder = TickRecorder(path, mode, iface)
            print(f"  ◉ recording → {path}")
        except OSError as e:
            print(f"  [!] could not open recording file: {e}")

    app = web.Application(middlewares=[no_cache])
    app["agg"] = agg
    app["clients"] = set()
    app["mode"] = mode
    app["iface"] = iface
    app["geo"] = geo
    app["recorder"] = recorder
    app["replay"] = args.replay
    app["loop"] = args.loop
    app["replay_restart"] = False
    app.router.add_get("/", index_handler)
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/", WEB_DIR)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    url = f"http://localhost:{args.port}"
    print(f"\n  ◉ Orbit  —  {mode.upper()} mode")
    if mode == "live":
        print(f"    capturing on: {iface}   (other adapter: --iface \"<name>\", list: --list-ifaces)")
    print(f"    {url}\n", flush=True)
    if not args.no_browser:
        threading.Timer(0.8, lambda: open_app(url, args.port)).start()
    web.run_app(app, host="127.0.0.1", port=args.port, print=None)


if __name__ == "__main__":
    main()

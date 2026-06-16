"""Regression tests for the hardening fixes in this PR. Pure-logic — no scapy,
no sockets: drive the Aggregator directly and monkeypatch the GeoIP fetch.

    python3 tests/test_red_tier.py        # exits non-zero on any failure

Needs the runtime deps (aiohttp) importable; orbit_agent self-injects .deps.
"""
import gzip
import io
import sys
import tempfile
import time
from pathlib import Path

AGENT = Path(__file__).resolve().parent.parent / "agent"
sys.path.insert(0, str(AGENT))
import orbit_agent as oa

SYN, SYNACK = 0x02, 0x12
_results = []


def check(name, cond):
    _results.append(bool(cond))
    print(("PASS" if cond else "FAIL"), name)


def test_loss_badge_decays():
    """A recovered link must stop reporting loss — the badge used to stick lit
    for the whole session because data-quiet hosts skipped EMA decay."""
    agg = oa.Aggregator()
    ip = "198.51.100.7"
    for _ in range(50):
        agg.add(ip, 443, "tcp", 100, "up")
        agg.note_tcp_seg(12345, ip, 443, 0, 100)        # repeated seq → retransmits
    hot = next((h for h in agg.snapshot()["hosts"] if h["ip"] == ip), None)
    check("loss reported while lossy", hot and hot.get("loss", 0) > 5)

    cleared_at = None
    for k in range(1, 60):
        agg.add(ip, 443, "tcp", 100, "down")            # traffic, but no data segments
        h = next((x for x in agg.snapshot()["hosts"] if x["ip"] == ip), None)
        if h is not None and "loss" not in h:
            cleared_at = k
            break
    check("loss badge decays to clear on a recovered link", cleared_at is not None)


def test_scan_uses_local_ports():
    """A scan sprays unsolicited SYNs across many of OUR ports; a busy peer using
    many of ITS source ports against one of our ports must not false-trip."""
    agg = oa.Aggregator()
    for p in range(20, 38):                              # 18 distinct local ports
        agg.add("185.220.101.50", 50000, "tcp", 60, "down")
        agg.note_tcp(p, "185.220.101.50", 50000, "down", SYN)
    check("inbound SYN sweep across local ports → scan alert",
          any(a["type"] == "scan" for a in agg.snapshot()["alerts"]))

    agg = oa.Aggregator()
    for sp in range(40000, 40018):                       # 18 distinct remote source ports
        agg.add("203.0.113.99", sp, "tcp", 1200, "down")
        agg.note_tcp(443, "203.0.113.99", sp, "down", SYNACK)   # all hit our one port
    check("multi-source-port peer does not false-trip scan",
          not any(a["type"] == "scan" for a in agg.snapshot()["alerts"]))


def test_parallel_conn_failure_not_masked():
    """Two parallel connections to the same server:port are independent; one
    completing must not erase a sibling's genuine timeout."""
    agg = oa.Aggregator()
    ip, port = "203.0.113.5", 443
    agg.note_tcp(11111, ip, port, "up", SYN)             # conn A
    agg.note_tcp(22222, ip, port, "up", SYN)             # conn B (parallel)
    agg.note_tcp(11111, ip, port, "down", SYNACK)        # A completes
    for key in list(agg.syn_pending):                    # age B past the timeout
        agg.syn_pending[key] = time.monotonic() - (oa.SYN_TIMEOUT + 5)
    failed = [a for a in agg.snapshot()["alerts"] if a["type"] == "failed"]
    check("parallel conn B timeout still flagged after A's SYN-ACK",
          len(failed) == 1 and failed[0]["ip"] == ip)


def test_geoip_download_size_capped():
    """A gzip response must inflate within a ceiling (no OOM) and leave no
    partial file behind when rejected."""
    with tempfile.TemporaryDirectory() as d:
        oa.GEO_DIR = Path(d)
        payload = b"M" * 4096
        blob = gzip.compress(payload)

        class _Resp(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *a): self.close(); return False

        oa.urllib.request.urlopen = lambda req, timeout=0: _Resp(blob)
        db = oa.GeoDB.__new__(oa.GeoDB)                  # skip __init__/threads

        oa.GEO_MAX_BYTES = 256 * 1024 * 1024
        res = oa.GeoDB._download(db, "dbip-country-lite")
        check("normal gzip inflates within cap", res and res.read_bytes() == payload)

        oa.GEO_MAX_BYTES = 1024                          # 4096-byte payload now over cap
        oa.urllib.request.urlopen = lambda req, timeout=0: _Resp(blob)
        res2 = oa.GeoDB._download(db, "dbip-asn-lite")
        check("over-cap gzip rejected with no leftover .part",
              res2 is None and not list(Path(d).glob("*.part")))


if __name__ == "__main__":
    test_loss_badge_decays()
    test_scan_uses_local_ports()
    test_parallel_conn_failure_not_masked()
    test_geoip_download_size_capped()
    failures = _results.count(False)
    print(f"\n{'ALL PASS' if not failures else str(failures) + ' FAILED'} "
          f"({_results.count(True)}/{len(_results)})")
    sys.exit(1 if failures else 0)

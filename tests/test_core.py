"""Pure-logic unit tests for the riskiest non-I/O helpers — no scapy/sockets.

    python3 tests/test_core.py        # exits non-zero on any failure
"""
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "agent"))
import orbit_agent as oa

_results = []
def eq(name, got, want):
    ok = got == want
    _results.append(ok)
    print(("PASS" if ok else "FAIL"), name, "" if ok else f"(got {got!r}, want {want!r})")


def test_classify():
    eq("dns by dst port", oa.classify(50000, 53, "udp"), "dns")
    eq("dns by src port", oa.classify(53, 50000, "tcp"), "dns")
    eq("tls 443", oa.classify(50000, 443, "tcp"), "tls")
    eq("tls 8443", oa.classify(8443, 50000, "tcp"), "tls")
    eq("plain tcp", oa.classify(50000, 80, "tcp"), "tcp")
    eq("quic 443/udp", oa.classify(50000, 443, "udp"), "quic")
    eq("plain udp", oa.classify(50000, 5000, "udp"), "udp")
    eq("icmp passthrough", oa.classify(0, 0, "icmp"), "icmp")
    eq("other passthrough", oa.classify(0, 0, "other"), "other")


def test_seq_lt_wraparound():
    lt = oa.Aggregator._seq_lt
    eq("normal before", lt(0, 100), True)
    eq("normal after", lt(100, 0), False)
    eq("equal is not strictly before", lt(42, 42), False)
    eq("wraps forward across 2^32", lt(0xFFFFFFF0, 0x10), True)
    eq("just-before half range", lt(0, 0x7FFFFFFF), True)
    eq("exactly half range is ambiguous (not before)", lt(0, 0x80000000), False)


def test_iter_ticks_resilience():
    lines = [
        '{"orbit":"rec","v":1}',     # header
        '{"t":1,"up":10}',           # good
        'CORRUPT MIDDLE LINE',       # corrupt but newline-terminated -> skip
        '{"t":2,"up":20}',           # good
        '{"t":3,"up":30',            # truncated final line (no newline) -> stop
    ]
    text = "\n".join(lines[:-1]) + "\n" + lines[-1]
    f = io.StringIO(text)
    header, first = oa._read_rec_header(f)
    eq("header parsed", header.get("orbit"), "rec")
    eq("header consumes its own line (no first data)", first, None)
    ticks = list(oa._iter_ticks(f, first))
    eq("skips corrupt middle, stops at truncated tail", ticks, [{"t": 1, "up": 10}, {"t": 2, "up": 20}])

    # headerless file: first line is already a data tick
    f2 = io.StringIO('{"t":9,"up":1}\n{"t":10,"up":2}\n')
    h2, first2 = oa._read_rec_header(f2)
    eq("headerless -> empty header", h2, {})
    eq("headerless -> first line returned as data", first2, '{"t":9,"up":1}')
    eq("headerless replays fully", list(oa._iter_ticks(f2, first2)),
       [{"t": 9, "up": 1}, {"t": 10, "up": 2}])


def test_origin_ok():
    ok = oa._origin_ok
    eq("localhost allowed", ok("http://localhost:8420", 8420), True)
    eq("127.0.0.1 allowed", ok("http://127.0.0.1:8420", 8420), True)
    eq("ipv6 loopback allowed", ok("http://[::1]:8420", 8420), True)
    eq("foreign origin rejected", ok("http://evil.example", 8420), False)
    eq("wrong port rejected (rebinding)", ok("http://localhost:9999", 8420), False)
    eq("https scheme rejected (agent is http)", ok("https://localhost:8420", 8420), False)


if __name__ == "__main__":
    test_classify()
    test_seq_lt_wraparound()
    test_iter_ticks_resilience()
    test_origin_ok()
    bad = _results.count(False)
    print(f"\n{'ALL PASS' if not bad else str(bad) + ' FAILED'} ({_results.count(True)}/{len(_results)})")
    sys.exit(1 if bad else 0)

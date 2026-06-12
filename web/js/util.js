export const PROTO_COLORS = {
  tls: "#22d3ee",
  quic: "#e879f9",
  dns: "#fbbf24",
  tcp: "#60a5fa",
  udp: "#a78bfa",
  icmp: "#f87171",
  other: "#64748b",
};

export function protoColor(p) {
  return PROTO_COLORS[p] || PROTO_COLORS.other;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function fmtBytes(n) {
  let i = 0;
  while (n >= 1024 && i < BYTE_UNITS.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${BYTE_UNITS[i]}`;
}

/* bytes/sec -> ["12.4", "Mbps"] */
export function fmtRate(bytesPerSec) {
  let bits = bytesPerSec * 8;
  const units = ["bps", "Kbps", "Mbps", "Gbps"];
  let i = 0;
  while (bits >= 1000 && i < units.length - 1) { bits /= 1000; i++; }
  const num = bits >= 100 || i === 0 ? Math.round(bits).toString() : bits.toFixed(1);
  return [num, units[i]];
}

export function fmtRateStr(bytesPerSec) {
  const [n, u] = fmtRate(bytesPerSec);
  return `${n} ${u}`;
}

/* stable 32-bit hash for angle placement */
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function timeHMS(ms) {
  return new Date(ms).toTimeString().slice(0, 8);
}

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

/* Escape a string for safe interpolation into innerHTML / attributes. Every
   string Orbit renders that originates off-host is untrusted: passively-observed
   DNS/PTR names, AS-org strings from the .mmdb, process names, and any field of
   a replay recording. A crafted name like <img src=x onerror=…> would otherwise
   execute script in this privileged localhost page. Always route such values
   through esc() before they reach innerHTML. */
export function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

/* 2-letter country code -> flag emoji (regional indicator pair). Rendered via
   the bundled Twemoji flag font so it shows on Windows too. "" if invalid. */
export function flagEmoji(cc) {
  if (typeof cc !== "string" || cc.length !== 2) return "";
  const A = "A".charCodeAt(0);
  const a = cc.toUpperCase().charCodeAt(0) - A;
  const b = cc.toUpperCase().charCodeAt(1) - A;
  if (a < 0 || a > 25 || b < 0 || b > 25) return "";
  return String.fromCodePoint(0x1f1e6 + a) + String.fromCodePoint(0x1f1e6 + b);
}

export function timeHMS(ms) {
  return new Date(ms).toTimeString().slice(0, 8);
}

/* elapsed milliseconds -> compact "2h 5m" / "45s" */
export function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (!(s > 0)) return "0s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

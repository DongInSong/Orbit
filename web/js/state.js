import { hashStr } from "./util.js";

const EMA_A = 0.22;          // smoothing for displayed rates
const HOST_TTL = 75_000;     // drop a host after this much silence
const CHART_LEN = 1200;      // 120s at 10Hz
const HIST_LEN = 600;        // per-host sparkline, 60s at 10Hz
const ALERT_GLOW_MS = 12_000;

export const state = {
  mode: "…",
  iface: "",
  rateDown: 0,               // EMA bytes/sec
  rateUp: 0,
  pps: 0,
  totals: { up: 0, down: 0, pkts: 0 },
  hosts: new Map(),          // ip -> host record
  names: new Map(),          // ip -> domain
  chartDown: new Float32Array(CHART_LEN),
  chartUp: new Float32Array(CHART_LEN),
  chartHead: 0,
  lastTickAt: 0,
  pinnedIp: null,
  highlightIp: null,         // set while a sidebar row is hovered
};

const GOLDEN = Math.PI * (3 - Math.sqrt(5));   // ~2.4 rad — evenly fills the ring
let hostSeq = 0;

function hostRecord(ip, name) {
  const h = hashStr(ip);
  return {
    ip,
    name: name || state.names.get(ip) || null,
    angle: hostSeq++ * GOLDEN + ((h % 100) / 100 - 0.5) * 0.22,
    rJitter: ((h >>> 12) % 1000) / 1000,        // 0..1 radius variance
    emaDown: 0,
    emaUp: 0,
    proto: "other",
    proc: null,
    cc: null,                                    // ISO-2 country (DB-IP)
    country: null,                               // localized country name
    asn: null,                                   // autonomous system number
    org: null,                                   // AS organization name
    lastSeen: 0,
    glow: 0,                                     // activity flash, decays per frame
    firstSeen: Date.now(),
    totalUp: 0,
    totalDown: 0,
    ports: new Set(),
    hist: new Float32Array(HIST_LEN),
    histHead: 0,
    alertUntil: 0,
    alertType: null,
  };
}

function pushHist(h) {
  h.hist[h.histHead] = h.emaDown + h.emaUp;
  h.histHead = (h.histHead + 1) % HIST_LEN;
}

/* Returns { flows: [{host, down, up, proto}], alerts: [...] } */
export function applyTick(tick) {
  const now = performance.now();
  state.lastTickAt = now;
  state.totals = tick.totals;
  state.pps = tick.pps;

  state.rateDown += ((tick.down * 10) - state.rateDown) * EMA_A;
  state.rateUp += ((tick.up * 10) - state.rateUp) * EMA_A;

  state.chartDown[state.chartHead] = tick.down * 10;
  state.chartUp[state.chartHead] = tick.up * 10;
  state.chartHead = (state.chartHead + 1) % CHART_LEN;

  for (const d of tick.dns) state.names.set(d.ip, d.q);

  const flows = [];
  const touched = new Set();
  for (const th of tick.hosts) {
    touched.add(th.ip);
    let h = state.hosts.get(th.ip);
    if (!h) {
      h = hostRecord(th.ip, th.name);
      state.hosts.set(th.ip, h);
    }
    if (th.name) h.name = th.name;
    else if (!h.name && state.names.has(th.ip)) h.name = state.names.get(th.ip);
    if (th.cc) h.cc = th.cc;
    if (th.country) h.country = th.country;
    if (th.asn != null) h.asn = th.asn;          // keep AS0 distinct from absent
    if (th.org) h.org = th.org;
    h.emaDown += ((th.down * 10) - h.emaDown) * EMA_A;
    h.emaUp += ((th.up * 10) - h.emaUp) * EMA_A;
    h.proto = th.proto;
    if (th.proc) h.proc = th.proc;
    h.totalDown += th.down;
    h.totalUp += th.up;
    h.lastSeen = now;
    h.glow = 1;
    pushHist(h);
    flows.push({ host: h, down: th.down, up: th.up, proto: th.proto });
  }

  for (const c of tick.conns) {
    const h = state.hosts.get(c.ip);
    if (h) {
      if (h.ports.size < 64) h.ports.add(c.port);
      if (c.proc && !h.proc) h.proc = c.proc;
    }
  }

  for (const a of tick.alerts || []) {
    const h = state.hosts.get(a.ip);
    if (h) {
      h.alertUntil = now + ALERT_GLOW_MS;
      h.alertType = a.type;
    }
    a.name = a.name || state.names.get(a.ip) || null;
  }

  for (const [ip, h] of state.hosts) {
    if (!touched.has(ip)) {
      h.emaDown *= 0.86;
      h.emaUp *= 0.86;
      pushHist(h);
      if (now - h.lastSeen > HOST_TTL && ip !== state.pinnedIp) {
        state.hosts.delete(ip);
      }
    }
  }

  return { flows, alerts: tick.alerts || [] };
}

export function topHosts(n) {
  return [...state.hosts.values()]
    .sort((a, b) => (b.emaDown + b.emaUp) - (a.emaDown + a.emaUp))
    .slice(0, n);
}

export function hostLabel(h) {
  return h.name || h.ip;
}

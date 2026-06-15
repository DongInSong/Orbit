/* Chart scrubber — replay or save the buffered ~120s window from a selected
   point. 100% frontend; the agent is never paused. During replay the chart is
   frozen and the galaxy is driven from a snapshot of the selected ticks, paced
   exactly like the backend's --replay (so it looks identical). */

import { state, applyTick, rawTickAt } from "./state.js";

const TICK_MS = 100, CLAMP_MS = 1000;   // mirror backend TICK_SEC=0.1 / REC_CLAMP_HI=1.0

export const scrub = { replaying: false };

let deps = null, timer = 0;
let frames = [], idx = 0, baseIdx = 0, speed = 1, savedHosts = null;

export function initScrub(d) { deps = d; }   // {radial, addConns, showAlerts, chart, updateHeader, requestRedraw}

export function startReplay(startIdx, endIdx) {
  clearTimeout(timer);
  if (savedHosts) { state.hosts = savedHosts; savedHosts = null; }   // recover a prior replay
  frames = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const s = rawTickAt(i);                 // snapshot refs now — decoupled from the live ring
    if (s != null) frames.push(s);
  }
  if (!frames.length) return;
  scrub.replaying = true; idx = 0; baseIdx = startIdx; speed = 1;
  savedHosts = state.hosts; state.hosts = new Map();   // O(1) set-aside; replay can't pollute live stats
  deps.chart.setSelection(startIdx, endIdx);
  enterReplayUI();
  step();
}

function step() {
  if (!scrub.replaying || idx >= frames.length) return finish();
  let tick;
  try { tick = JSON.parse(frames[idx]); } catch { idx++; return step(); }
  const { flows, alerts } = applyTick(tick);    // no raw → galaxy only, chart ring frozen
  deps.radial.spawnFlows(flows);
  deps.addConns(tick.conns || [], tick.t);
  if (alerts.length) deps.showAlerts(alerts);
  deps.chart.setPlayhead(baseIdx + idx);
  deps.updateHeader();
  deps.requestRedraw();

  let delay = TICK_MS;
  if (idx + 1 < frames.length) {
    try {
      const t = tick.t, nt = JSON.parse(frames[idx + 1]).t;
      if (typeof t === "number" && typeof nt === "number") {
        const d = nt - t;
        delay = (d >= 0 && d <= CLAMP_MS) ? d : TICK_MS;
      }
    } catch { /* keep default pacing */ }
  }
  idx++;
  timer = setTimeout(step, delay / speed);
}

function finish() {
  clearTimeout(timer); timer = 0;
  if (!scrub.replaying) return;
  scrub.replaying = false;
  if (savedHosts) { state.hosts = savedHosts; savedHosts = null; }   // restore the live galaxy
  deps.chart.clearScrub();
  exitReplayUI();
  frames = [];
  deps.requestRedraw();
}

export function stopReplay() { finish(); }

/* full reset — replay off, markers cleared, scrub bar hidden (called on (re)hello) */
export function resetScrub() {
  finish();
  deps.chart.clearScrub();
  const bar = document.getElementById("scrub-bar");
  if (bar) bar.hidden = true;
}

/* ---- save the selected window to a backend-replayable .jsonl ---- */

function stripType(s) {
  // live frames are '{"type":"tick",...}'; backend recordings omit "type".
  // strip it with a slice (no re-serialize → no float/key-order drift).
  const P = '{"type":"tick",';
  return s.startsWith(P) ? "{" + s.slice(P.length) : s;
}

export function saveRange(startIdx, endIdx) {
  let started;
  try { started = JSON.parse(rawTickAt(startIdx)).t; } catch { started = 0; }
  const lines = [JSON.stringify({
    orbit: "rec", v: 1, mode: state.mode, iface: state.iface || "buffered", started,
  })];
  for (let i = startIdx; i <= endIdx; i++) {
    const s = rawTickAt(i);
    if (s != null) lines.push(stripType(s));
  }
  if (lines.length < 2) return;
  const blob = new Blob([lines.join("\n") + "\n"], { type: "application/x-ndjson" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `orbit-${state.mode}-${stamp()}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function stamp() {   // YYYYMMDDHHMMSS
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/* ---- buffered-replay badge, distinct from the agent's own mode ---- */

function enterReplayUI() {
  const b = document.getElementById("mode-badge");
  if (b) { b.dataset.live = b.textContent; b.dataset.cls = b.className;
           b.textContent = "REPLAY ◷"; b.className = "badge replay buffered"; }
  const live = document.getElementById("scrub-live");
  if (live) live.hidden = false;
  const panel = document.getElementById("chart-panel");
  if (panel) panel.classList.add("replaying");
}

function exitReplayUI() {
  const b = document.getElementById("mode-badge");
  if (b && b.dataset.cls !== undefined) { b.textContent = b.dataset.live; b.className = b.dataset.cls; }
  const live = document.getElementById("scrub-live");
  if (live) live.hidden = true;
  const panel = document.getElementById("chart-panel");
  if (panel) panel.classList.remove("replaying");
}

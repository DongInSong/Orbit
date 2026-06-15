/* Chart scrubber — replay or save the buffered ~120s window from a selected
   point. 100% frontend; the agent is never paused.

   Selecting a region freezes the chart (state.chartFreeze) so it stops scrolling
   while you adjust/replay; live ticks keep being measured into the buffer + a
   background live galaxy. Replay locks the selection (click inside to seek) and,
   when it reaches the end, parks there paused (it does NOT auto-clear). Exiting
   (↺ LIVE / ✕) unfreezes → the chart catches up and the galaxy returns to now.
   Pacing mirrors the backend's --replay exactly. */

import { state, applyTick, rawTickAt, freezeChart } from "./state.js";
import { clamp } from "./util.js";

const TICK_MS = 100, CLAMP_MS = 1000;   // mirror backend TICK_SEC=0.1 / REC_CLAMP_HI=1.0

export const scrub = { replaying: false };

let deps = null, timer = 0;
let frames = [], idx = 0, baseIdx = 0, speed = 1, paused = false, ended = false, savedHosts = null;

export function initScrub(d) { deps = d; }   // {radial, addConns, showAlerts, chart, updateHeader, requestRedraw}

export function startReplay(startIdx, endIdx) {
  clearTimeout(timer);
  if (savedHosts) { state.hosts = savedHosts; savedHosts = null; }   // recover a prior replay
  frames = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const s = rawTickAt(i);                 // reads the frozen snapshot — aligned with the display
    if (s != null) frames.push(s);
  }
  if (!frames.length) return;
  scrub.replaying = true; idx = 0; baseIdx = startIdx; speed = 1; paused = false; ended = false;
  savedHosts = state.hosts; state.hosts = new Map();   // O(1) set-aside; replay can't pollute live stats
  if (!state.chartFreeze) freezeChart();               // normally already frozen from the pick
  deps.chart.setSelection(startIdx, endIdx);
  deps.chart.setLocked(true);
  enterReplayUI();
  step();
}

function renderTick(tick, phIdx) {
  const { flows, alerts } = applyTick(tick);    // replay Map; no raw → chart ring untouched
  deps.radial.spawnFlows(flows);
  deps.addConns(tick.conns || [], tick.t);
  if (alerts.length) deps.showAlerts(alerts);
  deps.chart.setPlayhead(phIdx);
  deps.updateHeader();
  deps.requestRedraw();
}

function step() {
  if (!scrub.replaying || paused) return;
  if (idx >= frames.length) {                // reached the end → park here, stay locked/frozen
    ended = true; paused = true;
    idx = frames.length - 1;
    deps.chart.setPlayhead(baseIdx + idx);
    setPauseUI();
    deps.requestRedraw();
    return;
  }
  let tick;
  try { tick = JSON.parse(frames[idx]); } catch { idx++; return step(); }
  renderTick(tick, baseIdx + idx);

  let delay = TICK_MS;
  if (idx + 1 < frames.length) {
    try {
      const nt = JSON.parse(frames[idx + 1]).t;
      if (typeof tick.t === "number" && typeof nt === "number") {
        const d = nt - tick.t;
        delay = (d >= 0 && d <= CLAMP_MS) ? d : TICK_MS;
      }
    } catch { /* keep default pacing */ }
  }
  idx++;
  timer = setTimeout(step, delay / speed);
}

/* jump the playback cursor to a chart index inside the locked selection */
export function seek(chartIdx) {
  if (!scrub.replaying) return;
  clearTimeout(timer);
  ended = false;
  idx = clamp(chartIdx - baseIdx, 0, frames.length - 1);
  let tick;
  try { tick = JSON.parse(frames[idx]); } catch { return; }
  renderTick(tick, baseIdx + idx);
  idx++;
  setPauseUI();
  if (!paused) timer = setTimeout(step, TICK_MS / speed);
}

export function togglePause() {
  if (!scrub.replaying) return;
  if (ended) { restart(); return; }      // at the end → "↻ AGAIN" replays from the start
  paused = !paused;
  setPauseUI();
  if (paused) clearTimeout(timer);
  else step();
}

export function restart() {
  if (!scrub.replaying) return;
  clearTimeout(timer);
  ended = false; paused = false; idx = 0;
  setPauseUI();
  step();
}

/* live ticks during replay: keep measuring (buffer + background live galaxy)
   without disturbing the frozen replay display */
export function measureLive(msg, raw) {
  if (!scrub.replaying || !savedHosts) return;
  const disp = state.hosts;
  const g = { rd: state.rateDown, ru: state.rateUp, pps: state.pps,
              tot: state.totals, ss: state.staleSince };
  state.hosts = savedHosts;
  applyTick(msg, raw);                 // updates savedHosts + chart ring + rawTicks
  savedHosts = state.hosts;
  state.hosts = disp;                  // restore the replay display
  // replay owns the header/center during replay — restore display globals
  state.rateDown = g.rd; state.rateUp = g.ru; state.pps = g.pps;
  state.totals = g.tot; state.staleSince = g.ss;
}

function finish() {
  clearTimeout(timer); timer = 0;
  if (!scrub.replaying) return;
  scrub.replaying = false; paused = false; ended = false;
  if (savedHosts) { state.hosts = savedHosts; savedHosts = null; }   // restore the live galaxy
  deps.chart.setLocked(false);
  deps.chart.clearScrub();             // clears selection + unfreezes → chart catches up
  exitReplayUI();
  hideBar();
  frames = [];
  deps.requestRedraw();
}

export function stopReplay() { finish(); }

/* full reset — clears any selection (replaying or not), unfreezes, hides the bar.
   Called by the ✕ button and on a (re)hello. */
export function resetScrub() {
  finish();                            // exit replay if active
  deps.chart.clearScrub();             // clear a selection that was made but not replayed
  hideBar();
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

/* ---- transport UI: buffered-replay badge + play/pause/restart/live ---- */

function hideBar() { const b = document.getElementById("scrub-bar"); if (b) b.hidden = true; }

function setBtn(id, opts) {
  const el = document.getElementById(id);
  if (!el) return;
  if (opts.text !== undefined) el.textContent = opts.text;
  if (opts.hidden !== undefined) el.hidden = opts.hidden;
}

function setPauseUI() {
  setBtn("scrub-play", { text: ended ? "↻ AGAIN" : paused ? "▶ RESUME" : "❚❚ PAUSE" });
}

function enterReplayUI() {
  const b = document.getElementById("mode-badge");
  if (b) { b.dataset.live = b.textContent; b.dataset.cls = b.className;
           b.textContent = "REPLAY ◷"; b.className = "badge replay buffered"; }
  setPauseUI();
  setBtn("scrub-restart", { hidden: false });
  setBtn("scrub-live", { hidden: false });
  setBtn("scrub-save", { hidden: true });        // declutter while replaying
  const panel = document.getElementById("chart-panel");
  if (panel) panel.classList.add("replaying");
}

function exitReplayUI() {
  const b = document.getElementById("mode-badge");
  if (b && b.dataset.cls !== undefined) { b.textContent = b.dataset.live; b.className = b.dataset.cls; }
  setBtn("scrub-play", { text: "▶ REPLAY" });
  setBtn("scrub-restart", { hidden: true });
  setBtn("scrub-live", { hidden: true });
  setBtn("scrub-save", { hidden: false });
  const panel = document.getElementById("chart-panel");
  if (panel) panel.classList.remove("replaying");
}

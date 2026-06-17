import { state, applyTick } from "./state.js";
import { initRadial, tooltipHTML } from "./radial.js";
import { initChart } from "./chart.js";
import { renderHosts, addConns, showAlerts } from "./panels.js";
import { fmtRate, fmtBytes, fmtDur, PROTO_COLORS } from "./util.js";
import { copyHost } from "./toast.js";
import { pin, render as renderFocus } from "./focus.js";
import { initStarfield } from "./starfield.js";
import { scrub, initScrub, startReplay, stopReplay, saveRange, resetScrub,
         measureLive, seek, togglePause, restart, resizeRange, setTiming } from "./scrub.js";

const $ = id => document.getElementById(id);

window.__orbit = state;   // debug/test handle

const mapPanel = $("map-panel");
initStarfield(mapPanel, $("star-canvas"));
const radial = initRadial(mapPanel, $("trail-canvas"), $("node-canvas"));
let chartDirty = true;
const chart = initChart($("chart-panel"), $("chart-canvas"), $("chart-scale"),
                        () => { chartDirty = true; });
const tooltip = $("tooltip");
const overlay = $("overlay");

radial.onNodeClick((host, e) => copyHost(host.ip, host.name, e.shiftKey));
radial.onNodePin(host => pin(host));

/* ----------------------------------------------------------- chart scrubber */

initScrub({ radial, addConns, showAlerts, chart, updateHeader,
            requestRedraw: () => { chartDirty = true; } });

let curSel = null;
chart.onPick(sel => {
  curSel = sel;
  const ticks = sel.endIdx - sel.startIdx + 1;
  $("scrub-sel").textContent = `${(ticks / 10).toFixed(1)}s · ${ticks} ticks`;
  $("scrub-bar").hidden = false;
  $("chart-hint").hidden = true;
});
chart.onSeek(i => seek(i));
chart.onResize(sel => resizeRange(sel.startIdx, sel.endIdx));
$("scrub-play").onclick = () => {
  if (scrub.replaying) togglePause();
  else if (curSel) startReplay(curSel.startIdx, curSel.endIdx);
};
$("scrub-restart").onclick = () => restart();
$("scrub-save").onclick = () => { if (curSel) saveRange(curSel.startIdx, curSel.endIdx); };
$("scrub-live").onclick = () => { stopReplay(); curSel = null; $("chart-hint").hidden = false; };
$("scrub-clear").onclick = () => { resetScrub(); curSel = null; $("chart-hint").hidden = false; };

/* onboarding help */
const helpOverlay = $("help-overlay");
const closeHelp = () => { helpOverlay.hidden = true; try { localStorage.setItem("orbit-help-seen", "1"); } catch {} };
$("help-btn").onclick = () => { helpOverlay.hidden = false; };
$("help-close").onclick = closeHelp;
helpOverlay.addEventListener("click", e => { if (e.target === helpOverlay) closeHelp(); });
try { if (!localStorage.getItem("orbit-help-seen")) helpOverlay.hidden = false; } catch {}

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (!helpOverlay.hidden) { closeHelp(); return; }
  resetScrub(); curSel = null; $("chart-hint").hidden = false;
});

$("legend").innerHTML = Object.entries(PROTO_COLORS)
  .map(([p, c]) => `<span><i style="color:${c};background:${c}"></i>${p.toUpperCase()}</span>`)
  .join("");

/* ------------------------------------------------------------- websocket */

let wsFails = 0;
const WS_GIVEUP = 4;          // ~6s of failed reconnects -> the backend is gone

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);

  ws.onopen = () => { wsFails = 0; };

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === "hello") {
      resetScrub(); curSel = null;        // tear down any replay/selection before re-badging
      const mode = msg.mode || "live";
      state.mode = mode;
      state.iface = msg.iface;
      // timing contract: derive replay pacing from the backend; warn if the
      // chart's baked-in 10Hz assumption (rate × factor / ring length) drifted
      if (msg.tick_hz) {
        setTiming(msg.tick_hz, msg.clamp_ms);
        if (msg.tick_hz !== 10)
          console.warn(`Orbit: backend tick_hz=${msg.tick_hz}; chart assumes 10Hz — rates and the 120s window will be off.`);
      }
      const badge = $("mode-badge");
      badge.textContent = mode.toUpperCase();
      badge.className = `badge ${mode}`;
      $("iface-label").textContent =
        mode === "live" ? msg.iface
        : mode === "replay" ? (msg.iface || "recorded session")
        : "synthetic traffic";
      overlay.classList.add("hidden");
      return;
    }
    if (msg.type === "iface") {           // capture auto-followed to a new adapter
      state.iface = msg.iface;
      $("iface-label").textContent = msg.iface;
      return;
    }
    if (scrub.replaying) {                // keep measuring (buffer + bg galaxy), display frozen
      measureLive(msg, e.data);
      chartDirty = true;
      return;
    }
    const { flows, alerts } = applyTick(msg, e.data);
    radial.spawnFlows(flows);
    addConns(msg.conns, msg.t);
    if (alerts.length) showAlerts(alerts, msg.t);
    chartDirty = true;
    updateHeader();
  };

  ws.onclose = () => {
    wsFails++;
    overlay.classList.remove("hidden");
    // backend gone for good: close our own window (works in the chromeless --app
    // window; a normal browser tab blocks window.close(), so it just keeps trying).
    if (wsFails === WS_GIVEUP) window.close();
    overlay.querySelector("p").textContent = wsFails >= WS_GIVEUP
      ? "Orbit stopped."
      : "agent disconnected — reconnecting…";
    setTimeout(connect, wsFails >= WS_GIVEUP ? 3000 : 1500);
  };
}
connect();

/* ---------------------------------------------------------------- header */

function updateHeader() {
  const [dn, du] = fmtRate(state.rateDown);
  const [un, uu] = fmtRate(state.rateUp);
  $("rate-down").textContent = dn;
  $("rate-down-u").textContent = du;
  $("rate-up").textContent = un;
  $("rate-up-u").textContent = uu;
  $("pps").textContent = state.pps.toLocaleString();
  $("host-count").textContent = state.hosts.size;
  const lossEl = $("loss");
  lossEl.textContent = state.lossPct;
  lossEl.classList.toggle("hot", state.lossPct >= 1);
  $("total-session").textContent = fmtBytes(state.totals.up + state.totals.down);
  $("session-dur").textContent = state.totals.since ? fmtDur(Date.now() - state.totals.since) : "—";
}

/* ------------------------------------------------------------ render loop */

let lastNow = performance.now();
let lastPanelAt = 0;

function loop(now) {
  const dt = Math.min(now - lastNow, 100);
  lastNow = now;

  const hovered = radial.frame(now, dt);
  $("node-canvas").style.cursor = hovered ? "pointer" : "default";

  if (hovered) {
    tooltip.hidden = false;
    tooltip.innerHTML = tooltipHTML(hovered.host);
    // measure the (variable-height) tooltip and keep it fully inside the map
    // panel — otherwise tall/edge ones get clipped behind the sidebar/chart
    const W = mapPanel.clientWidth, H = mapPanel.clientHeight;
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let left = hovered.x + 16;
    if (left + tw > W - 4) left = hovered.x - tw - 16;   // flip to the left of the cursor
    left = Math.max(4, Math.min(left, W - tw - 4));
    let top = Math.max(4, Math.min(hovered.y + 12, H - th - 6));
    tooltip.style.left = `${left}px`;
    tooltip.style.right = "";
    tooltip.style.top = `${top}px`;
  } else {
    tooltip.hidden = true;
  }

  if (chartDirty) {
    chart.frame();
    chartDirty = false;
  }

  if (now - lastPanelAt > 500) {
    lastPanelAt = now;
    renderHosts();
    renderFocus();
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

import { state, applyTick } from "./state.js";
import { initRadial, tooltipHTML } from "./radial.js";
import { initChart } from "./chart.js";
import { renderHosts, addConns, showAlerts } from "./panels.js";
import { fmtRate, fmtBytes, PROTO_COLORS } from "./util.js";
import { copyHost } from "./toast.js";
import { pin, render as renderFocus } from "./focus.js";
import { initStarfield } from "./starfield.js";

const $ = id => document.getElementById(id);

window.__orbit = state;   // debug/test handle

const mapPanel = $("map-panel");
initStarfield(mapPanel, $("star-canvas"));
const radial = initRadial(mapPanel, $("trail-canvas"), $("node-canvas"));
const chart = initChart($("chart-panel"), $("chart-canvas"), $("chart-scale"));
const tooltip = $("tooltip");
const overlay = $("overlay");

radial.onNodeClick((host, e) => copyHost(host.ip, host.name, e.shiftKey));
radial.onNodePin(host => pin(host));

$("legend").innerHTML = Object.entries(PROTO_COLORS)
  .map(([p, c]) => `<span><i style="color:${c};background:${c}"></i>${p.toUpperCase()}</span>`)
  .join("");

/* ------------------------------------------------------------- websocket */

let chartDirty = true;

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);

  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === "hello") {
      const mode = msg.mode || "live";
      state.mode = mode;
      state.iface = msg.iface;
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
    const { flows, alerts } = applyTick(msg);
    radial.spawnFlows(flows);
    addConns(msg.conns, msg.t);
    if (alerts.length) showAlerts(alerts);
    chartDirty = true;
    updateHeader();
  };

  ws.onclose = () => {
    overlay.classList.remove("hidden");
    overlay.querySelector("p").textContent = "agent disconnected — reconnecting…";
    setTimeout(connect, 1500);
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
  $("total-session").textContent = fmtBytes(state.totals.up + state.totals.down);
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
    const flipX = hovered.x > mapPanel.clientWidth - 230;
    tooltip.style.left = flipX ? "" : `${hovered.x + 16}px`;
    tooltip.style.right = flipX ? `${mapPanel.clientWidth - hovered.x + 16}px` : "";
    tooltip.style.top = `${Math.min(hovered.y + 12, mapPanel.clientHeight - 90)}px`;
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

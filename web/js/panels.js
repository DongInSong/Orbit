import { state, topHosts, hostLabel } from "./state.js";
import { protoColor, fmtRateStr, timeHMS, flagEmoji, esc } from "./util.js";
import { toast } from "./toast.js";
import { pin } from "./focus.js";

const HOST_ROWS = 16;
const CONN_ROWS = 60;

const hostList = document.getElementById("host-list");
const connList = document.getElementById("conn-list");

for (const list of [hostList, connList]) {
  list.addEventListener("click", e => {
    const row = e.target.closest("[data-ip]");
    if (!row) return;
    const h = state.hosts.get(row.dataset.ip);
    if (h) pin(h);
    else toast(`inactive host <b>${esc(row.dataset.ip)}</b>`);
  });
  list.addEventListener("mouseover", e => {
    const row = e.target.closest("[data-ip]");
    state.highlightIp = row ? row.dataset.ip : null;
  });
  list.addEventListener("mouseleave", () => { state.highlightIp = null; });
}

/* Rebuilding rows under a resting cursor can drop the highlight — re-resolve
   from :hover one frame later, after the browser re-hit-tests the cursor. */
function syncHighlight(list) {
  requestAnimationFrame(() => {
    const hov = list.querySelector("[data-ip]:hover");
    if (hov) state.highlightIp = hov.dataset.ip;
  });
}

export function renderHosts() {
  const hosts = topHosts(HOST_ROWS);
  const maxEma = Math.max(1, ...hosts.map(h => h.emaDown + h.emaUp));
  const html = hosts.map(h => {
    const total = h.emaDown + h.emaUp;
    const w = Math.max(1.5, (total / maxEma) * 100);
    const dShare = total > 0 ? h.emaDown / total : 0.5;
    const ipSub = h.name ? `<small>${esc(h.ip)}</small>` : "";
    const ccTag = h.cc ? `<span class="flag h-flag" title="${esc(h.country || h.cc)} (${esc(h.cc)})">${flagEmoji(h.cc)}</span>` : "";
    return `<div class="host-row" data-ip="${esc(h.ip)}" data-name="${esc(h.name || "")}" title="click for details">
      <i class="h-dot" style="color:${protoColor(h.proto)};background:${protoColor(h.proto)}"></i>
      <div class="h-name">${ccTag}${esc(hostLabel(h))}${ipSub}</div>
      <div class="h-rate"><span class="d">▼${fmtRateStr(h.emaDown)}</span> <span class="u">▲${fmtRateStr(h.emaUp)}</span></div>
      <div class="h-bar" style="width:${w}%">
        <i class="bd" style="width:${dShare * 100}%"></i><i class="bu" style="width:${(1 - dShare) * 100}%"></i>
      </div>
    </div>`;
  }).join("");
  hostList.innerHTML = html;
  syncHighlight(hostList);
}

export function addConns(conns, tickTime) {
  if (!conns.length) return;
  const frag = document.createDocumentFragment();
  for (const c of conns) {
    const name = c.name || state.names.get(c.ip) || c.ip;
    const row = document.createElement("div");
    row.className = "conn-row";
    row.dataset.ip = c.ip;
    if (c.name || state.names.get(c.ip)) row.dataset.name = c.name || state.names.get(c.ip);
    row.title = "click for details";
    row.innerHTML = `<time>${timeHMS(tickTime)}</time>
      <span class="c-name" title="${esc(c.ip)}">${esc(name)}</span>
      ${c.proc ? `<span class="c-proc">${esc(c.proc)}</span>` : ""}
      <span class="c-port">:${esc(c.port)}</span>
      <span class="c-proto" style="color:${protoColor(c.proto)}">${esc(String(c.proto).toUpperCase())}</span>
      <span class="c-dir ${c.dir === "up" ? "up" : "down"}">${c.dir === "up" ? "▲" : "▼"}</span>`;
    frag.appendChild(row);
  }
  connList.prepend(frag);
  while (connList.childElementCount > CONN_ROWS) connList.lastElementChild.remove();
  syncHighlight(connList);
}

const ALERT_LABEL = {
  scan: "PORT SCAN", dark: "DARK TRAFFIC",
  failed: "CONN FAILED", reset: "CONN REFUSED", unreach: "UNREACHABLE",
  loss: "PACKET LOSS",
};
const alertStrip = document.getElementById("alert-strip");

export function showAlerts(alerts) {
  for (const a of alerts) {
    const el = document.createElement("div");
    el.className = `alert-item ${a.type}`;
    el.innerHTML = `<b>⚠ ${esc(ALERT_LABEL[a.type] || String(a.type).toUpperCase())}</b>
      <span>${esc(a.name || a.ip)}</span><i>${esc(a.detail)}</i>`;
    alertStrip.prepend(el);
    setTimeout(() => el.classList.add("fade"), 9000);
    setTimeout(() => el.remove(), 9700);
  }
  while (alertStrip.childElementCount > 4) alertStrip.lastElementChild.remove();
}

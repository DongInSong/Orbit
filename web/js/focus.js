import { state } from "./state.js";
import { protoColor, fmtRateStr, fmtBytes, timeHMS, flagEmoji } from "./util.js";
import { copyHost } from "./toast.js";

const card = document.getElementById("focus-card");
let pinned = null;            // host record (kept even if it expires from state)

card.addEventListener("click", e => {
  if (e.target.closest(".fc-close")) { unpin(); return; }
  const btn = e.target.closest("[data-copy]");
  if (btn) copyHost(btn.dataset.copy, null, false);
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") unpin();
});

export function pin(host) {
  pinned = host;
  state.pinnedIp = host.ip;
  card.hidden = false;
  render(true);
}

export function unpin() {
  pinned = null;
  state.pinnedIp = null;
  card.hidden = true;
}

/* Called at the panels cadence (every 500ms). */
export function render(structure = false) {
  if (!pinned) return;
  const h = pinned;
  const live = state.hosts.has(h.ip);

  if (structure || !card.querySelector(".fc-spark")) {
    const ports = [...h.ports].sort((a, b) => a - b).slice(0, 12);
    card.innerHTML = `
      <div class="fc-head">
        <i style="color:${protoColor(h.proto)};background:${protoColor(h.proto)}"></i>
        <span class="fc-title">${h.name || h.ip}</span>
        <button class="fc-close" title="close (Esc)">✕</button>
      </div>
      <div class="fc-copy">
        <button data-copy="${h.ip}" title="copy IP">${h.ip} ⧉</button>
        ${h.name ? `<button data-copy="${h.name}" title="copy name">${h.name} ⧉</button>` : ""}
      </div>
      <canvas class="fc-spark" width="272" height="46"></canvas>
      <div class="fc-grid">
        <span>▼ <b class="fc-down"></b></span><span>▲ <b class="fc-up"></b></span>
        <span>total ▼ <b class="fc-tdown"></b></span><span>total ▲ <b class="fc-tup"></b></span>
        <span>protocol <b>${h.proto.toUpperCase()}</b></span>
        <span>${h.proc ? `process <b>${h.proc}</b>` : ""}</span>
        <span>${h.cc ? `location <b><span class="flag">${flagEmoji(h.cc)}</span> ${h.country || h.cc}</b>` : ""}</span>
        <span>${h.org ? `ASN <b>${h.asn != null ? `AS${h.asn} ` : ""}${h.org}</b>` : ""}</span>
      </div>
      ${ports.length ? `<div class="fc-ports">ports ${ports.map(p => `<em>${p}</em>`).join("")}</div>` : ""}
      <div class="fc-foot">
        <span>first seen ${timeHMS(h.firstSeen)}</span>
        <span class="fc-status"></span>
      </div>`;
  }

  card.querySelector(".fc-down").textContent = fmtRateStr(h.emaDown);
  card.querySelector(".fc-up").textContent = fmtRateStr(h.emaUp);
  card.querySelector(".fc-tdown").textContent = fmtBytes(h.totalDown);
  card.querySelector(".fc-tup").textContent = fmtBytes(h.totalUp);
  const status = card.querySelector(".fc-status");
  status.textContent = live ? "● ACTIVE" : "○ INACTIVE";
  status.className = `fc-status ${live ? "on" : "off"}`;
  drawSpark(h);
}

function drawSpark(h) {
  const c = card.querySelector(".fc-spark");
  const ctx = c.getContext("2d");
  const W = c.width, H = c.height;
  const N = h.hist.length;
  let max = 1000;
  for (let i = 0; i < N; i++) if (h.hist[i] > max) max = h.hist[i];

  ctx.clearRect(0, 0, W, H);
  const color = protoColor(h.proto);
  ctx.beginPath();
  ctx.moveTo(0, H);
  for (let i = 0; i < N; i++) {
    const v = h.hist[(h.histHead + i) % N] / max;
    ctx.lineTo((i / (N - 1)) * W, H - 3 - v * (H - 8));
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fillStyle = color + "2a";
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const v = h.hist[(h.histHead + i) % N] / max;
    const x = (i / (N - 1)) * W;
    const y = H - 3 - v * (H - 8);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = "rgba(91,107,130,0.7)";
  ctx.font = "8px ui-monospace, Consolas, monospace";
  ctx.fillText("60s", 4, 10);
}

import { state, topHosts, hostLabel } from "./state.js";
import { protoColor, clamp, fmtRateStr, flagEmoji } from "./util.js";

const MAX_PARTICLES = 650;
const LABELED = 9;
const STALE_MS = 3000;        // zero traffic for this long → "no traffic" state

export function initRadial(container, trailCanvas, nodeCanvas) {
  const tctx = trailCanvas.getContext("2d");
  const nctx = nodeCanvas.getContext("2d");
  let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, R = 0;
  const particles = [];
  let hovered = null;
  let mouseX = -1, mouseY = -1;

  function resize() {
    const oldW = W, oldH = H;
    dpr = window.devicePixelRatio || 1;
    W = container.clientWidth;
    H = container.clientHeight;
    for (const c of [trailCanvas, nodeCanvas]) {
      c.width = W * dpr;
      c.height = H * dpr;
    }
    cx = W / 2;
    cy = H / 2;
    R = Math.min(W, H) * 0.37;
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    nctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // in-flight particles hold paths built for the old geometry — rescale
    // them so they keep converging on the new center instead of the old one
    if (oldW > 0 && oldH > 0 && (oldW !== W || oldH !== H)) {
      const sx = W / oldW, sy = H / oldH;
      for (const p of particles) {
        p.x0 *= sx; p.y0 *= sy;
        p.cpx *= sx; p.cpy *= sy;
        p.x1 *= sx; p.y1 *= sy;
      }
    }
  }
  new ResizeObserver(resize).observe(container);
  resize();

  nodeCanvas.addEventListener("mousemove", e => {
    const r = nodeCanvas.getBoundingClientRect();
    mouseX = e.clientX - r.left;
    mouseY = e.clientY - r.top;
  });
  nodeCanvas.addEventListener("mouseleave", () => { mouseX = mouseY = -1; });

  let clickHandler = null;
  let pinHandler = null;
  nodeCanvas.addEventListener("click", e => {
    if (hovered && clickHandler) clickHandler(hovered.host, e);
  });
  nodeCanvas.addEventListener("contextmenu", e => {
    if (hovered && pinHandler) {
      e.preventDefault();
      pinHandler(hovered.host);
    }
  });

  function nodePos(h) {
    const r = R * (0.86 + 0.26 * h.rJitter);
    return [cx + Math.cos(h.angle) * r, cy + Math.sin(h.angle) * r];
  }

  function nodeSize(h) {
    return clamp(2 + Math.log10(1 + (h.emaDown + h.emaUp) / 800) * 2.6, 2, 8);
  }

  /* photographic star: white core + colored bloom + thin tapering
     diffraction spikes on the brighter ones */
  function drawSpikes(x, y, len, ang, alpha, color) {
    nctx.save();
    nctx.translate(x, y);
    nctx.rotate(ang);
    nctx.lineWidth = 0.9;
    for (const [dx, dy, l] of [[1, 0, len], [-1, 0, len], [0, 1, len * 0.72], [0, -1, len * 0.72]]) {
      const lg = nctx.createLinearGradient(0, 0, dx * l, dy * l);
      lg.addColorStop(0, `rgba(255,255,255,${alpha})`);
      lg.addColorStop(0.3, color + "66");
      lg.addColorStop(1, color + "00");
      nctx.strokeStyle = lg;
      nctx.beginPath();
      nctx.moveTo(0, 0);
      nctx.lineTo(dx * l, dy * l);
      nctx.stroke();
    }
    nctx.restore();
  }

  function spawnFlows(flows) {
    for (const f of flows) {
      const [hx, hy] = nodePos(f.host);
      const color = protoColor(f.proto);
      const bend = (f.host.rJitter - 0.5) * 1.1;          // stable curve direction
      // keep endpoints slightly off the exact center so arrivals don't
      // pile onto one overexposed pixel
      const ex = cx + (hx - cx) * 0.08, ey = cy + (hy - cy) * 0.08;
      for (const [bytes, inbound] of [[f.down, true], [f.up, false]]) {
        if (bytes <= 0) continue;
        const n = clamp(Math.round(Math.log2(1 + bytes / 600)), 1, 5);
        const size = clamp(0.8 + Math.log10(1 + bytes / 900) * 0.7, 0.8, 2.2);
        for (let i = 0; i < n; i++) {
          if (particles.length >= MAX_PARTICLES) return;
          const [x0, y0, x1, y1] = inbound ? [hx, hy, ex, ey] : [ex, ey, hx, hy];
          const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
          const dx = x1 - x0, dy = y1 - y0;
          const spread = (Math.random() - 0.5) * 26;       // stream width
          particles.push({
            x0, y0, x1, y1,
            cpx: mx - dy * (bend * 0.22) + spread,
            cpy: my + dx * (bend * 0.22) + spread,
            t: -Math.random() * 0.45,                      // stagger within ~300ms
            speed: 1 / (650 + Math.random() * 350),        // progress per ms
            size, color, inbound,
          });
        }
      }
    }
  }

  function drawParticles(dt) {
    tctx.globalCompositeOperation = "destination-out";
    tctx.fillStyle = `rgba(0,0,0,${clamp(dt * 0.006, 0.05, 0.35)})`;
    tctx.fillRect(0, 0, W, H);
    tctx.globalCompositeOperation = "lighter";

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += dt * p.speed;
      if (p.t >= 1) { particles.splice(i, 1); continue; }
      if (p.t < 0) continue;
      const u = 1 - p.t;
      const x = u * u * p.x0 + 2 * u * p.t * p.cpx + p.t * p.t * p.x1;
      const y = u * u * p.y0 + 2 * u * p.t * p.cpy + p.t * p.t * p.y1;
      const fade = p.t < 0.12 ? p.t / 0.12 : p.t > 0.78 ? (1 - p.t) / 0.22 : 1;
      tctx.fillStyle = p.color;
      tctx.globalAlpha = 0.09 * fade;
      tctx.beginPath();
      tctx.arc(x, y, p.size * 2.2, 0, 7);
      tctx.fill();
      tctx.globalAlpha = 0.55 * fade;
      tctx.beginPath();
      tctx.arc(x, y, p.size, 0, 7);
      tctx.fill();
    }
    tctx.globalAlpha = 1;
    tctx.globalCompositeOperation = "source-over";
  }

  function drawGuides(now) {
    nctx.strokeStyle = "rgba(96,165,250,0.07)";
    nctx.lineWidth = 1;
    for (const f of [0.55, 0.86, 1.12]) {
      nctx.beginPath();
      nctx.arc(cx, cy, R * f, 0, 7);
      nctx.stroke();
    }
    // slow rotating dashed accent ring
    nctx.save();
    nctx.translate(cx, cy);
    nctx.rotate(now / 14000);
    nctx.setLineDash([3, 46]);
    nctx.strokeStyle = "rgba(34,211,238,0.22)";
    nctx.beginPath();
    nctx.arc(0, 0, R * 1.12, 0, 7);
    nctx.stroke();
    nctx.rotate(-now / 6500);
    nctx.setLineDash([2, 30]);
    nctx.strokeStyle = "rgba(232,121,249,0.13)";
    nctx.beginPath();
    nctx.arc(0, 0, R * 0.55, 0, 7);
    nctx.stroke();
    nctx.restore();
    nctx.setLineDash([]);
  }

  /* hosts owned by the same process form a constellation */
  function drawConstellations() {
    const TAU = Math.PI * 2;
    const groups = new Map();
    for (const h of state.hosts.values()) {
      if (!h.proc || (h.emaDown + h.emaUp) < 150) continue;
      let g = groups.get(h.proc);
      if (!g) groups.set(h.proc, g = []);
      g.push(h);
    }
    nctx.font = "italic 9px ui-monospace, Consolas, monospace";
    for (const [proc, list] of groups) {
      if (list.length < 2) continue;
      list.sort((a, b) => (((a.angle % TAU) + TAU) % TAU) - (((b.angle % TAU) + TAU) % TAU));
      const pts = list.map(nodePos);
      nctx.strokeStyle = "rgba(170,195,235,0.26)";
      nctx.lineWidth = 0.9;
      nctx.setLineDash([3, 5]);
      nctx.beginPath();
      pts.forEach(([px, py], i) => i ? nctx.lineTo(px, py) : nctx.moveTo(px, py));
      nctx.stroke();
      nctx.setLineDash([]);

      const i = (pts.length - 1) >> 1;
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      if (Math.hypot(mx - cx, my - cy) > R * 0.35) {
        nctx.fillStyle = "rgba(165,190,230,0.6)";
        nctx.textAlign = "center";
        nctx.fillText(proc, mx, my - 5);
      }
    }
    nctx.textAlign = "left";
  }

  function drawCenter(now) {
    const stale = state.staleSince && now - state.staleSince > STALE_MS;
    const act = stale ? 0 : clamp((state.rateDown + state.rateUp) / 250000, 0, 1);
    const breath = stale ? 1 : 1 + Math.sin(now / 900) * 0.08;   // freeze when idle
    const r = (7 + act * 4) * breath;
    const hue = stale ? "100,116,139" : "34,211,238";            // cyan → slate

    const g = nctx.createRadialGradient(cx, cy, 0, cx, cy, r * 4.5);
    g.addColorStop(0, `rgba(${hue},0.38)`);
    g.addColorStop(0.35, `rgba(${hue},${0.08 + act * 0.12})`);
    g.addColorStop(1, `rgba(${hue},0)`);
    nctx.fillStyle = g;
    nctx.beginPath();
    nctx.arc(cx, cy, r * 4.5, 0, 7);
    nctx.fill();

    // cross flare — the brightest star in the field (dims right down when idle)
    const fl = r * 6.5;
    for (const [dx, dy, len] of [[1, 0, fl], [-1, 0, fl], [0, 1, fl * 0.8], [0, -1, fl * 0.8]]) {
      const lg = nctx.createLinearGradient(cx, cy, cx + dx * len, cy + dy * len);
      lg.addColorStop(0, stale ? "rgba(148,163,184,0.16)" : "rgba(190,243,252,0.5)");
      lg.addColorStop(1, stale ? "rgba(148,163,184,0)" : "rgba(190,243,252,0)");
      nctx.strokeStyle = lg;
      nctx.lineWidth = 1;
      nctx.beginPath();
      nctx.moveTo(cx, cy);
      nctx.lineTo(cx + dx * len, cy + dy * len);
      nctx.stroke();
    }

    nctx.fillStyle = stale ? "rgba(148,163,184,0.7)" : "#bdf3fc";
    nctx.beginPath();
    nctx.arc(cx, cy, r * 0.55, 0, 7);
    nctx.fill();
    nctx.strokeStyle = `rgba(${hue},0.8)`;
    nctx.lineWidth = 1.4;
    nctx.beginPath();
    nctx.arc(cx, cy, r, 0, 7);
    nctx.stroke();

    nctx.fillStyle = "rgba(91,107,130,0.85)";
    nctx.font = "9px ui-monospace, Consolas, monospace";
    nctx.textAlign = "center";
    nctx.fillText("LOCAL", cx, cy + r * 5 * 0.55 + 10);
    if (stale) {
      nctx.fillStyle = "rgba(148,163,184,0.9)";
      nctx.font = "8px ui-monospace, Consolas, monospace";
      nctx.fillText("NO TRAFFIC", cx, cy + r * 5 * 0.55 + 21);
    }
  }

  function drawHosts(now) {
    const labeled = new Set(topHosts(LABELED).map(h => h.ip));
    hovered = null;
    let best = 18 * 18;

    for (const h of state.hosts.values()) {
      const [x, y] = nodePos(h);
      const size = nodeSize(h);
      const color = protoColor(h.proto);
      const ema = h.emaDown + h.emaUp;
      const failAlert = h.alertUntil > now &&
        (h.alertType === "failed" || h.alertType === "reset" ||
         h.alertType === "unreach" || h.alertType === "loss");

      // alert marker while fresh
      if (h.alertUntil > now) {
        if (failAlert) {
          // connection failure — a marching guide line from LOCAL to the host
          // (so you can trace where it is) plus a broken red ring on the node
          nctx.strokeStyle = "rgba(248,113,113,0.5)";
          nctx.lineWidth = 1;
          nctx.setLineDash([2, 5]);
          nctx.lineDashOffset = -(now / 50) % 7;
          nctx.beginPath();
          nctx.moveTo(cx, cy);
          nctx.lineTo(x, y);
          nctx.stroke();

          nctx.strokeStyle = "#f87171";
          nctx.globalAlpha = 0.9;
          nctx.lineWidth = 1.3;
          nctx.setLineDash([3, 4]);
          nctx.lineDashOffset = -(now / 60) % 7;
          nctx.beginPath();
          nctx.arc(x, y, size + 5, 0, 7);
          nctx.stroke();
          nctx.setLineDash([]);
          nctx.lineDashOffset = 0;
          nctx.globalAlpha = 1;
        } else {
          // scan / dark — expanding red rings
          const phase = (now % 1100) / 1100;
          nctx.strokeStyle = "#f87171";
          for (const off of [0, 0.5]) {
            const p = (phase + off) % 1;
            nctx.globalAlpha = (1 - p) * 0.55;
            nctx.lineWidth = 1.5;
            nctx.beginPath();
            nctx.arc(x, y, size + 3 + p * 17, 0, 7);
            nctx.stroke();
          }
          nctx.globalAlpha = 1;
        }
      }

      // pinned marker
      if (state.pinnedIp === h.ip) {
        nctx.strokeStyle = "rgba(255,255,255,0.85)";
        nctx.lineWidth = 1.2;
        nctx.setLineDash([3, 3]);
        nctx.beginPath();
        nctx.arc(x, y, size + 6, 0, 7);
        nctx.stroke();
        nctx.setLineDash([]);
      }

      // sidebar-row hover highlight
      const highlighted = state.highlightIp === h.ip;
      if (highlighted) {
        const g = nctx.createRadialGradient(x, y, 0, x, y, size * 7);
        g.addColorStop(0, color + "55");
        g.addColorStop(1, color + "00");
        nctx.fillStyle = g;
        nctx.beginPath();
        nctx.arc(x, y, size * 7, 0, 7);
        nctx.fill();
        nctx.strokeStyle = "rgba(255,255,255,0.9)";
        nctx.lineWidth = 1.5;
        nctx.beginPath();
        nctx.arc(x, y, size + 5, 0, 7);
        nctx.stroke();
      }

      // spoke
      const la = clamp(ema / 300000, 0, 1) * 0.16 + (h.glow > 0.5 ? 0.05 : 0)
        + (state.highlightIp === h.ip ? 0.3 : 0);
      if (la > 0.015) {
        nctx.strokeStyle = color;
        nctx.globalAlpha = la;
        nctx.lineWidth = 1;
        nctx.beginPath();
        nctx.moveTo(cx, cy);
        nctx.lineTo(x, y);
        nctx.stroke();
        nctx.globalAlpha = 1;
      }

      // brightness twinkle, per-star phase and tempo
      const tw = 0.72 + 0.28 * Math.sin(now / (620 + h.rJitter * 540) + h.rJitter * 6.283);

      // colored bloom — innate, briefly boosted by activity
      const bloom = size * 3.4;
      const g = nctx.createRadialGradient(x, y, 0, x, y, bloom);
      g.addColorStop(0, color + "55");
      g.addColorStop(0.4, color + "22");
      g.addColorStop(1, color + "00");
      nctx.globalAlpha = (0.5 + h.glow * 0.5) * (0.65 + 0.35 * tw);
      nctx.fillStyle = g;
      nctx.beginPath();
      nctx.arc(x, y, bloom, 0, 7);
      nctx.fill();
      nctx.globalAlpha = 1;
      h.glow *= 0.94;

      // diffraction spikes on the brighter stars
      if (size > 2.7) {
        drawSpikes(x, y, size * (2.6 + 1.6 * tw), (h.rJitter - 0.5) * 0.6,
                   0.6 * tw + 0.2, color);
      }

      // hot core
      const cg = nctx.createRadialGradient(x, y, 0, x, y, size * 1.3);
      cg.addColorStop(0, `rgba(255,255,255,${0.95 * (0.75 + 0.25 * tw)})`);
      cg.addColorStop(0.5, color + "aa");
      cg.addColorStop(1, color + "00");
      nctx.fillStyle = cg;
      nctx.beginPath();
      nctx.arc(x, y, size * 1.3, 0, 7);
      nctx.fill();

      if (labeled.has(h.ip) || highlighted || failAlert) {
        const out = Math.hypot(x - cx, y - cy) || 1;
        let lx = x + (x - cx) / out * (size + 9);
        let ly = y + (y - cy) / out * (size + 9) + 3;
        const text = hostLabel(h);
        nctx.font = "10px ui-monospace, Consolas, monospace";
        const tw = nctx.measureText(text).width;
        const alignLeft = x >= cx;
        // keep labels inside the canvas — tall/narrow windows push the
        // 3 o'clock labels under the sidebar otherwise
        if (alignLeft) lx = Math.min(lx, W - 6 - tw);
        else lx = Math.max(lx, 6 + tw);
        ly = clamp(ly, 12, H - 8);
        nctx.fillStyle = failAlert ? "rgba(248,113,113,0.95)" : "rgba(187,203,222,0.78)";
        nctx.textAlign = alignLeft ? "left" : "right";
        nctx.fillText(text, lx, ly);
      }

      if (mouseX >= 0) {
        const d2 = (mouseX - x) ** 2 + (mouseY - y) ** 2;
        if (d2 < best) { best = d2; hovered = { host: h, x, y }; }
      }
    }
    nctx.textAlign = "left";
  }

  function frame(now, dt) {
    drawParticles(dt);
    nctx.clearRect(0, 0, W, H);
    drawGuides(now);
    drawConstellations();
    drawCenter(now);
    drawHosts(now);
    if (hovered) {
      const { host, x, y } = hovered;
      nctx.strokeStyle = "rgba(255,255,255,0.5)";
      nctx.lineWidth = 1;
      nctx.beginPath();
      nctx.arc(x, y, nodeSize(host) + 4, 0, 7);
      nctx.stroke();
    }
    return hovered;
  }

  return {
    frame, spawnFlows,
    onNodeClick: fn => { clickHandler = fn; },
    onNodePin: fn => { pinHandler = fn; },
  };
}

export function tooltipHTML(h) {
  const name = h.name ? `<div class="tt-name">${h.name}</div>` : "";
  const proc = h.proc ? ` · ${h.proc}` : "";
  const loc = h.cc ? `<div class="tt-geo"><span class="flag">${flagEmoji(h.cc)}</span> ${h.cc}${h.country ? ` · ${h.country}` : ""}</div>` : "";
  const org = h.org ? `<div class="tt-geo">${h.asn != null ? `AS${h.asn} ` : ""}${h.org}</div>` : "";
  const loss = h.loss ? `<div class="tt-loss">⚠ ${h.loss}% retransmit</div>` : "";
  return `${name}<div class="tt-ip">${h.ip}</div>
    <div class="tt-rate">
      <span class="d">▼ <b>${fmtRateStr(h.emaDown)}</b></span> ·
      <span class="u">▲ <b>${fmtRateStr(h.emaUp)}</b></span>
    </div>
    <div class="tt-ip">${h.proto.toUpperCase()}${proc}</div>
    ${loc}${org}${loss}
    <div class="tt-hint">click: copy IP · Shift+click: name · right-click: details</div>`;
}

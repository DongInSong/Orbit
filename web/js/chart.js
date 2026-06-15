import { state, freezeChart, unfreezeChart } from "./state.js";
import { clamp, fmtRateStr } from "./util.js";

const LEN = 1200; // matches state ring buffers (120s @ 10Hz)

export function initChart(container, canvas, scaleLabel, requestRedraw) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  let scaleMax = 1000; // bytes/sec, decays toward current window max

  let hoverIdx = -1;                 // chart index under the cursor (-1 = none)
  let selStart = -1, selEnd = -1;    // selection range (selStart < 0 = none)
  let playhead = -1;                 // replay cursor index (-1 = none)
  let locked = false;                // replay in progress → selection is locked
  let pickHandler = null, seekHandler = null, dragging = false;
  const redraw = requestRedraw || (() => {});

  // During replay the DISPLAY is frozen to a snapshot (state.chartFreeze) while
  // the live ring keeps advancing underneath — so the selection/playhead stay
  // aligned, and on exit the chart shows the (now caught-up) live ring.
  const fz = () => state.chartFreeze;
  const cDown = () => { const f = fz(); return f ? f.down : state.chartDown; };
  const cUp = () => { const f = fz(); return f ? f.up : state.chartUp; };
  const cHead = () => { const f = fz(); return f ? f.head : state.chartHead; };
  const cSeen = () => { const f = fz(); return f ? f.seen : state.ticksSeen; };

  const firstValid = () => LEN - cSeen();                // oldest filled index
  const xOfI = i => (i / (LEN - 1)) * W;
  const idxAtX = px => clamp(Math.round((px / W) * (LEN - 1)),
                             Math.max(0, firstValid()), LEN - 1);
  const lo = () => Math.min(selStart, selEnd);
  const hi = () => Math.max(selStart, selEnd);
  const inSel = i => selStart >= 0 && i >= lo() && i <= hi();

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = container.clientWidth;
    H = container.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  new ResizeObserver(resize).observe(container);
  resize();

  canvas.addEventListener("pointermove", e => {
    hoverIdx = idxAtX(e.offsetX);
    if (dragging && !locked) selEnd = hoverIdx;
    canvas.style.cursor = locked ? (inSel(hoverIdx) ? "pointer" : "default") : "crosshair";
    redraw();
  });
  canvas.addEventListener("pointerdown", e => {
    if (cSeen() === 0) return;
    if (locked) {                              // replay: click inside the band = seek
      const i = idxAtX(e.offsetX);
      if (inSel(i) && seekHandler) seekHandler(i);
      return;                                  // no re-selection while locked
    }
    dragging = true;
    freezeChart();                     // selecting freezes the chart so it stops scrolling
    selStart = selEnd = idxAtX(e.offsetX);
    canvas.setPointerCapture(e.pointerId);
    redraw();
  });
  canvas.addEventListener("pointerup", e => {
    if (!dragging || locked) return;
    dragging = false;
    selEnd = idxAtX(e.offsetX);
    const a = Math.min(selStart, selEnd), b = Math.max(selStart, selEnd);
    const point = (b - a) < 4;                     // tiny drag = single point
    selStart = a; selEnd = point ? LEN - 1 : b;    // point → replay to live edge
    pickHandler && pickHandler({ startIdx: a, endIdx: selEnd, point });
    redraw();
  });
  canvas.addEventListener("pointerleave", () => {
    if (!dragging) { hoverIdx = -1; redraw(); }
  });

  function series(buf, i) {
    return buf[(cHead() + i) % LEN];
  }

  // sqrt scaling keeps small flows visible next to multi-MB bursts
  function yOf(buf, i, mid, sign) {
    const v = Math.sqrt(Math.min(series(buf, i) / scaleMax, 1));
    return mid + sign * v * (mid - 12);
  }

  function drawArea(buf, mid, sign, color, grad) {
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let i = 0; i < LEN; i++) {
      ctx.lineTo((i / (LEN - 1)) * W, yOf(buf, i, mid, sign));
    }
    ctx.lineTo(W, mid);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < LEN; i++) {
      const x = (i / (LEN - 1)) * W;
      const y = yOf(buf, i, mid, sign);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }

  function frame() {
    const cd = cDown(), cu = cUp();
    let max = 1000;
    for (let i = 0; i < LEN; i++) {
      if (cd[i] > max) max = cd[i];
      if (cu[i] > max) max = cu[i];
    }
    scaleMax = max > scaleMax ? max : scaleMax * 0.995 + max * 0.005;

    ctx.clearRect(0, 0, W, H);
    const mid = H / 2;

    // 30s vertical grid
    ctx.strokeStyle = "rgba(27,36,53,0.55)";
    ctx.lineWidth = 1;
    for (let s = 1; s < 4; s++) {
      const x = W - (s * 300 / (LEN - 1)) * W;
      ctx.beginPath();
      ctx.moveTo(x, 6);
      ctx.lineTo(x, H - 6);
      ctx.stroke();
    }

    const gd = ctx.createLinearGradient(0, 0, 0, mid);
    gd.addColorStop(0, "rgba(34,211,238,0.28)");
    gd.addColorStop(1, "rgba(34,211,238,0.02)");
    drawArea(cd, mid, -1, "rgba(34,211,238,0.9)", gd);

    const gu = ctx.createLinearGradient(0, mid, 0, H);
    gu.addColorStop(0, "rgba(251,191,36,0.02)");
    gu.addColorStop(1, "rgba(251,191,36,0.24)");
    drawArea(cu, mid, 1, "rgba(251,191,36,0.85)", gu);

    ctx.strokeStyle = "rgba(91,107,130,0.4)";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();

    drawScrub(mid);

    scaleLabel.textContent = `±${fmtRateStr(scaleMax)} · 120s`;
  }

  function drawScrub(mid) {
    // dim the not-yet-filled region (buffer still warming up)
    const fv = firstValid();
    if (fv > 0) { ctx.fillStyle = "rgba(7,10,16,0.55)"; ctx.fillRect(0, 0, xOfI(fv), H); }

    // selection band — brighter "locked" treatment during replay
    if (selStart >= 0) {
      const a = xOfI(lo()), b = xOfI(hi());
      ctx.fillStyle = locked ? "rgba(167,139,250,0.22)" : "rgba(167,139,250,0.12)";
      ctx.fillRect(a, 6, Math.max(b - a, 1.5), H - 12);
      ctx.strokeStyle = locked ? "rgba(196,181,253,0.95)" : "rgba(167,139,250,0.85)";
      ctx.lineWidth = locked ? 1.6 : 1.2;
      ctx.beginPath();
      ctx.moveTo(a, 6); ctx.lineTo(a, H - 6);
      ctx.moveTo(b, 6); ctx.lineTo(b, H - 6);
      ctx.stroke();
      if (locked && b - a > 60) {              // discoverability hint inside the locked band
        ctx.fillStyle = "rgba(196,181,253,0.85)";
        ctx.font = "8px ui-monospace, Consolas, monospace";
        ctx.textAlign = "left";
        ctx.fillText("LOCKED · click to seek", a + 5, 15);
      }
    }

    // replay playhead
    if (playhead >= 0) {
      const x = xOfI(playhead);
      ctx.strokeStyle = "rgba(167,139,250,0.9)";
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, H - 4); ctx.stroke();
      ctx.fillStyle = "#a78bfa"; ctx.shadowColor = "#a78bfa"; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(x, mid, 3.5, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
    }

    // hover scrubber + readout chip
    if (hoverIdx >= 0) {
      const x = xOfI(hoverIdx);
      ctx.strokeStyle = "rgba(34,211,238,0.55)";
      ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, H - 4); ctx.stroke();
      ctx.setLineDash([]);
      const ago = (LEN - 1 - hoverIdx) / 10;
      const d = series(cDown(), hoverIdx), u = series(cUp(), hoverIdx);
      const label = `-${ago.toFixed(1)}s  ▼${fmtRateStr(d)}  ▲${fmtRateStr(u)}`;
      ctx.font = "10px ui-monospace, Consolas, monospace";
      ctx.textAlign = "left";
      const w = ctx.measureText(label).width + 12, bx = clamp(x - w / 2, 2, W - w - 2);
      const cy0 = H - 20;                    // bottom strip — clear of the top controls
      ctx.fillStyle = "rgba(10,15,26,0.94)";
      ctx.strokeStyle = "rgba(34,211,238,0.35)";
      ctx.fillRect(bx, cy0, w, 16); ctx.strokeRect(bx, cy0, w, 16);
      ctx.fillStyle = "#d6e2f0"; ctx.textBaseline = "middle";
      ctx.fillText(label, bx + 6, cy0 + 8); ctx.textBaseline = "alphabetic";
    }
  }

  return {
    frame,
    onPick: fn => { pickHandler = fn; },
    onSeek: fn => { seekHandler = fn; },
    setPlayhead: i => { playhead = i; },
    setSelection: (a, b) => { selStart = a; selEnd = b; },
    setLocked: v => { locked = v; if (!v) canvas.style.cursor = "crosshair"; },
    clearScrub: () => { hoverIdx = selStart = selEnd = playhead = -1; dragging = locked = false; unfreezeChart(); },
  };
}

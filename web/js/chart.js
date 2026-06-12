import { state } from "./state.js";
import { fmtRateStr } from "./util.js";

const LEN = 1200; // matches state ring buffers (120s @ 10Hz)

export function initChart(container, canvas, scaleLabel) {
  const ctx = canvas.getContext("2d");
  let W = 0, H = 0, dpr = 1;
  let scaleMax = 1000; // bytes/sec, decays toward current window max

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

  function series(buf, i) {
    return buf[(state.chartHead + i) % LEN];
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
    let max = 1000;
    for (let i = 0; i < LEN; i++) {
      const d = state.chartDown[i], u = state.chartUp[i];
      if (d > max) max = d;
      if (u > max) max = u;
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
    drawArea(state.chartDown, mid, -1, "rgba(34,211,238,0.9)", gd);

    const gu = ctx.createLinearGradient(0, mid, 0, H);
    gu.addColorStop(0, "rgba(251,191,36,0.02)");
    gu.addColorStop(1, "rgba(251,191,36,0.24)");
    drawArea(state.chartUp, mid, 1, "rgba(251,191,36,0.85)", gu);

    ctx.strokeStyle = "rgba(91,107,130,0.4)";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();

    scaleLabel.textContent = `±${fmtRateStr(scaleMax)} · 120s`;
  }

  return { frame };
}

/* Static milky-way backdrop — rendered once per resize, zero per-frame cost. */

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TINTS = ["255,255,255", "190,215,255", "255,235,200", "200,190,255"];

export function initStarfield(container, canvas) {
  const ctx = canvas.getContext("2d");

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = container.clientWidth, H = container.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const rng = mulberry32(20260612);

    // galaxy band — soft luminous blobs along a diagonal through the center
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(-0.48);
    const span = Math.hypot(W, H) / 2;
    for (let i = 0; i < 26; i++) {
      const bx = (rng() * 2 - 1) * span;
      const by = (rng() * 2 - 1) * 46;
      const br = 60 + rng() * 150;
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      const tint = rng() < 0.3 ? "150,170,230" : "190,205,240";
      g.addColorStop(0, `rgba(${tint},${0.035 + rng() * 0.045})`);
      g.addColorStop(1, `rgba(${tint},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, 7);
      ctx.fill();
    }
    ctx.restore();

    // faint colored nebulae scattered off-band
    for (const tint of ["120,80,200", "30,160,190", "180,90,200"]) {
      const nx = W * (0.15 + rng() * 0.7), ny = H * (0.15 + rng() * 0.7);
      const nr = 110 + rng() * 130;
      const g = ctx.createRadialGradient(nx, ny, 0, nx, ny, nr);
      g.addColorStop(0, `rgba(${tint},${0.03 + rng() * 0.02})`);
      g.addColorStop(1, `rgba(${tint},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(nx, ny, nr, 0, 7);
      ctx.fill();
    }

    // stars — denser near the band, sparse elsewhere
    const count = Math.round((W * H) / 2600);
    for (let i = 0; i < count; i++) {
      let x = rng() * W, y = rng() * H;
      if (rng() < 0.45) {
        // pull this one toward the band axis
        const t = (rng() * 2 - 1) * span;
        const off = (rng() + rng() - 1) * 90;
        const cos = Math.cos(-0.48), sin = Math.sin(-0.48);
        x = W / 2 + t * cos - off * sin;
        y = H / 2 + t * sin + off * cos;
        if (x < 0 || x > W || y < 0 || y > H) { x = rng() * W; y = rng() * H; }
      }
      const r = 0.3 + rng() * rng() * 1.2;
      const a = 0.07 + rng() * 0.38;
      const tint = TINTS[(rng() * TINTS.length) | 0];
      ctx.fillStyle = `rgba(${tint},${a})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 7);
      ctx.fill();
      // the occasional bright star gets a faint cross flare
      if (rng() < 0.012) {
        ctx.strokeStyle = `rgba(${tint},${a * 0.5})`;
        ctx.lineWidth = 0.6;
        const f = 3 + rng() * 4;
        ctx.beginPath();
        ctx.moveTo(x - f, y); ctx.lineTo(x + f, y);
        ctx.moveTo(x, y - f); ctx.lineTo(x, y + f);
        ctx.stroke();
      }
    }
  }

  new ResizeObserver(draw).observe(container);
  draw();
}

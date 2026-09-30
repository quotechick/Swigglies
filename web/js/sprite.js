// Pixel portraits of the dots. A dot grows with its net worth (Speck, Dot, Blot, Stain) and
// turns pale when it is broke, the way a leech turns pale when nobody buys.
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const css = c => `rgb(${c[0]},${c[1]},${c[2]})`;
const RADIUS = { Pale: 6.5, Speck: 5.5, Dot: 7.5, Blot: 9, Stain: 10.5 };

export function drawDot(canvas, color, stage = 'Dot', blink = false) {
  const N = 24;
  canvas.width = canvas.height = N;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, N, N);
  let base = hex(color);
  if (stage === 'Pale') base = mix(base, [210, 210, 210], 0.72);
  const light = mix(base, [255, 255, 255], 0.35), dark = mix(base, [11, 11, 11], 0.35), ink = [11, 11, 11];
  const r = RADIUS[stage] || 7.5, cx = 12, cy = 21 - r;
  g.fillStyle = 'rgba(0,0,0,0.18)';
  for (let x = Math.round(cx - r); x <= Math.round(cx + r); x++) g.fillRect(x, 22, 1, 1);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy);
      if (d > r) continue;
      let c;
      if (d > r - 1.1) c = ink;
      else {
        const lit = (-dx * 0.6 - dy * 0.8) / r;
        c = lit > 0.45 ? light : lit < -0.35 ? dark : base;
      }
      g.fillStyle = css(c);
      g.fillRect(x, y, 1, 1);
    }
  }
  g.fillStyle = css(mix(light, [255, 255, 255], 0.6));
  g.fillRect(Math.round(cx - r * 0.5), Math.round(cy - r * 0.55), 2, 1);
  const ey = Math.round(cy - r * 0.05), ex = Math.max(2, Math.round(r * 0.36));
  for (const sx of [cx - ex - 1, cx + ex - 1]) {
    if (blink || stage === 'Pale') { g.fillStyle = css(ink); g.fillRect(sx, ey + 1, 2, 1); continue; }
    g.fillStyle = '#ffffff'; g.fillRect(sx, ey, 2, 2);
    g.fillStyle = css(ink); g.fillRect(sx + 1, ey + 1, 1, 1);
  }
  if (stage === 'Stain' || stage === 'Blot') { g.fillStyle = css(ink); g.fillRect(cx - 1, ey + 3, 3, 1); }
  return canvas;
}

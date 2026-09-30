// The plat: a surveyor's ink drawing of the hood. Static layer (lots, builds, tags) is redrawn
// only when the state changes; dots, receipts in flight and rings are drawn every frame on top.
import { GRID, lotName, colorOf, sol } from './live.js';
import { positionOf } from './motion.js';

// Black and white; the five dots' colours (owner tints, hatching, stripes, the dots themselves) are the only colour.
const PAPER = '#ffffff', STREET = '#e8e8e8', INK = '#0b0b0b', OX = '#1f1f1f', BRASS = '#bdbdbd', BONE = '#ffffff', MUTED = '#777777', SAND = '#d4d4d4';
const H = 0.357; // half a lot, in plat units

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const tint = (h, t, base = [255, 255, 255]) => { const c = hex(h); return `rgb(${base.map((v, i) => Math.round(v + (c[i] - v) * t)).join(',')})`; };

export function createPlat(canvas, { mini = false, onPick, now = () => Date.now() } = {}) {
  const ctx = canvas.getContext('2d');
  const M = mini ? 0.22 : 0.5;
  let S = null, W = 0, Hh = 0, dpr = 1, k = 1, ox = 0, oy = 0, layer = null, dirty = true, raf = 0, active = true, hover = -1, selected = -1;
  const fx = [];
  const X = x => ox + (x + 0.5 + M) * k, Y = y => oy + (y + 0.5 + M) * k;

  function layout() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width * dpr)); Hh = Math.max(1, Math.round(r.height * dpr));
    canvas.width = W; canvas.height = Hh;
    const span = GRID + 2 * M;
    k = Math.min(W, Hh) / span;
    ox = (W - k * span) / 2; oy = (Hh - k * span) / 2;
    dirty = true;
  }

  function glyph(g, kind, level, cx, cy, u, color) {
    g.lineWidth = Math.max(1, dpr * (mini ? 0.8 : 1.1));
    g.strokeStyle = INK; g.lineJoin = 'round';
    const box = (x, y, w, h, fill = BONE) => { g.fillStyle = fill; g.fillRect(x, y, w, h); g.strokeRect(x, y, w, h); };
    const tri = (x0, y0, x1, y1, x2, y2, fill) => { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.lineTo(x2, y2); g.closePath(); g.fillStyle = fill; g.fill(); g.stroke(); };
    const base = cy + u * 0.75;
    if (kind === 'house') {
      const w = u * 1.25, h = u * (0.55 + 0.25 * level);
      if (level >= 3) box(cx + w / 2 - u * 0.1, base - u * 0.55, u * 0.55, u * 0.55);
      box(cx - w / 2, base - h, w, h);
      tri(cx - w / 2 - u * 0.12, base - h, cx + w / 2 + u * 0.12, base - h, cx, base - h - u * 0.6, OX);
      if (level >= 2) box(cx + w * 0.18, base - h - u * 0.55, u * 0.16, u * 0.32, OX);
      box(cx - u * 0.12, base - u * 0.36, u * 0.24, u * 0.36, INK);
    } else if (kind === 'workshop') {
      const w = u * 1.6, h = u * 0.7;
      box(cx + w * 0.22, base - h - u * (0.5 + 0.2 * level), u * 0.2, u * (0.5 + 0.2 * level), OX);
      box(cx - w / 2, base - h, w, h);
      const teeth = 2 + level;
      for (let t = 0; t < teeth; t++) { const x = cx - w / 2 + (w / teeth) * t; tri(x, base - h, x + w / teeth, base - h, x, base - h - u * 0.35, SAND); }
      box(cx - u * 0.18, base - u * 0.4, u * 0.36, u * 0.4, INK);
    } else if (kind === 'shop') {
      const w = u * 1.35, h = u * (0.7 + 0.18 * level);
      box(cx - w / 2, base - h, w, h);
      const n = 5, aw = w + u * 0.2, ay = base - h;
      for (let t = 0; t < n; t++) {
        const x = cx - aw / 2 + (aw / n) * t;
        g.beginPath(); g.moveTo(x, ay); g.lineTo(x + aw / n, ay); g.lineTo(x + aw / n, ay + u * 0.18);
        g.arc(x + aw / (2 * n), ay + u * 0.18, aw / (2 * n), 0, Math.PI); g.closePath();
        g.fillStyle = t % 2 ? BONE : color; g.fill(); g.stroke();
      }
      box(cx - u * 0.32, base - u * 0.42, u * 0.64, u * 0.42, SAND);
    } else if (kind === 'tower') {
      const w = u * 0.8, h = u * (1.25 + 0.3 * level);
      box(cx - w / 2, base - h, w, h);
      g.fillStyle = INK;
      for (let yy = base - h + u * 0.18; yy < base - u * 0.2; yy += u * 0.26) for (const xx of [-0.2, 0.08]) g.fillRect(cx + xx * u, yy, u * 0.12, u * 0.14);
      tri(cx - w / 2 - u * 0.08, base - h, cx + w / 2 + u * 0.08, base - h, cx, base - h - u * 0.45, BRASS);
    } else if (kind === 'office') {
      const w = u * 1.7;
      box(cx - w / 2 - u * 0.1, base - u * 0.16, w + u * 0.2, u * 0.16, SAND);
      for (let t = 0; t < 4; t++) box(cx - w / 2 + u * 0.1 + t * (w - u * 0.35) / 3, base - u * 0.9, u * 0.14, u * 0.74);
      tri(cx - w / 2 - u * 0.05, base - u * 0.9, cx + w / 2 + u * 0.05, base - u * 0.9, cx, base - u * 1.3, BONE);
      g.beginPath(); g.arc(cx, base - u * 1.28, u * 0.32, Math.PI, 0); g.closePath(); g.fillStyle = BRASS; g.fill(); g.stroke();
    }
    if (kind !== 'office' && level) {
      for (let p = 0; p < level; p++) { g.beginPath(); g.arc(cx - (level - 1) * u * 0.14 + p * u * 0.28, base + u * 0.26, u * 0.08, 0, Math.PI * 2); g.fillStyle = color; g.fill(); g.stroke(); }
    }
  }

  function drawStatic() {
    layer ||= document.createElement('canvas');
    layer.width = W; layer.height = Hh;
    const g = layer.getContext('2d');
    g.fillStyle = PAPER; g.fillRect(0, 0, W, Hh);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.fillStyle = 'rgba(0,0,0,0.07)';
    for (let n = 0; n < (W * Hh) / 900; n++) g.fillRect(rnd() * W, rnd() * Hh, dpr, dpr);
    g.fillStyle = STREET; g.fillRect(X(-0.5), Y(-0.5), GRID * k, GRID * k);
    g.strokeStyle = 'rgba(22,19,15,0.2)'; g.lineWidth = dpr; g.setLineDash([k * 0.06, k * 0.07]);
    for (let q = 0; q < GRID - 1; q++) {
      g.beginPath(); g.moveTo(X(q + 0.5), Y(-0.5)); g.lineTo(X(q + 0.5), Y(GRID - 0.5)); g.stroke();
      g.beginPath(); g.moveTo(X(-0.5), Y(q + 0.5)); g.lineTo(X(GRID - 0.5), Y(q + 0.5)); g.stroke();
    }
    g.setLineDash([]);
    g.strokeStyle = INK; g.lineWidth = 1.6 * dpr; g.strokeRect(X(-0.5), Y(-0.5), GRID * k, GRID * k);
    if (!mini) { g.lineWidth = dpr * 0.8; g.strokeRect(X(-0.5) - 5 * dpr, Y(-0.5) - 5 * dpr, GRID * k + 10 * dpr, GRID * k + 10 * dpr); }
    if (!S) return;
    const listing = new Map(S.listings.filter(L => L.lot != null).map(L => [L.lot, L]));
    for (const l of S.lots) {
      const c = l.i % GRID, r = Math.floor(l.i / GRID);
      const x0 = X(c - H), y0 = Y(r - H), s = 2 * H * k;
      const own = l.owner && l.owner !== 'office' ? colorOf(S, l.owner) : null;
      g.fillStyle = l.owner === 'office' ? '#dcdcdc' : own ? tint(own, 0.2) : l.foreclosed ? '#e2e2e2' : '#fbfbfb';
      g.fillRect(x0, y0, s, s);
      if (own || l.foreclosed) {
        g.save(); g.beginPath(); g.rect(x0, y0, s, s); g.clip();
        g.strokeStyle = own ? tint(own, 0.55) : 'rgba(0,0,0,0.3)'; g.lineWidth = dpr * (mini ? 0.7 : 1);
        const step = k * (mini ? 0.09 : 0.07);
        for (let d = -s; d < s; d += step) { g.beginPath(); g.moveTo(x0 + d, y0 + s); g.lineTo(x0 + d + s, y0); g.stroke(); }
        g.restore();
      }
      g.strokeStyle = INK; g.lineWidth = 1.2 * dpr; g.strokeRect(x0, y0, s, s);
      if (own) { g.fillStyle = own; g.fillRect(x0, y0, s, Math.max(2 * dpr, k * 0.045)); }
      const u = s * 0.34;
      if (l.owner === 'office') glyph(g, 'office', 0, X(c), Y(r) - u * 0.1, u, INK);
      else if (l.build) glyph(g, l.build.kind, l.build.level, X(c), Y(r) - u * 0.15, u, own || MUTED);
      if (!mini) {
        g.fillStyle = MUTED; g.font = `${Math.round(k * 0.085)}px "JetBrains Mono", monospace`; g.textBaseline = 'top';
        g.fillText(l.owner === 'office' ? 'D4 · OFFICE' : l.name, x0 + k * 0.03, y0 + k * 0.06);
      }
      const L = listing.get(l.i);
      if (L) {
        const label = mini ? (L.foreclosure ? 'FORECLOSED' : 'FOR SALE') : `${L.foreclosure ? 'FORECLOSED' : 'FOR SALE'} ${sol(L.price, false)}`;
        g.font = `${Math.round(k * (mini ? 0.11 : 0.082))}px "JetBrains Mono", monospace`;
        const tw = g.measureText(label).width + k * 0.06, th = k * (mini ? 0.14 : 0.12);
        const tx = X(c) - tw / 2, ty = y0 + s - th - k * 0.03;
        g.fillStyle = L.foreclosure ? OX : BRASS; g.fillRect(tx, ty, tw, th);
        g.strokeStyle = INK; g.lineWidth = dpr; g.strokeRect(tx, ty, tw, th);
        g.fillStyle = L.foreclosure ? '#ffffff' : INK; g.textBaseline = 'middle'; g.fillText(label, tx + k * 0.03, ty + th / 2 + dpr * 0.5);
      }
    }
    if (!mini) {
      const cx = X(GRID - 0.5) + k * 0.25, cy = Y(-0.5) + k * 0.25;
      g.strokeStyle = INK; g.fillStyle = INK; g.lineWidth = dpr;
      g.beginPath(); g.moveTo(cx, cy - k * 0.16); g.lineTo(cx + k * 0.05, cy); g.lineTo(cx - k * 0.05, cy); g.closePath(); g.fill();
      g.font = `${Math.round(k * 0.1)}px "IM Fell English SC", serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillText('N', cx, cy - k * 0.17); g.textAlign = 'left';
    }
  }

  function agentPoint(id, t) {
    if (id === 'office') return { x: 3, y: 3 };
    const idx = S.agents.findIndex(a => a.id === id);
    return idx < 0 ? { x: 3, y: 3 } : positionOf(S.agents[idx], idx, t);
  }

  function frame() {
    raf = active ? requestAnimationFrame(frame) : 0;
    if (!S || !W) return;
    if (dirty) { drawStatic(); dirty = false; }
    const t = now(), g = ctx;
    g.drawImage(layer, 0, 0);
    for (const i of [hover, selected]) {
      if (i < 0) continue;
      const c = i % GRID, r = Math.floor(i / GRID);
      g.strokeStyle = i === selected ? OX : INK; g.lineWidth = (i === selected ? 3 : 2) * dpr;
      g.strokeRect(X(c - H) - 2 * dpr, Y(r - H) - 2 * dpr, 2 * H * k + 4 * dpr, 2 * H * k + 4 * dpr);
    }
    for (let n = fx.length - 1; n >= 0; n--) {
      const f = fx[n], p = (t - f.t0) / f.dur;
      if (p >= 1) { fx.splice(n, 1); continue; }
      if (p < 0) continue;
      if (f.kind === 'pay') {
        const a = agentPoint(f.from, t), b = agentPoint(f.to, t);
        for (let q = 0; q < 4; q++) {
          const pp = Math.min(1, Math.max(0, p * 1.4 - q * 0.12));
          if (pp <= 0 || pp >= 1) continue;
          const x = X(a.x + (b.x - a.x) * pp), y = Y(a.y + (b.y - a.y) * pp) - Math.sin(pp * Math.PI) * k * 0.6;
          g.beginPath(); g.arc(x, y, k * 0.045, 0, Math.PI * 2); g.fillStyle = BRASS; g.fill(); g.strokeStyle = INK; g.lineWidth = dpr; g.stroke();
        }
      } else {
        const c = f.lot % GRID, r = Math.floor(f.lot / GRID);
        g.strokeStyle = f.color; g.globalAlpha = 1 - p; g.lineWidth = 3 * dpr;
        g.beginPath(); g.arc(X(c), Y(r), k * (0.3 + p * 0.5), 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
      }
    }
    S.agents.forEach((a, idx) => {
      const p = positionOf(a, idx, t);
      const x = X(p.x), y = Y(p.y), rad = k * (mini ? 0.13 : 0.11);
      const bob = p.moving ? Math.sin(t / 90 + idx) * k * 0.012 : 0;
      g.fillStyle = 'rgba(22,19,15,0.2)'; g.beginPath(); g.ellipse(x, y + rad * 0.9, rad * 0.9, rad * 0.35, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(x, y - bob, rad, 0, Math.PI * 2);
      g.fillStyle = a.status === 'broke' ? tint(a.color, 0.35, [210, 210, 210]) : a.color; g.fill();
      g.strokeStyle = INK; g.lineWidth = 1.4 * dpr; g.stroke();
      g.fillStyle = 'rgba(255,248,232,0.7)'; g.beginPath(); g.arc(x - rad * 0.35, y - bob - rad * 0.35, rad * 0.25, 0, Math.PI * 2); g.fill();
      if (a.seat && t - a.seat.lastAt < (S.seatHoldMs || 1_200_000)) { g.strokeStyle = INK; g.lineWidth = 2 * dpr; g.beginPath(); g.arc(x, y - bob, rad * 1.45, 0, Math.PI * 2); g.stroke(); }
      const label = a.name.toUpperCase();
      g.font = `${Math.round(k * (mini ? 0.13 : 0.085))}px "JetBrains Mono", monospace`;
      const tw = g.measureText(label).width + k * 0.06, th = k * (mini ? 0.16 : 0.12);
      const lx = x - tw / 2, ly = y - bob - rad - th - k * 0.03;
      g.fillStyle = PAPER; g.fillRect(lx, ly, tw, th); g.strokeStyle = INK; g.lineWidth = dpr; g.strokeRect(lx, ly, tw, th);
      g.fillStyle = INK; g.textBaseline = 'middle'; g.fillText(label, lx + k * 0.03, ly + th / 2 + dpr * 0.5);
    });
  }

  function lotAt(ev) {
    const r = canvas.getBoundingClientRect();
    const px = (ev.clientX - r.left) * dpr, py = (ev.clientY - r.top) * dpr;
    const x = (px - ox) / k - 0.5 - M, y = (py - oy) / k - 0.5 - M;
    const c = Math.round(x), rr = Math.round(y);
    if (c < 0 || rr < 0 || c >= GRID || rr >= GRID || Math.abs(x - c) > H || Math.abs(y - rr) > H) return -1;
    return rr * GRID + c;
  }

  if (onPick) {
    canvas.addEventListener('click', ev => { const i = lotAt(ev); if (i >= 0) onPick(i); });
    canvas.addEventListener('pointermove', ev => { hover = lotAt(ev); canvas.style.cursor = hover >= 0 ? 'pointer' : 'default'; });
    canvas.addEventListener('pointerleave', () => { hover = -1; });
  }
  const ro = new ResizeObserver(layout);
  ro.observe(canvas);
  layout();
  raf = requestAnimationFrame(frame);

  return {
    setState(s) { S = s; dirty = true; },
    select(i) { selected = i; },
    addFx(list, s) {
      const t = now();
      list.forEach((f, n) => {
        if (f.kind === 'pay') fx.push({ ...f, t0: t + n * 150, dur: 1600 });
        else if (f.kind === 'buyout') (f.lots.length ? f.lots : [0]).forEach(lot => fx.push({ kind: 'ring', lot, color: OX, t0: t, dur: 1800 }));
        else if (f.kind === 'foreclose') f.lots.forEach(lot => fx.push({ kind: 'ring', lot, color: OX, t0: t, dur: 2200 }));
        else if (f.kind === 'build') fx.push({ kind: 'ring', lot: f.lot, color: s ? BRASS : BRASS, t0: t, dur: 1400 });
      });
    },
    setActive(on) { active = on; if (on && !raf) raf = requestAnimationFrame(frame); },
    lotName,
  };
}

// Where each dot is, in plat units: lot (c, r) has its centre at (c, r); streets run on the
// half-lines between lots. A dot stands at a lot's door on the street south of it and walks the
// streets, never across a lot. The 2D plat and the 3D hood both read positions from here.
import { GRID } from './live.js';

export const SPEED = 0.9; // lots per second
const door = i => ({ x: i % GRID, y: Math.floor(i / GRID) + 0.5 });

export function route(from, to) {
  const A = door(from), B = door(to);
  if (A.y === B.y) return [A, B];
  const sx = A.x + (B.x > A.x ? 0.5 : -0.5);
  return [A, { x: sx, y: A.y }, { x: sx, y: B.y }, B];
}

export function positionOf(agent, index, now) {
  const pts = route(agent.from, agent.at);
  let left = Math.max(0, (now - agent.movedAt) / 1000) * SPEED;
  let x = pts[0].x, y = pts[0].y, hx = 1, hy = 0, moving = false;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1], b = pts[k];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) continue;
    hx = (b.x - a.x) / len; hy = (b.y - a.y) / len;
    if (left < len) { x = a.x + hx * left; y = a.y + hy * left; moving = true; break; }
    left -= len; x = b.x; y = b.y;
  }
  // five dots never stand on exactly the same spot
  const ang = (index / 5) * Math.PI * 2;
  return { x: x + Math.cos(ang) * 0.1, y: y + Math.sin(ang) * 0.06, moving, hx, hy };
}

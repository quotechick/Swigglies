// The hood in 3D: a tabletop model in the plat's palette. Flat warm materials with inked edges,
// owner flags, for-sale signs, and the five dots rolling the streets. Receipts fly as coins.
import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { GRID, colorOf, sol } from './live.js';
import { positionOf } from './motion.js';

const PITCH = 14, LOT = 10, TOP = 0.9;
// Black and white; the five dots' colours are the only colour in the scene.
const INK = 0x0b0b0b, BONE = 0xf5f5f5, OX = 0x2a2a2a, BRASS = 0xb5b5b5, STREET = 0xdedede, SAND = 0xcfcfcf;
const wx = x => (x - (GRID - 1) / 2) * PITCH;

const matCache = new Map();
export function mat(color, kind = 'matte') {
  const key = `${color}-${kind}`;
  if (!matCache.has(key)) {
    matCache.set(key, kind === 'metal'
      ? new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.55 })
      : new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 }));
  }
  return matCache.get(key);
}
const inkMat = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0.8 });
const edgeCache = new WeakMap();
export function inked(mesh, shadow = true) {
  if (!edgeCache.has(mesh.geometry)) edgeCache.set(mesh.geometry, new THREE.EdgesGeometry(mesh.geometry, 25));
  mesh.add(new THREE.LineSegments(edgeCache.get(mesh.geometry), inkMat));
  mesh.castShadow = shadow; mesh.receiveShadow = true;
  return mesh;
}
const geoCache = new Map();
const cached = (key, make) => { if (!geoCache.has(key)) geoCache.set(key, make()); return geoCache.get(key); };
const boxGeo = (w, h, d) => cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
export function box(w, h, d, color, x = 0, y = 0, z = 0, kind) {
  const m = inked(new THREE.Mesh(boxGeo(w, h, d), mat(color, kind)));
  m.position.set(x, y + h / 2, z);
  return m;
}
export function gable(w, h, d, color, y) {
  const g = cached(`g${w},${h},${d}`, () => {
    const s = new THREE.Shape(); s.moveTo(-d / 2, 0); s.lineTo(d / 2, 0); s.lineTo(0, h); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
    geo.translate(0, 0, -w / 2); geo.rotateY(Math.PI / 2);
    return geo;
  });
  const m = inked(new THREE.Mesh(g, mat(color)));
  m.position.y = y;
  return m;
}

let windowTex = null;
function towerMat(level) {
  if (!windowTex) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#333333';
    for (const x of [12, 38]) g.fillRect(x, 18, 14, 24);
    g.fillStyle = '#0b0b0b'; g.fillRect(0, 0, 64, 2);
    windowTex = new THREE.CanvasTexture(c);
    windowTex.colorSpace = THREE.SRGBColorSpace;
    windowTex.wrapS = windowTex.wrapT = THREE.RepeatWrapping;
  }
  return cached(`tm${level}`, () => {
    const t = windowTex.clone(); t.needsUpdate = true; t.repeat.set(2, 2 + level * 2);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
  });
}

export function building(kind, level, color, smoke) {
  const g = new THREE.Group();
  const own = new THREE.Color(color).getHex();
  if (kind === 'house') {
    const h = 3 + (level - 1) * 2.4;
    g.add(box(6, h, 5, BONE));
    g.add(gable(6.6, 2.4, 5.8, OX, h));
    g.add(box(1.2, 2, 0.2, INK, 0, 0, 2.55));
    for (let f = 0; f < level; f++) for (const x of [-1.9, 1.9]) g.add(box(0.9, 0.9, 0.15, 0x333333, x, 1 + f * 2.4, 2.55));
    if (level >= 2) g.add(box(0.7, 2.2, 0.7, OX, 1.6, h + 0.6, -0.8));
    if (level >= 3) { g.add(box(3.2, 2.8, 4, BONE, 4.4, 0, -0.3)); const wing = gable(3.4, 1.4, 4.4, OX, 2.8); wing.position.set(4.4, 2.8, -0.3); g.add(wing); }
  } else if (kind === 'workshop') {
    g.add(box(8, 3.2, 5.5, 0xe4e4e4));
    const n = 2 + level, tw = 8 / n;
    for (let t = 0; t < n; t++) {
      const geo = cached(`st${tw}`, () => {
        const s = new THREE.Shape(); s.moveTo(0, 0); s.lineTo(tw, 0); s.lineTo(0, 1.7); s.closePath();
        const e = new THREE.ExtrudeGeometry(s, { depth: 5.5, bevelEnabled: false }); e.translate(0, 0, -2.75); return e;
      });
      const m = inked(new THREE.Mesh(geo, mat(SAND)));
      m.position.set(-4 + t * tw, 3.2, 0);
      g.add(m);
    }
    const ch = inked(new THREE.Mesh(cached(`cy${level}`, () => new THREE.CylinderGeometry(0.55, 0.65, 4 + 1.5 * level, 12)), mat(OX)));
    ch.position.set(2.6, (4 + 1.5 * level) / 2, -1.6);
    g.add(ch);
    g.add(box(1.8, 2.2, 0.2, INK, -1.5, 0, 2.8));
    for (let p = 0; p < 3; p++) {
      const puff = new THREE.Mesh(cached('puff', () => new THREE.SphereGeometry(0.7, 10, 8)), new THREE.MeshStandardMaterial({ color: 0xf5f5f5, transparent: true, opacity: 0.7, roughness: 1 }));
      puff.userData = { base: new THREE.Vector3(2.6, 4 + 1.5 * level, -1.6), phase: p / 3 };
      smoke.push(puff); g.add(puff);
    }
  } else if (kind === 'shop') {
    const h = 3 + level * 1.2;
    g.add(box(6.5, h, 6, BONE));
    const aw = inked(new THREE.Mesh(boxGeo(7, 0.25, 2), mat(own)));
    aw.position.set(0, h - 0.9, 3.7); aw.rotation.x = 0.38; g.add(aw);
    g.add(box(4.2, 1.1, 0.25, SAND, 0, h - 0.2, 3.1));
    g.add(box(2.2, 1.6, 0.15, 0x333333, -1.6, 0.4, 3.05));
    g.add(box(1.1, 2.1, 0.15, INK, 1.7, 0, 3.05));
    if (level >= 3) g.add(box(6.5, 0.4, 6, own, 0, h, 0));
  } else if (kind === 'tower') {
    const h = 8 + level * 6;
    g.add(box(7.5, 1.4, 7.5, SAND));
    const shaft = inked(new THREE.Mesh(boxGeo(5.2, h, 5.2), towerMat(level)));
    shaft.position.y = 1.4 + h / 2; g.add(shaft);
    const cap = inked(new THREE.Mesh(cached('cap', () => new THREE.ConeGeometry(3.9, 3.2, 4)), mat(BRASS, 'metal')));
    cap.rotation.y = Math.PI / 4; cap.position.y = 1.4 + h + 1.6; g.add(cap);
    g.add(box(5.6, 0.5, 5.6, own, 0, 1.4 + h - 0.5, 0));
    if (level >= 3) g.add(box(0.2, 4, 0.2, INK, 0, 1.4 + h + 3, 0));
  } else if (kind === 'office') {
    g.add(box(9.5, 1, 9.5, SAND));
    g.add(box(7.4, 5, 6, BONE, 0, 1, -0.8));
    for (let c = 0; c < 4; c++) {
      const col = inked(new THREE.Mesh(cached('col', () => new THREE.CylinderGeometry(0.42, 0.48, 5, 12)), mat(BONE)));
      col.position.set(-3 + c * 2, 3.5, 3.4); g.add(col);
    }
    g.add(box(8.6, 0.6, 7.8, BONE, 0, 6, -0.2));
    const ped = gable(8.6, 1.8, 7.8, BONE, 6.6); ped.position.z = -0.2; g.add(ped);
    const dome = inked(new THREE.Mesh(cached('dome', () => new THREE.SphereGeometry(2.4, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)), mat(BRASS, 'metal')));
    dome.position.set(0, 7.6, -0.8); g.add(dome);
  }
  return g;
}

export function signTexture(lines, fill, textColor) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 104;
  const g = c.getContext('2d');
  g.fillStyle = fill; g.fillRect(0, 0, 256, 104);
  g.strokeStyle = '#0b0b0b'; g.lineWidth = 6; g.strokeRect(3, 3, 250, 98);
  g.fillStyle = textColor; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '700 30px "JetBrains Mono", monospace'; g.fillText(lines[0], 128, 36);
  g.font = '28px "JetBrains Mono", monospace'; g.fillText(lines[1], 128, 74);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function paperTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f0f0f0'; g.fillRect(0, 0, 256, 256);
  let s = 3; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let n = 0; n < 2600; n++) { g.fillStyle = `rgba(0,0,0,${0.05 + r() * 0.08})`; g.fillRect(r() * 256, r() * 256, 1.2, 1.2); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(24, 24);
  return t;
}

export function createHood3D(container, labels, { now, onPick }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf2f2f2);
  scene.fog = new THREE.Fog(0xf2f2f2, 190, 420);
  const camera = new THREE.PerspectiveCamera(36, 1, 1, 1500);
  camera.position.set(92, 96, 118);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.maxPolarAngle = 1.3; controls.minDistance = 28; controls.maxDistance = 300; controls.screenSpacePanning = false;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9a9a, 1.25));
  const sun = new THREE.DirectionalLight(0xffffff, 2.3);
  sun.position.set(-60, 120, 55); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 80, bottom: -80, near: 10, far: 340 });
  sun.shadow.bias = -0.0006;
  scene.add(sun);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), new THREE.MeshStandardMaterial({ map: paperTexture(), roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
  const span = GRID * PITCH + 6;
  const table = inked(new THREE.Mesh(new THREE.BoxGeometry(span, 0.4, span), mat(STREET)), false);
  table.position.y = 0.2; scene.add(table);
  const dashPts = [];
  for (let q = 0; q < GRID - 1; q++) {
    const v = wx(q + 0.5);
    dashPts.push(v, 0.42, -span / 2 + 3, v, 0.42, span / 2 - 3, -span / 2 + 3, 0.42, v, span / 2 - 3, 0.42, v);
  }
  const dashGeo = new THREE.BufferGeometry(); dashGeo.setAttribute('position', new THREE.Float32BufferAttribute(dashPts, 3));
  const dashes = new THREE.LineSegments(dashGeo, new THREE.LineDashedMaterial({ color: INK, dashSize: 1.2, gapSize: 1.4, transparent: true, opacity: 0.3 }));
  dashes.computeLineDistances(); scene.add(dashes);

  const selGeo = (() => { const s = new THREE.Shape(); const o = LOT / 2 + 0.9, i = LOT / 2 + 0.2; s.moveTo(-o, -o); s.lineTo(o, -o); s.lineTo(o, o); s.lineTo(-o, o); s.closePath(); const h = new THREE.Path(); h.moveTo(-i, -i); h.lineTo(-i, i); h.lineTo(i, i); h.lineTo(i, -i); h.closePath(); s.holes.push(h); return new THREE.ShapeGeometry(s); })();
  const selection = new THREE.Mesh(selGeo, new THREE.MeshBasicMaterial({ color: OX }));
  selection.rotation.x = -Math.PI / 2; selection.position.y = 0.45; selection.visible = false; scene.add(selection);

  let S = null, active = true, raf = 0, focus = null;
  const lotObjs = new Map(), agentObjs = new Map(), pickables = [], smoke = [], flags = [], fx = [];

  function lotGroup(l) {
    const g = new THREE.Group();
    const c = l.i % GRID, r = Math.floor(l.i / GRID);
    g.position.set(wx(c), 0, wx(r));
    const ownerHex = l.owner && l.owner !== 'office' ? colorOf(S, l.owner) : null;
    const tileColor = l.owner === 'office' ? 0xdcdcdc : ownerHex ? new THREE.Color(BONE).lerp(new THREE.Color(ownerHex), 0.22).getHex() : l.foreclosed ? 0xe0e0e0 : BONE;
    const tile = inked(new THREE.Mesh(boxGeo(LOT, 0.5, LOT), mat(tileColor)), false);
    tile.position.y = 0.65; g.add(tile);
    if (ownerHex) {
      g.add(box(LOT, 0.1, 0.8, ownerHex, 0, TOP, LOT / 2 - 0.4));
      const pole = inked(new THREE.Mesh(cached('pole', () => new THREE.CylinderGeometry(0.1, 0.1, 6, 6)), mat(INK)));
      pole.position.set(-LOT / 2 + 0.6, TOP + 3, -LOT / 2 + 0.6); g.add(pole);
      const flag = new THREE.Mesh(cached('flag', () => { const f = new THREE.PlaneGeometry(2.2, 1.3, 6, 1); f.translate(1.1, 0, 0); return f; }), new THREE.MeshStandardMaterial({ color: ownerHex, side: THREE.DoubleSide, roughness: 0.8 }));
      flag.position.set(-LOT / 2 + 0.6, TOP + 5.3, -LOT / 2 + 0.6); flag.castShadow = true;
      flag.userData.phase = l.i; flags.push(flag); g.add(flag);
    }
    const inner = l.owner === 'office' ? building('office', 0, '#0b0b0b', smoke) : l.build ? building(l.build.kind, l.build.level, ownerHex || '#777777', smoke) : null;
    if (inner) { inner.position.y = TOP; g.add(inner); }
    const L = S.listings.find(x => x.lot === l.i);
    if (L) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: signTexture([L.foreclosure ? 'FORECLOSED' : 'FOR SALE', sol(L.price)], L.foreclosure ? '#0b0b0b' : '#ffffff', L.foreclosure ? '#ffffff' : '#0b0b0b'), depthWrite: false }));
      sp.scale.set(6.4, 2.6, 1); sp.position.set(0, TOP + (l.build ? 13 + (l.build.kind === 'tower' ? l.build.level * 6 : 0) : 5), 0);
      g.add(sp);
    }
    g.traverse(o => { if (o.isMesh) { o.userData.lot = l.i; pickables.push(o); } });
    return g;
  }

  function dispose(g) {
    g.traverse(o => {
      const k = pickables.indexOf(o); if (k >= 0) pickables.splice(k, 1);
      const s = smoke.indexOf(o); if (s >= 0) { smoke.splice(s, 1); o.material.dispose(); }
      const f = flags.indexOf(o); if (f >= 0) { flags.splice(f, 1); o.material.dispose(); }
      if (o.isSprite) { o.material.map.dispose(); o.material.dispose(); }
    });
    scene.remove(g);
  }

  function syncLots() {
    for (const l of S.lots) {
      const L = S.listings.find(x => x.lot === l.i);
      const sig = [l.owner, l.build && `${l.build.kind}${l.build.level}`, l.foreclosed, L && `${L.price}${L.foreclosure}`, l.owner && l.owner !== 'office' ? colorOf(S, l.owner) : ''].join('|');
      const cur = lotObjs.get(l.i);
      if (cur && cur.sig === sig) continue;
      if (cur) dispose(cur.group);
      const group = lotGroup(l);
      scene.add(group);
      lotObjs.set(l.i, { sig, group });
    }
  }

  function syncAgents() {
    S.agents.forEach(a => {
      let o = agentObjs.get(a.id);
      if (!o) {
        const group = new THREE.Group();
        const ball = new THREE.Mesh(cached('ball', () => new THREE.SphereGeometry(1.6, 32, 20)), new THREE.MeshStandardMaterial({ color: a.color, roughness: 0.35, metalness: 0.08 }));
        ball.castShadow = true; ball.userData.agent = a.id;
        const ring = new THREE.Mesh(cached('ring', () => new THREE.TorusGeometry(2.4, 0.16, 8, 48)), mat(INK));
        ring.rotation.x = Math.PI / 2;
        const halo = new THREE.Mesh(cached('halo', () => new THREE.CircleGeometry(2.1, 32)), new THREE.MeshBasicMaterial({ color: a.color, transparent: true, opacity: 0.28 }));
        halo.rotation.x = -Math.PI / 2; halo.position.y = 0.46;
        group.add(ball, ring, halo); scene.add(group); pickables.push(ball);
        const label = document.createElement('div'); label.className = 'alabel';
        labels.append(label);
        o = { group, ball, ring, halo, label, text: '' };
        agentObjs.set(a.id, o);
      }
      const broke = a.status === 'broke';
      o.ball.material.color.set(broke ? new THREE.Color(a.color).lerp(new THREE.Color(0xd2d2d2), 0.7) : a.color);
      o.ring.visible = !!(a.seat && now() - a.seat.lastAt < (S.seatHoldMs || 1_200_000));
      const text = `${a.name.toUpperCase()} · ${sol(a.balance)}${o.ring.visible ? ' · DOT' : ''}${broke ? ' · BROKE' : ''}`;
      if (text !== o.text) { o.label.textContent = text; o.label.style.borderColor = a.color; o.text = text; }
    });
  }

  const coinGeo = new THREE.CylinderGeometry(0.75, 0.75, 0.22, 18);
  const coinMat = mat(BRASS, 'metal');
  const ringGeo = new THREE.RingGeometry(3.2, 4, 48);
  const posOf = (id, t) => {
    if (id === 'office') return new THREE.Vector3(0, 10, 0);
    const idx = S.agents.findIndex(a => a.id === id);
    if (idx < 0) return new THREE.Vector3();
    const p = positionOf(S.agents[idx], idx, t);
    return new THREE.Vector3(wx(p.x), 2.6, wx(p.y));
  };

  function addFx(list) {
    const t = now();
    list.forEach((f, n) => {
      if (f.kind === 'pay') {
        for (let q = 0; q < 5; q++) {
          const m = new THREE.Mesh(coinGeo, coinMat); m.castShadow = true; m.visible = false; scene.add(m);
          fx.push({ kind: 'coin', mesh: m, from: f.from, to: f.to, t0: t + n * 180 + q * 110, dur: 1400 });
        }
      } else {
        const lots = f.kind === 'build' ? [f.lot] : f.lots || [];
        for (const lot of lots) {
          const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: f.kind === 'build' ? BRASS : OX, transparent: true, side: THREE.DoubleSide }));
          m.rotation.x = -Math.PI / 2; m.position.set(wx(lot % GRID), 1.1, wx(Math.floor(lot / GRID)));
          scene.add(m);
          fx.push({ kind: 'ring', mesh: m, t0: t, dur: f.kind === 'build' ? 1400 : 2200 });
        }
      }
    });
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    if (hit) onPick(hit.object.userData.agent ? { agent: hit.object.userData.agent } : { lot: hit.object.userData.lot });
  });

  const tmp = new THREE.Vector3();
  function frame() {
    raf = active ? requestAnimationFrame(frame) : 0;
    if (!S) return;
    const t = now();
    if (focus) {
      const target = posOf(focus.id, t).setY(0);
      controls.target.lerp(target, 0.08);
      if (t > focus.until) focus = null;
    }
    controls.update();
    S.agents.forEach((a, idx) => {
      const o = agentObjs.get(a.id); if (!o) return;
      const p = positionOf(a, idx, t);
      o.group.position.set(wx(p.x), 0, wx(p.y));
      const broke = a.status === 'broke';
      o.ball.position.y = broke ? 1.7 : 2.5 + Math.sin(t / 420 + idx * 1.3) * 0.3 + (p.moving ? Math.abs(Math.sin(t / 160 + idx)) * 0.6 : 0);
      o.ring.position.y = o.ball.position.y; o.ring.rotation.z = t / 900;
      tmp.copy(o.group.position); tmp.y = o.ball.position.y + 2.6;
      tmp.project(camera);
      const vis = tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
      o.label.style.display = vis ? '' : 'none';
      if (vis) o.label.style.transform = `translate(${((tmp.x + 1) / 2) * container.clientWidth}px, ${((1 - tmp.y) / 2) * container.clientHeight}px) translate(-50%, -100%)`;
    });
    for (const f of flags) {
      f.rotation.y = Math.sin(t / 700 + f.userData.phase) * 0.25;
    }
    for (const p of smoke) {
      const k = ((t / 2600 + p.userData.phase) % 1);
      p.position.copy(p.userData.base).add(tmp.set(k * 1.2, k * 5, -k * 0.6));
      p.scale.setScalar(0.5 + k * 1.4);
      p.material.opacity = 0.65 * (1 - k);
    }
    for (let n = fx.length - 1; n >= 0; n--) {
      const f = fx[n], k = (t - f.t0) / f.dur;
      if (k >= 1) { scene.remove(f.mesh); if (f.kind === 'ring') f.mesh.material.dispose(); fx.splice(n, 1); continue; }
      if (k < 0) continue;
      f.mesh.visible = true;
      if (f.kind === 'coin') {
        const a = posOf(f.from, t), b = posOf(f.to, t);
        f.mesh.position.lerpVectors(a, b, k);
        f.mesh.position.y += Math.sin(k * Math.PI) * (8 + a.distanceTo(b) * 0.12);
        f.mesh.rotation.x = t / 120; f.mesh.rotation.z = t / 200;
      } else {
        f.mesh.scale.setScalar(1 + k * 1.8);
        f.mesh.material.opacity = 1 - k;
      }
    }
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    setState(s) { S = s; syncLots(); syncAgents(); },
    addFx,
    select(i) {
      selection.visible = i >= 0;
      if (i >= 0) selection.position.set(wx(i % GRID), 0.45, wx(Math.floor(i / GRID)));
    },
    focusAgent(id) { focus = { id, until: now() + 2500 }; },
    setActive(on) {
      active = on;
      labels.style.display = on ? '' : 'none';
      if (on && !raf) raf = requestAnimationFrame(frame);
    },
  };
}

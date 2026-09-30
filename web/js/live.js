// Live state: one fetch, then server-sent events. Every page reads the hood through this.
export const LAMPORTS = 1e9;
export const GRID = 7;
export const sol = (l, withUnit = true) => {
  const v = l / LAMPORTS;
  const s = Math.abs(v) >= 10 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(3) : v.toFixed(4);
  return withUnit ? `${s} SOL` : s;
};
export const short = a => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');
export const lotName = i => `${'ABCDEFG'[i % GRID]}${Math.floor(i / GRID) + 1}`;
export const scanQuery = s => (s.cluster === 'mainnet-beta' ? '' : `?cluster=${s.cluster}`);
// a simulated chain has nothing on Solscan, so its links are left off
export const scanAccount = (s, a) => (s.cluster === 'sim' ? null : `https://solscan.io/account/${a}${scanQuery(s)}`);
export const scanTx = (s, sig) => (s.cluster === 'sim' ? null : `https://solscan.io/tx/${sig}${scanQuery(s)}`);
export const agentById = (s, id) => s.agents.find(a => a.id === id);
export const colorOf = (s, id) => (id === 'office' ? '#0b0b0b' : agentById(s, id)?.color || '#777777');
export const ago = (t, now = Date.now()) => {
  const d = Math.max(0, (now - t) / 1000);
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
};
export const seatHeld = (a, now, hold = 1_200_000) => !!(a.seat && now - a.seat.lastAt < hold);
export const seatLabel = (a, now, hold) => (a.status === 'broke' ? 'BROKE' : seatHeld(a, now, hold) ? `DOT: ${a.seat.by}` : 'AUTOPILOT');

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}
export const put = (node, ...kids) => { node.replaceChildren(...kids.flat().filter(k => k != null && k !== false)); return node; };

export function connect(onState) {
  let state = null, skew = 0, es = null, retry = 0;
  const apply = (s, feed = [], fx = []) => {
    skew = s.now - Date.now();
    state = s;
    onState(s, { feed, fx });
  };
  fetch('./api/state', { cache: 'no-store' }).then(r => r.json()).then(s => { if (!state) apply(s); }).catch(() => {});
  const open = () => {
    es = new EventSource('./api/stream');
    es.addEventListener('state', e => { retry = 0; const d = JSON.parse(e.data); apply(d.state, d.feed || [], d.fx || []); });
    es.onerror = () => { if (es.readyState === 2) { es.close(); setTimeout(open, Math.min(30000, 1000 * 2 ** retry++)); } };
  };
  open();
  return { get: () => state, now: () => Date.now() + skew };
}

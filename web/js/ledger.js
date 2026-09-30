// The full ledger: every on-chain move since the start, newest first, paged, and live as new moves confirm.
import { connect, sol, scanTx, el, put, agentById } from './live.js';

const $ = id => document.getElementById(id);
const BIG = new Set(['buyout', 'foreclose', 'stake', 'foreclosure_sale']);
let state = null, oldest = Infinity, total = 0, first = true;
const seen = new Set();

const when = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function row(r, fresh) {
  const who = (r.who || []).map(id => (id === 'office' ? null : agentById(state, id))).filter(Boolean);
  const receipt = scanTx(state, r.sig);
  return el('tr', { class: `${BIG.has(r.kind) ? 'big' : ''}${fresh ? ' fresh' : ''}` },
    el('td', { class: 'm', text: when(r.t) }),
    el('td', { class: 'm hide-s', text: r.epoch ?? '' }),
    el('td', { class: 'm' }, who.length ? who.map(a => el('span', { title: a.name }, el('span', { class: 'sw', style: `background:${a.color}` }))) : el('span', { text: 'office' })),
    el('td', { text: r.text }),
    el('td', { class: 'm r hide-s', text: r.lamports ? sol(r.lamports, false) : '' }),
    el('td', { class: 'm r' }, receipt ? el('a', { href: receipt, target: '_blank', rel: 'noopener', text: 'solscan ↗' }) : el('span', { text: r.sig.slice(0, 8) })));
}

async function page() {
  const q = Number.isFinite(oldest) ? `?before=${oldest}&limit=100` : '?limit=100';
  const j = await fetch(`./api/ledger${q}`, { cache: 'no-store' }).then(r => r.json());
  total = j.total;
  const body = $('rows');
  if (first) { put(body); first = false; }
  for (const r of j.rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    body.append(row(r, false));
    oldest = Math.min(oldest, r.id);
  }
  if (!body.children.length) put(body, el('tr', {}, el('td', { colspan: '6', class: 'm', text: 'No on-chain moves yet. The first row will be the office staking the five.' })));
  $('more').hidden = !j.more;
  $('count').textContent = `${total} on-chain moves since the start`;
}

connect((s, { feed }) => {
  const firstState = !state;
  state = s;
  $('cluster').textContent = s.cluster === 'mainnet-beta' ? 'MAINNET' : s.cluster.toUpperCase();
  if (firstState) {
    $('footnote').textContent = `Every row is a real Solana transaction signed by one of the six hood wallets. ${s.cluster === 'mainnet-beta' ? 'This is mainnet: the SOL is real.' : 'On devnet, SOL is free and worth nothing.'}`;
    page();
    return;
  }
  const body = $('rows');
  for (const f of feed) {
    if (!f.sig || seen.has(f.id)) continue;
    seen.add(f.id);
    if (body.firstChild?.querySelector?.('td[colspan]')) put(body);
    body.prepend(row(f, true));
    total++;
    $('count').textContent = `${total} on-chain moves since the start`;
  }
});
$('more').addEventListener('click', page);

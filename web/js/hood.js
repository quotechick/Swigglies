import { connect, sol, short, scanAccount, scanTx, el, put, ago, seatLabel, agentById, lotName, GRID } from './live.js';
import { createPlat } from './plat.js';
import { drawDot } from './sprite.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let view = params.get('view') === '2d' ? '2d' : '3d';
let live, plat = null, hood3d = null, selected = -1, selAgent = null, bannerTimer = 0;
const seen = new Set();
const rows = new Map();

function pick(p) {
  if (p.agent) { focusAgent(p.agent); return; }
  selected = p.lot; selAgent = null;
  plat?.select(selected); hood3d?.select(selected);
  renderLot(live.get());
}

function focusAgent(id) {
  const s = live.get(), a = agentById(s, id);
  hood3d?.focusAgent(id);
  selected = a.at; selAgent = id; plat?.select(-1); hood3d?.select(-1);
  renderLot(s, id);
}

async function setView(v) {
  view = v;
  $('v3d').setAttribute('aria-selected', v === '3d');
  $('v2d').setAttribute('aria-selected', v === '2d');
  const url = new URL(location.href);
  if (v === '2d') url.searchParams.set('view', '2d'); else url.searchParams.delete('view');
  history.replaceState(null, '', url);
  if (v === '3d' && !hood3d) {
    try {
      const { createHood3D } = await import('./hood3d.js');
      hood3d = createHood3D($('view3d'), $('labels'), { now: () => live.now(), onPick: pick });
      const s = live.get();
      if (s) hood3d.setState(s);
      hood3d.select(selected);
    } catch (e) {
      console.error(e);
      $('v3d').disabled = true;
      $('v3d').textContent = '3D unavailable';
      return setView('2d');
    }
  }
  if (v === '2d' && !plat) {
    plat = createPlat($('view2d'), { now: () => live.now(), onPick: i => pick({ lot: i }) });
    const s = live.get();
    if (s) plat.setState(s);
    plat.select(selected);
  }
  $('view3d').hidden = v !== '3d';
  $('view2d').hidden = v !== '2d';
  hood3d?.setActive(v === '3d');
  plat?.setActive(v === '2d');
}

function renderFive(s, now) {
  const list = $('fivelist');
  for (const a of s.agents) {
    let r = rows.get(a.id);
    if (!r) {
      r = { root: el('div', { class: 'drow', role: 'button', tabindex: '0', onclick: () => focusAgent(a.id), onkeydown: e => { if (e.key === 'Enter') focusAgent(a.id); } }), canvas: el('canvas', { width: 24, height: 24 }), stage: null };
      rows.set(a.id, r);
      list.append(r.root);
    }
    if (r.stage !== a.stage) { drawDot(r.canvas, a.color, a.stage); r.stage = a.stage; }
    r.root.classList.toggle('broke', a.status === 'broke');
    put(r.root,
      r.canvas,
      el('span', { class: 'nm', text: a.name }),
      el('span', { class: 'sol', text: sol(a.balance) }),
      el('span', { class: 'sub' },
        el('span', { text: `${seatLabel(a, now, s.seatHoldMs)} · ${a.lots}L ${a.builds}B ${a.crates}C · net ${sol(a.net, false)}` }),
        el('a', { href: scanAccount(s, a.address), target: '_blank', rel: 'noopener', onclick: e => e.stopPropagation(), text: `${short(a.address)}↗` })));
  }
  $('landprice').textContent = `land ${sol(s.lotPrice)}`;
  put($('officebox'),
    el('div', {}, el('b', { text: 'THE OFFICE · D4 ' }), el('a', { href: scanAccount(s, s.office.address), target: '_blank', rel: 'noopener', text: `${short(s.office.address)}↗` })),
    el('div', { text: `${sol(s.office.balance)} · ${s.office.crates} crates · ${s.office.lotsSold} lots sold` }),
    el('div', { text: `${s.totals.txs} txs on chain · ${sol(s.totals.moved)} moved · ${sol(s.totals.fees)} in fees` }));
}

function renderTape(s, now) {
  const items = s.feed.filter(f => f.kind !== 'delist').slice(-40).reverse();
  if (!items.length) { put($('tape'), el('li', { text: 'Nothing has moved yet. Every buy, build and buyout lands here with its Solscan receipt.' })); return; }
  put($('tape'), items.map(f => {
    const li = el('li', { class: `${f.kind}${seen.size && !seen.has(f.id) ? ' fresh' : ''}` },
      el('div', { text: f.text }),
      el('div', { class: 'meta' },
        el('span', { text: `${ago(f.t, now)}${f.by && f.by !== 'autopilot' && f.by !== 'office' ? ` · ${f.by}` : ''}` }),
        f.sig ? el('a', { href: scanTx(s, f.sig), target: '_blank', rel: 'noopener', text: 'receipt ↗' }) : el('span', { text: f.kind === 'say' || f.kind === 'list' || f.kind === 'seat' ? 'off chain' : '' })));
    return li;
  }));
  items.forEach(f => seen.add(f.id));
}

function renderLot(s, agentId) {
  const box = $('p-lot');
  if (!s || selected < 0) { box.hidden = true; return; }
  const close = el('button', { class: 'x', 'aria-label': 'Close', text: '×', onclick: () => { selected = -1; selAgent = null; plat?.select(-1); hood3d?.select(-1); box.hidden = true; } });
  if (agentId) {
    const a = agentById(s, agentId);
    put(box,
      el('h3', {}, el('span', { text: `${a.name} · ${a.stage}` }), close),
      el('dl', {},
        el('dt', { text: 'Wallet' }), el('dd', {}, el('a', { href: scanAccount(s, a.address), target: '_blank', rel: 'noopener', text: `${short(a.address)} ↗` })),
        el('dt', { text: 'SOL' }), el('dd', { text: `${sol(a.balance)} (spendable ${sol(a.spendable)})` }),
        el('dt', { text: 'Estate' }), el('dd', { text: `${sol(a.estate)} · ${a.lots} lots · ${a.builds} builds · ${a.crates} crates` }),
        el('dt', { text: 'Seat' }), el('dd', { text: seatLabel(a, live.now(), s.seatHoldMs) }),
        el('dt', { text: 'Record' }), el('dd', { text: `${a.stats.buyouts} buyouts made · bought out ${a.stats.boughtOut}× · foreclosed ${a.stats.foreclosed}×` }),
        el('dt', { text: 'Standing at' }), el('dd', { text: lotName(a.at) })));
    box.hidden = false;
    return;
  }
  const l = s.lots[selected];
  const owner = l.owner === 'office' ? 'the office' : l.owner ? agentById(s, l.owner).name : l.foreclosed ? 'the office table (foreclosed)' : 'nobody: the office sells it';
  const L = s.listings.find(x => x.lot === l.i);
  put(box,
    el('h3', {}, el('span', { text: l.owner === 'office' ? 'D4 · The office' : `Lot ${l.name}` }), close),
    el('dl', {},
      el('dt', { text: 'Owner' }), el('dd', { text: owner }),
      l.owner !== 'office' && [
        el('dt', { text: 'Build' }), el('dd', { text: l.build ? `${l.build.kind}, level ${l.build.level}` : 'bare' }),
        el('dt', { text: 'Appraisal' }), el('dd', { text: sol(l.appraisal) }),
        el('dt', { text: 'Upkeep' }), el('dd', { text: l.build ? `${sol(l.upkeep)} an epoch` : 'none' }),
        el('dt', { text: 'Market' }), el('dd', { text: L ? `${L.foreclosure ? 'foreclosure' : 'for sale'} #${L.id} at ${sol(L.price)}` : !l.owner && !l.foreclosed ? `the office asks ${sol(s.lotPrice)}` : 'not for sale' })],
      l.owner === 'office' && [
        el('dt', { text: 'Wallet' }), el('dd', {}, el('a', { href: scanAccount(s, s.office.address), target: '_blank', rel: 'noopener', text: `${short(s.office.address)} ↗` })),
        el('dt', { text: 'Holds' }), el('dd', { text: `${sol(s.office.balance)} · ${s.office.crates} crates` }),
        el('dt', { text: 'Rent roll' }), el('dd', { text: `${Math.round(s.rules.dividendRate * 100)}% of what it holds, every epoch` })]));
  box.hidden = false;
}

function banner(s, fx) {
  const big = fx.find(f => f.kind === 'buyout' || f.kind === 'foreclose');
  if (!big) return;
  const b = $('banner');
  if (big.kind === 'buyout') {
    const by = agentById(s, big.by), t = agentById(s, big.target);
    put(b, `${by.name} bought out ${t.name}`, el('small', { text: `${big.lots.length} lots change hands · paid on chain to ${t.name}` }));
  } else {
    const t = agentById(s, big.target);
    put(b, `${t.name} is broke`, el('small', { text: `${big.lots.length} lots to the office table at half appraisal` }));
  }
  b.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.hidden = true; }, 5000);
}

function render(s, { fx }) {
  const now = live.now();
  $('loading').hidden = true;
  $('cluster').textContent = s.cluster === 'mainnet-beta' ? 'MAINNET' : s.cluster.toUpperCase();
  plat?.setState(s); hood3d?.setState(s);
  if (fx.length) { plat?.addFx(fx, s); hood3d?.addFx(fx); banner(s, fx); }
  renderFive(s, now);
  renderTape(s, now);
  if (!$('p-lot').hidden) renderLot(s, selAgent);
  const unfunded = s.agents.every(a => a.balance === 0);
  const jam = $('jam');
  if (unfunded) { jam.textContent = `The five hold no SOL yet. The office stakes them once it holds about ${sol(s.stake?.needs || 0)} (now ${sol(s.office.balance)}).`; jam.hidden = false; }
  else if (s.chain && s.chain.ok === false) { jam.textContent = `The tape is jammed: ${s.chain.error || 'no answer from Solana'}. Moves resume when it clears.`; jam.hidden = false; }
  else jam.hidden = true;
}

function tickClock() {
  const s = live?.get();
  if (!s) return;
  const left = Math.max(0, s.epochAt + s.epochMs - live.now());
  const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
  $('clock').textContent = `EPOCH ${s.epoch} · RENT ROLL IN ${m}:${String(sec).padStart(2, '0')}`;
}

$('v3d').onclick = () => setView('3d');
$('v2d').onclick = () => setView('2d');
document.querySelectorAll('.mobtabs .btn').forEach(b => {
  b.onclick = () => {
    const id = b.dataset.panel, open = !$(id).classList.contains('open');
    document.querySelectorAll('.panel.open').forEach(p => p.classList.remove('open'));
    document.querySelectorAll('.mobtabs .btn').forEach(x => x.setAttribute('aria-pressed', 'false'));
    if (open) { $(id).classList.add('open'); b.setAttribute('aria-pressed', 'true'); }
  };
});

live = connect(render);
setView(view);
setInterval(tickClock, 1000);
setInterval(() => { const s = live.get(); if (s) { renderFive(s, live.now()); renderTape(s, live.now()); } }, 20000);

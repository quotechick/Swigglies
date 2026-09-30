import { connect, sol, short, scanAccount, scanTx, el, put, ago, seatLabel, agentById } from './live.js';
import { createPlat } from './plat.js';
import { drawDot } from './sprite.js';

const $ = id => document.getElementById(id);
const RULE_LINES = [
  'Land costs five per cent more every time the office sells a lot, forever',
  'A dot with more SOL can buy out a dot with less',
  'The buyout price is appraisal plus a fifth, paid to the dot being bought',
  'Miss your upkeep and the office takes the lot and everything on it',
  'Foreclosures open at half appraisal and drop a tenth every epoch nobody bites',
  'No platform fee. The only cut is the network\'s five thousand lamports',
  'Every move is a transaction. Every transaction is on Solscan',
];

let live;
const plat = createPlat($('miniplat'), { mini: true, now: () => live.now() });
const cards = new Map();
let lastTicker = '';

function renderTicker(s) {
  const moves = s.feed.filter(f => !['list', 'delist', 'seat', 'say'].includes(f.kind)).slice(-6).reverse().map(f => f.text);
  const items = [...moves, ...RULE_LINES];
  const sig = items.join('|');
  if (sig === lastTicker) return;
  lastTicker = sig;
  const run = [...items, ...items].map(t => el('span', { text: t.toUpperCase() }));
  put($('ticker'), run);
}

function card(a, s, now) {
  let c = cards.get(a.id);
  if (!c) {
    const canvas = el('canvas', { width: 24, height: 24, 'aria-hidden': 'true' });
    c = { root: el('article', { class: 'dotcard' }), canvas, stage: null };
    cards.set(a.id, c);
    $('fivecards').append(c.root);
  }
  if (c.stage !== a.stage) { drawDot(c.canvas, a.color, a.stage); c.stage = a.stage; }
  c.root.classList.toggle('broke', a.status === 'broke');
  const seat = seatLabel(a, now, s.seatHoldMs);
  put(c.root,
    el('div', { class: 'face' }, c.canvas, el('div', {}, el('h3', { text: a.name }), el('span', { class: `chip ${a.status === 'broke' ? 'pale' : seat.startsWith('DOT') ? 'brass' : ''}`, text: seat }))),
    el('p', { class: 'temper', text: TEMPER[a.id] || '' }),
    el('dl', {},
      el('dt', { text: 'Stage' }), el('dd', { text: a.stage }),
      el('dt', { text: 'Wallet' }), el('dd', { text: sol(a.balance) }),
      el('dt', { text: 'Estate' }), el('dd', { text: sol(a.estate) }),
      el('dt', { text: 'Holds' }), el('dd', { text: `${a.lots} lots · ${a.builds} builds · ${a.crates} crates` })),
    el('a', { class: 'wallet', href: scanAccount(s, a.address), target: '_blank', rel: 'noopener', text: `${short(a.address)} on Solscan ↗` }),
  );
}

const TEMPER = {
  marrow: 'The raider. Sits on cash so it is always the richer dot in the room, then buys out whoever is not.',
  pip: 'The builder. Spends down to the floorboards on land and houses and trusts the rent roll to carry it.',
  soot: 'The maker. Runs workshops, turns every epoch into crates and sells them to whoever wants a tower.',
  brine: 'The vulture. Builds little and waits at the office table, where everything is half price and dropping.',
  lark: 'The trader. Buys whatever is listed under appraisal and lists it again at a third more.',
};

function render(s, { fx }) {
  const now = live.now();
  plat.setState(s);
  if (fx.length) plat.addFx(fx, s);
  const net = s.cluster === 'mainnet-beta' ? 'MAINNET' : s.cluster.toUpperCase();
  $('cluster').textContent = net;
  $('kicker').textContent = `SOLANA ${net}${s.chain && s.chain.ok === false ? ' · THE TAPE IS JAMMED' : ''}`;
  $('slideno').textContent = String(s.epoch).padStart(3, '0');
  $('livetag').textContent = `● EPOCH ${s.epoch} · EVERY MOVE WAITS FOR A HUMAN CLICK`;
  const owned = s.lots.filter(l => l.owner && l.owner !== 'office').length;
  $('heroline').textContent = `5 wallets · ${owned} of 48 lots owned · land ${sol(s.lotPrice)} · ${s.totals.txs} transactions on chain`;
  $('officeline').textContent = `THE OFFICE · ${sol(s.office.balance)} · ${s.office.crates} CRATES`;
  document.querySelectorAll('[data-u]').forEach(n => { n.textContent = sol(s.rules[n.dataset.u] * s.unit); });
  document.querySelectorAll('[data-epoch]').forEach(n => { n.textContent = `${Math.round(s.epochMs / 60000)} minutes`; });

  const ranked = [...s.agents].sort((a, b) => b.net - a.net);
  const top = ranked[0];
  const plate = $('richest');
  drawDot(plate.querySelector('canvas'), top.color, top.stage);
  put(plate.querySelector('div'), el('b', { text: top.name }), el('span', { class: 'kicker', text: `richest · ${sol(top.net)} net · ${top.lots} lots` }));

  renderHour(s, ranked, now);
  for (const a of s.agents) card(a, s, now);

  $('f-office').textContent = sol(s.office.balance);
  $('f-moved').textContent = sol(s.totals.moved);
  $('f-fees').textContent = sol(s.totals.fees);

  put($('walltable'), ranked.map((a, i) => el('tr', {},
    el('td', { class: 'rank', text: String(i + 1).padStart(2, '0') }),
    el('td', { class: 'name' }, el('span', { class: 'sw', style: `background:${a.color}` }), a.name),
    el('td', { class: 'hide-s' }, el('span', { class: `chip ${a.status === 'broke' ? 'pale' : ''}`, text: a.stage })),
    el('td', { class: 'num hide-s', text: `${sol(a.balance)} cash` }),
    el('td', { class: 'num hide-s', text: `${sol(a.estate)} estate` }),
    el('td', { class: 'num' }, el('b', { text: sol(a.net) })))));
  $('wallread').textContent = `sorted by net worth · read ${ago(s.chain?.at || s.now, now)}`;

  const tape = s.feed.filter(f => f.kind !== 'delist').slice(-18).reverse();
  put($('tapelist'), tape.length ? tape.map(f => el('li', { class: f.kind },
    el('span', { class: 'when', text: ago(f.t, now) }),
    el('span', { text: f.text }),
    f.sig ? el('a', { class: 'rx', href: scanTx(s, f.sig), target: '_blank', rel: 'noopener', text: 'receipt ↗' }) : el('span', { class: 'when', text: f.kind === 'list' ? 'listed' : f.by === 'office' ? '' : 'off chain' }))) : el('li', {}, el('span'), el('span', { text: 'Nothing has moved yet. The wallets are waiting for their first SOL.' }), el('span')));

  if (s.cluster === 'mainnet-beta') $('footnote').textContent = 'Swigglies runs on Solana mainnet: the SOL in these six wallets is real, and every move is a real transaction you can check on Solscan. The dots are run by GPT Dots, and they only propose moves: a human clicks every transaction through. The keys live in a separate signer process, sealed at rest; the website and the agents\' connection hold none, and the signer refuses anything that would pay outside the six wallets or that nobody reviewed. Swigglies is not made or endorsed by OpenAI.';
  else if (s.cluster !== 'devnet') $('footnote').textContent = `Swigglies runs on Solana ${s.cluster}. The six wallets were generated on the server that runs the hood; their keys are sealed at rest, and the server moves them only by the rules on this page. The dots are run by GPT Dots; Swigglies is not made or endorsed by OpenAI.`;
  const waiting = !(s.staked ?? s.agents.some(a => a.balance > 0));
  const note = $('unfunded');
  note.hidden = !waiting;
  if (waiting) {
    const per = s.stake?.perDot ? `up to ${sol(s.stake.perDot)}` : 'an equal share';
    const lead = s.office.balance === 0
      ? `The six wallets are empty. Once the office wallet holds about ${sol(s.stake?.needs || 0)}${s.cluster === 'devnet' ? ' of devnet SOL' : ''}, the house proposes the opening stake (${per} for each of the five) and the game starts when it is clicked through. `
      : `The office holds ${sol(s.office.balance)}. Once it holds about ${sol(s.stake?.needs || 0)}, the house proposes the opening stake (${per} for each of the five) and the game starts when it is clicked through. `;
    put(note, lead, el('a', { href: scanAccount(s, s.office.address), target: '_blank', rel: 'noopener', text: `office ${short(s.office.address)} on Solscan ↗` }));
  }
  renderTicker(s);
}

// Dot of the hour: the dot with the most on-chain moves in the last hour; before anyone moves, the richest.
const MOVE_KINDS = new Set(['buy_lot', 'build', 'upgrade', 'buy', 'buyout', 'buy_crates', 'sell_crates', 'foreclosure_sale']);
function renderHour(s, ranked, now) {
  const counts = new Map();
  for (const f of s.feed) if (f.sig && now - f.t < 3_600_000 && (MOVE_KINDS.has(f.kind) || f.kind?.startsWith?.('buy')) && f.who?.[0]) counts.set(f.who[0], (counts.get(f.who[0]) || 0) + 1);
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  const a = best ? agentById(s, best[0]) : ranked[0];
  const box = $('hour');
  box.querySelector('.sw').style.background = a.color;
  box.querySelector('b span').textContent = a.name;
  box.querySelector('.n').textContent = best ? `${best[1]} move${best[1] > 1 ? 's' : ''} this hour` : `richest · ${sol(a.net)}`;
}

// the film, once it is published next to the site
fetch('media/swigglies-90s.mp4', { method: 'HEAD' }).then(r => {
  if (!r.ok) return;
  const v = $('filmvideo');
  v.poster = 'media/swigglies-90s.jpg';
  v.src = 'media/swigglies-90s.mp4';
  $('film').hidden = false;
  $('filmbtn').hidden = false;
}).catch(() => {});

live = connect(render);
setInterval(() => { const s = live.get(); if (s) render(s, { fx: [] }); }, 15000);

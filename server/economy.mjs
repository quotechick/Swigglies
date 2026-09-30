// The rules of the hood. Every move is planned against the current state and returns the SOL
// transfers it needs plus apply(), which mutates the state only after those transfers land.
// Amounts are integer lamports; prices are written in hood units (state.unit lamports).
import { LAMPORTS, SIG_FEE, RENT_MIN } from './solana.mjs';

export const GRID = 7;
export const OFFICE_LOT = 24;           // D4, the middle of the 7x7 plat
export const RESERVE = 2_500_000;       // lamports every wallet keeps back: rent floor + fees
const DUST = 10_000;

export const KINDS = {
  house:    { cost: 3, crates: 0, upkeep: 0.14, weight: 1.0 },
  workshop: { cost: 4, crates: 0, upkeep: 0.2, weight: 0.6, makes: 1 },
  shop:     { cost: 5, crates: 2, upkeep: 0.26, weight: 1.8 },
  tower:    { cost: 8, crates: 5, upkeep: 0.5, weight: 3.6 },
};

export const RULES = {
  lotBase: 2, lotClimb: 1.05,           // land: 2 units, +5% every lot the office sells
  landFrac: 0.8, buildFrac: 0.7,        // appraisal: 80% of land price + 70% of what was spent building
  crateValue: 0.4, officeBid: 0.25, officeAsk: 0.6, crateCap: 40,
  dividendRate: 0.04,                   // the rent roll: 4% of the office's spendable, every epoch
  buyoutPremium: 1.2, shieldEpochs: 4,
  foreclosureCut: 0.5, foreclosureDecay: 0.9, foreclosureFloor: 0.5,
  listingEpochs: 15, maxLevel: 3,
  doleEpochs: 20, dole: 8, recover: 2,
  stages: [50, 150, 300],               // net worth in units: Speck < Dot < Blot < Stain
};
export const STAGE_NAMES = ['Speck', 'Dot', 'Blot', 'Stain'];

const COLS = 'ABCDEFG';
export const lotName = i => `${COLS[i % GRID]}${Math.floor(i / GRID) + 1}`;
export function parseLot(v) {
  if (Number.isInteger(v) && v >= 0 && v < GRID * GRID) return v;
  const m = /^([A-Ga-g])([1-7])$/.exec(String(v ?? '').trim());
  return m ? COLS.indexOf(m[1].toUpperCase()) + (Number(m[2]) - 1) * GRID : null;
}
export const sol = l => `${+(l / LAMPORTS).toFixed(Math.abs(l) >= 10 * LAMPORTS ? 2 : 4)} SOL`;

export const agentOf = (s, id) => s.agents.find(a => a.id === id);
export const ownedBy = (s, id) => s.lots.filter(l => l.owner === id);
export const lotPrice = s => Math.round(RULES.lotBase * s.unit * RULES.lotClimb ** s.office.lotsSold);
export const upkeepOf = (s, lot) => (lot.build ? Math.round(KINDS[lot.build.kind].upkeep * lot.build.level * s.unit) : 0);
export const weightOf = lot => (lot.build ? KINDS[lot.build.kind].weight * lot.build.level : 0);
export const lotAppraisal = (s, lot) => Math.round(RULES.landFrac * lotPrice(s)) + (lot.build ? Math.round(RULES.buildFrac * lot.build.spent) : 0);
export const estate = (s, id) => ownedBy(s, id).reduce((t, l) => t + lotAppraisal(s, l), 0) + Math.round((agentOf(s, id).crates + listedCrates(s, id)) * RULES.crateValue * s.unit);
export const listedCrates = (s, id) => s.listings.filter(L => L.seller === id && L.qty).reduce((t, L) => t + L.qty, 0);
export const spendable = (a, payer = true) => Math.max(0, a.balance - RESERVE - (payer ? SIG_FEE : 0));
export const officeSpendable = s => Math.max(0, s.office.balance - RESERVE - 8 * SIG_FEE);
export const listingFor = (s, i) => s.listings.find(L => L.lot === i);
export function upgradeCost(s, lot) {
  const k = KINDS[lot.build.kind], level = lot.build.level + 1;
  return { lamports: Math.round(k.cost * level * 0.8 * s.unit), crates: k.crates + level };
}
export function stageOf(s, a) {
  if (a.status === 'broke') return 'Pale';
  const net = (a.balance + estate(s, a.id)) / s.unit;
  return STAGE_NAMES[RULES.stages.filter(x => net >= x).length];
}

export function freshState({ unit, cluster, office, agents }) {
  return {
    v: 1, rev: 0, epoch: 0, epochAt: Date.now(), unit, cluster,
    office: { address: office, balance: 0, lotsSold: 0, crates: 0 },
    agents: agents.map(r => ({
      id: r.id, name: r.name, color: r.color, address: r.address, balance: 0, crates: 0,
      status: 'ok', brokeSince: null, shieldUntil: 0,
      at: r.start, from: r.start, movedAt: 0, seat: null,
      stats: { lots: 0, builds: 0, buyouts: 0, boughtOut: 0, foreclosed: 0, trades: 0 },
    })),
    lots: Array.from({ length: GRID * GRID }, (_, i) => ({ i, owner: i === OFFICE_LOT ? 'office' : null, build: null, foreclosed: false })),
    listings: [], nextListing: 1,
    feed: [], nextFeed: 1,
    totals: { txs: 0, moved: 0, fees: 0 },
  };
}

function walk(a, lot, now) {
  if (lot === a.at) return;
  a.from = a.at; a.at = lot; a.movedAt = now;
}

function unlist(s, L) {
  s.listings = s.listings.filter(x => x !== L);
  if (L.qty && L.seller !== 'office') agentOf(s, L.seller).crates += L.qty;
}

export function buyoutCheck(s, a, t) {
  if (!t || t.id === a.id) return { ok: false, why: 'pick another dot' };
  if (a.status !== 'ok') return { ok: false, why: 'a broke dot cannot buy anyone out' };
  const lots = ownedBy(s, t.id);
  if (!lots.length && !t.crates && !listedCrates(s, t.id)) return { ok: false, why: `${t.name} owns nothing to buy` };
  if (s.epoch < t.shieldUntil) return { ok: false, why: `${t.name} is shielded until epoch ${t.shieldUntil}` };
  if (a.balance <= t.balance) return { ok: false, why: `${t.name} holds ${sol(t.balance)} and you hold ${sol(a.balance)}: you can only buy out a dot with less SOL than you` };
  const value = estate(s, t.id), price = Math.ceil(value * RULES.buyoutPremium);
  if (price > spendable(a)) return { ok: false, why: `buying out ${t.name} costs ${sol(price)} and you can spend ${sol(spendable(a))}`, price, value };
  return { ok: true, price, value, lots: lots.length };
}

const clean = t => String(t ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

// One move by one dot. Returns { error } or { payer, transfers, memo, fx, apply(now) -> feed[] }.
export function planMove(s, id, m, now = Date.now()) {
  const a = agentOf(s, id);
  if (!a) return { error: 'no such dot' };
  const U = s.unit, office = s.office.address;
  const fail = error => ({ error });
  const onchain = (transfers, memo, apply, fx = []) => ({ payer: transfers[0].from, transfers, memo: `swigglies: ${memo}`, apply, fx });
  const offchain = apply => ({ payer: null, transfers: [], apply, fx: [] });
  const lotArg = () => parseLot(m.lot);
  const broke = () => a.status !== 'ok' && fail(`${a.name} is broke: top up ${a.address} to put it back in`);

  switch (m.type) {
    case 'walk': {
      const i = lotArg();
      if (i == null) return fail('no such lot (use A1 to G7)');
      return offchain(() => { walk(a, i, now); return []; });
    }

    case 'say': {
      const text = clean(m.text);
      if (!text) return fail('say something');
      return offchain(() => [{ kind: 'say', who: [a.id], text: `${a.name}: “${text}”` }]);
    }

    case 'buy_lot': {
      const i = lotArg();
      if (i == null) return fail('no such lot (use A1 to G7)');
      const lot = s.lots[i];
      if (i === OFFICE_LOT) return fail('the office is not for sale');
      if (lot.owner != null || lot.foreclosed) return fail(`${lotName(i)} is not the office's to sell${listingFor(s, i) ? `: it is listing #${listingFor(s, i).id}` : ''}`);
      if (broke()) return broke();
      const price = lotPrice(s);
      if (price > spendable(a)) return fail(`land costs ${sol(price)} and you can spend ${sol(spendable(a))}`);
      return onchain([{ from: a.address, to: office, lamports: price }], `${a.name} buys ${lotName(i)} from the office`, () => {
        lot.owner = a.id; s.office.lotsSold++; a.stats.lots++; walk(a, i, now);
        return [{ kind: 'buy_lot', who: [a.id], lot: i, lamports: price, text: `${a.name} bought ${lotName(i)} from the office for ${sol(price)}. Land is now ${sol(lotPrice(s))}.` }];
      }, [{ kind: 'pay', from: a.id, to: 'office', lamports: price }]);
    }

    case 'build': {
      const i = lotArg(), k = KINDS[m.kind];
      if (i == null) return fail('no such lot');
      const lot = s.lots[i];
      if (!k) return fail('kind must be house, workshop, shop or tower');
      if (lot.owner !== a.id) return fail(`you do not own ${lotName(i)}`);
      if (lot.build) return fail(`${lotName(i)} already has a ${lot.build.kind}: upgrade it instead`);
      if (listingFor(s, i)) return fail(`${lotName(i)} is listed: delist it first`);
      if (broke()) return broke();
      const cost = Math.round(k.cost * U);
      if (a.crates < k.crates) return fail(`a ${m.kind} needs ${k.crates} crates and you have ${a.crates}`);
      if (cost > spendable(a)) return fail(`a ${m.kind} costs ${sol(cost)} and you can spend ${sol(spendable(a))}`);
      return onchain([{ from: a.address, to: office, lamports: cost }], `${a.name} builds a ${m.kind} on ${lotName(i)}`, () => {
        lot.build = { kind: m.kind, level: 1, spent: cost }; a.crates -= k.crates; a.stats.builds++; walk(a, i, now);
        return [{ kind: 'build', who: [a.id], lot: i, lamports: cost, text: `${a.name} put a ${m.kind} on ${lotName(i)}: ${sol(cost)} to the office${k.crates ? ` and ${k.crates} crates` : ''}.` }];
      }, [{ kind: 'pay', from: a.id, to: 'office', lamports: cost }, { kind: 'build', lot: i }]);
    }

    case 'upgrade': {
      const i = lotArg();
      if (i == null) return fail('no such lot');
      const lot = s.lots[i];
      if (lot.owner !== a.id || !lot.build) return fail(`you have nothing built on ${lotName(i)}`);
      if (lot.build.level >= RULES.maxLevel) return fail(`the ${lot.build.kind} on ${lotName(i)} is already level ${RULES.maxLevel}`);
      if (listingFor(s, i)) return fail(`${lotName(i)} is listed: delist it first`);
      if (broke()) return broke();
      const c = upgradeCost(s, lot);
      if (a.crates < c.crates) return fail(`the upgrade needs ${c.crates} crates and you have ${a.crates}`);
      if (c.lamports > spendable(a)) return fail(`the upgrade costs ${sol(c.lamports)} and you can spend ${sol(spendable(a))}`);
      return onchain([{ from: a.address, to: office, lamports: c.lamports }], `${a.name} upgrades ${lotName(i)}`, () => {
        lot.build.level++; lot.build.spent += c.lamports; a.crates -= c.crates; walk(a, i, now);
        return [{ kind: 'upgrade', who: [a.id], lot: i, lamports: c.lamports, text: `${a.name} took the ${lot.build.kind} on ${lotName(i)} to level ${lot.build.level}: ${sol(c.lamports)} and ${c.crates} crates.` }];
      }, [{ kind: 'pay', from: a.id, to: 'office', lamports: c.lamports }, { kind: 'build', lot: i }]);
    }

    case 'list': {
      const price = Math.round(Number(m.price_sol) * LAMPORTS);
      if (!(price >= 100_000 && price <= 1000 * LAMPORTS)) return fail('price_sol must be between 0.0001 and 1000');
      if (m.crates != null) {
        const qty = Math.floor(Number(m.crates));
        if (!(qty >= 1 && qty <= a.crates)) return fail(`you have ${a.crates} crates to list`);
        return offchain(() => {
          a.crates -= qty;
          const L = { id: s.nextListing++, seller: a.id, lot: null, qty, price, since: s.epoch, foreclosure: false };
          s.listings.push(L);
          return [{ kind: 'list', who: [a.id], listing: L.id, text: `${a.name} put ${qty} crates up for ${sol(price)} (listing #${L.id}).` }];
        });
      }
      const i = lotArg();
      if (i == null) return fail('give a lot (A1 to G7) or a number of crates');
      const lot = s.lots[i];
      if (lot.owner !== a.id) return fail(`you do not own ${lotName(i)}`);
      return offchain(() => {
        const old = listingFor(s, i);
        if (old) s.listings = s.listings.filter(x => x !== old);
        const L = { id: s.nextListing++, seller: a.id, lot: i, qty: 0, price, since: s.epoch, foreclosure: false };
        s.listings.push(L);
        walk(a, i, now);
        const what = lot.build ? `${lotName(i)} with its level ${lot.build.level} ${lot.build.kind}` : `bare ${lotName(i)}`;
        return [{ kind: 'list', who: [a.id], lot: i, listing: L.id, text: `${a.name} put ${what} up for ${sol(price)} (listing #${L.id}).` }];
      });
    }

    case 'delist': {
      const L = s.listings.find(x => x.id === Number(m.listing));
      if (!L || L.seller !== a.id) return fail('that is not one of your listings');
      return offchain(() => { unlist(s, L); return [{ kind: 'delist', who: [a.id], text: `${a.name} pulled listing #${L.id}.` }]; });
    }

    case 'buy': {
      const L = s.listings.find(x => x.id === Number(m.listing));
      if (!L) return fail('no such listing');
      if (L.seller === a.id) return fail('that is your own listing');
      if (broke()) return broke();
      if (L.price > spendable(a)) return fail(`listing #${L.id} costs ${sol(L.price)} and you can spend ${sol(spendable(a))}`);
      const seller = L.seller === 'office' ? null : agentOf(s, L.seller);
      const to = seller ? seller.address : office;
      const what = L.lot != null ? lotName(L.lot) : `${L.qty} crates`;
      return onchain([{ from: a.address, to, lamports: L.price }], `${a.name} buys ${what} from ${seller ? seller.name : 'the office'}`, () => {
        s.listings = s.listings.filter(x => x !== L);
        if (L.lot != null) {
          const lot = s.lots[L.lot];
          lot.owner = a.id; lot.foreclosed = false; walk(a, L.lot, now);
        } else a.crates += L.qty;
        a.stats.trades++;
        const from = seller ? seller.name : L.foreclosure ? 'the office table' : 'the office';
        return [{ kind: L.foreclosure ? 'foreclosure_sale' : 'buy', who: [a.id, ...(seller ? [seller.id] : [])], lot: L.lot, lamports: L.price, text: `${a.name} bought ${what}${L.lot != null && s.lots[L.lot].build ? ` and its ${s.lots[L.lot].build.kind}` : ''} from ${from} for ${sol(L.price)}.` }];
      }, [{ kind: 'pay', from: a.id, to: seller ? seller.id : 'office', lamports: L.price }]);
    }

    case 'buyout': {
      const t = agentOf(s, m.target);
      const chk = buyoutCheck(s, a, t);
      if (!chk.ok) return fail(chk.why);
      const lots = ownedBy(s, t.id).map(l => l.i);
      return onchain([{ from: a.address, to: t.address, lamports: chk.price }], `${a.name} buys out ${t.name}`, () => {
        for (const L of s.listings.filter(x => x.seller === t.id)) unlist(s, L);
        const builds = lots.filter(i => s.lots[i].build).length, crates = t.crates;
        for (const i of lots) s.lots[i].owner = a.id;
        a.crates = Math.min(RULES.crateCap * 2, a.crates + crates); t.crates = 0;
        t.shieldUntil = a.shieldUntil = s.epoch + RULES.shieldEpochs;
        a.stats.buyouts++; t.stats.boughtOut++;
        if (lots.length) walk(a, lots[0], now);
        const parts = [`${lots.length} lot${lots.length === 1 ? '' : 's'}`, `${builds} build${builds === 1 ? '' : 's'}`, `${crates} crate${crates === 1 ? '' : 's'}`];
        return [{ kind: 'buyout', who: [a.id, t.id], lamports: chk.price, text: `${a.name} bought out ${t.name}: ${parts.join(', ')} for ${sol(chk.price)}, paid to ${t.name}. ${t.name} keeps the cash and nothing else.` }];
      }, [{ kind: 'pay', from: a.id, to: t.id, lamports: chk.price }, { kind: 'buyout', by: a.id, target: t.id, lots }]);
    }

    case 'sell_crates': {
      const qty = Math.floor(Number(m.qty));
      if (!(qty >= 1 && qty <= Math.min(10, a.crates))) return fail(`you can sell 1 to ${Math.min(10, a.crates)} crates to the office`);
      const pay = Math.round(qty * RULES.officeBid * U);
      if (pay > officeSpendable(s)) return fail('the office cannot pay for crates right now');
      if (a.balance === 0 && pay < RENT_MIN) return fail('an empty wallet cannot take a payment that small');
      return onchain([{ from: office, to: a.address, lamports: pay }], `office buys ${qty} crates from ${a.name}`, () => {
        a.crates -= qty; s.office.crates += qty;
        return [{ kind: 'sell_crates', who: [a.id], lamports: pay, text: `${a.name} sold ${qty} crates to the office for ${sol(pay)}.` }];
      }, [{ kind: 'pay', from: 'office', to: a.id, lamports: pay }]);
    }

    case 'buy_crates': {
      const qty = Math.floor(Number(m.qty));
      if (!(qty >= 1 && qty <= s.office.crates)) return fail(`the office has ${s.office.crates} crates`);
      if (broke()) return broke();
      const price = Math.round(qty * RULES.officeAsk * U);
      if (price > spendable(a)) return fail(`${qty} crates cost ${sol(price)} and you can spend ${sol(spendable(a))}`);
      return onchain([{ from: a.address, to: office, lamports: price }], `${a.name} buys ${qty} crates from the office`, () => {
        a.crates += qty; s.office.crates -= qty;
        return [{ kind: 'buy_crates', who: [a.id], lamports: price, text: `${a.name} bought ${qty} crates from the office for ${sol(price)}.` }];
      }, [{ kind: 'pay', from: a.id, to: 'office', lamports: price }]);
    }

    default:
      return fail(`unknown move ${m.type}`);
  }
}

function foreclose(s, a) {
  for (const L of s.listings.filter(x => x.seller === a.id)) unlist(s, L);
  const lots = ownedBy(s, a.id);
  for (const lot of lots) {
    lot.owner = null; lot.foreclosed = true;
    s.listings.push({ id: s.nextListing++, seller: 'office', lot: lot.i, qty: 0, price: Math.max(Math.round(lotAppraisal(s, lot) * RULES.foreclosureCut), Math.round(RULES.foreclosureFloor * s.unit)), since: s.epoch, foreclosure: true });
  }
  if (a.crates) {
    s.listings.push({ id: s.nextListing++, seller: 'office', lot: null, qty: a.crates, price: Math.round(a.crates * RULES.officeBid * s.unit), since: s.epoch, foreclosure: true });
    a.crates = 0;
  }
  a.status = 'broke'; a.brokeSince = s.epoch; a.stats.foreclosed++;
  return lots.map(l => l.i);
}

// The epoch: upkeep in, rent roll out, netted to one transfer per dot in one transaction the
// office pays for; then workshops make crates, broke dots are foreclosed, listings age.
export function planEpoch(s, now = Date.now(), rnd = Math.random) {
  const U = s.unit, office = s.office.address;
  const pool = Math.floor(officeSpendable(s) * RULES.dividendRate);
  const live = s.agents.filter(a => a.status === 'ok');
  // Street traffic: each dot's share of the rent roll swings between a quarter and 1.75x its
  // build weight every epoch, so a dot with thin cash can be tipped over by a slow street.
  const traffic = new Map(live.map(a => [a.id, +(0.25 + 1.5 * rnd()).toFixed(2)]));
  const weight = new Map(live.map(a => [a.id, ownedBy(s, a.id).reduce((t, l) => t + weightOf(l), 0) * traffic.get(a.id)]));
  const totalW = [...weight.values()].reduce((x, y) => x + y, 0);
  const transfers = [], broke = [], dole = [], recover = [];
  let paidOut = 0, collected = 0, grossRoll = 0, grossUpkeep = 0;
  for (const a of live) {
    const up = ownedBy(s, a.id).reduce((t, l) => t + upkeepOf(s, l), 0);
    const div = totalW ? Math.floor(pool * weight.get(a.id) / totalW) : 0;
    const net = div - up;
    grossRoll += div; grossUpkeep += up;
    if (net > 0) {
      if (net >= DUST && (a.balance > 0 || net >= RENT_MIN)) { transfers.push({ from: office, to: a.address, lamports: net }); paidOut += net; }
    } else if (net < 0) {
      const owe = -net, cash = spendable(a, false);
      if (cash >= owe) { transfers.push({ from: a.address, to: office, lamports: owe }); collected += owe; }
      else {
        if (cash >= DUST) { transfers.push({ from: a.address, to: office, lamports: cash }); collected += cash; }
        broke.push({ a, owe });
      }
    }
  }
  for (const a of s.agents.filter(x => x.status === 'broke')) {
    if (spendable(a) >= RULES.recover * U) recover.push(a);
    else if (s.epoch - a.brokeSince >= RULES.doleEpochs && officeSpendable(s) - paidOut >= RULES.dole * U) {
      transfers.push({ from: office, to: a.address, lamports: RULES.dole * U }); paidOut += RULES.dole * U; dole.push(a);
    }
  }
  const idOf = addr => (addr === office ? 'office' : s.agents.find(a => a.address === addr).id);
  const apply = () => {
    const feed = [], fx = [];
    s.epoch++; s.epochAt = now;
    for (const a of live) {
      for (const lot of ownedBy(s, a.id)) {
        if (lot.build?.kind === 'workshop') a.crates = Math.min(RULES.crateCap, a.crates + KINDS.workshop.makes * lot.build.level);
      }
    }
    for (const { a, owe } of broke) {
      const lots = foreclose(s, a);
      fx.push({ kind: 'foreclose', target: a.id, lots });
      feed.push({ kind: 'foreclose', who: [a.id], lamports: owe, text: `${a.name} could not cover ${sol(owe)} of upkeep and is broke. ${lots.length ? `${lots.map(lotName).join(', ')} and everything on ${lots.length === 1 ? 'it' : 'them'} went to the office table at half appraisal.` : 'It owned nothing to take.'}` });
    }
    for (const a of recover) { a.status = 'ok'; a.brokeSince = null; feed.push({ kind: 'recover', who: [a.id], text: `Someone topped up ${a.name}. It is back in with ${sol(a.balance)}.` }); }
    for (const a of dole) { a.status = 'ok'; a.brokeSince = null; feed.push({ kind: 'dole', who: [a.id], lamports: RULES.dole * U, text: `After ${RULES.doleEpochs} quiet epochs the office floated ${a.name} ${sol(RULES.dole * U)} to start again.` }); }
    for (const L of [...s.listings]) {
      if (L.foreclosure) L.price = Math.max(Math.round(L.price * RULES.foreclosureDecay), Math.round(RULES.foreclosureFloor * U));
      else if (s.epoch - L.since > RULES.listingEpochs) unlist(s, L);
    }
    if (grossRoll || grossUpkeep) feed.unshift({ kind: 'epoch', who: [], lamports: paidOut, text: `Epoch ${s.epoch}: ${sol(grossRoll)} of rent roll against ${sol(grossUpkeep)} of upkeep, settled net in one transaction.` });
    return { feed, fx };
  };
  return { payer: office, transfers, traffic, memo: `swigglies: epoch ${s.epoch + 1} rent roll`, apply, fx: transfers.map(t => ({ kind: 'pay', from: idOf(t.from), to: idOf(t.to), lamports: t.lamports })) };
}

// What the page and the MCP tools get: the state minus nothing secret, plus derived numbers.
export function publicState(s) {
  return {
    rev: s.rev, epoch: s.epoch, epochAt: s.epochAt, cluster: s.cluster, unit: s.unit, now: Date.now(),
    lotPrice: lotPrice(s), reserve: RESERVE, chain: s.chain || null, totals: s.totals,
    office: { ...s.office, lot: OFFICE_LOT, spendable: officeSpendable(s) },
    agents: s.agents.map(a => {
      const est = estate(s, a.id);
      return {
        id: a.id, name: a.name, color: a.color, address: a.address, balance: a.balance, crates: a.crates,
        status: a.status, shieldUntil: a.shieldUntil, at: a.at, from: a.from, movedAt: a.movedAt,
        seat: a.seat ? { by: a.seat.by, lastAt: a.seat.lastAt } : null,
        estate: est, net: a.balance + est, stage: stageOf(s, a), spendable: spendable(a),
        lots: ownedBy(s, a.id).length, builds: ownedBy(s, a.id).filter(l => l.build).length, stats: a.stats,
      };
    }),
    lots: s.lots.map(l => ({ i: l.i, name: lotName(l.i), owner: l.owner, build: l.build ? { kind: l.build.kind, level: l.build.level } : null, foreclosed: l.foreclosed, appraisal: l.i === OFFICE_LOT ? 0 : lotAppraisal(s, l), upkeep: upkeepOf(s, l) })),
    listings: s.listings.map(L => ({ ...L, name: L.lot != null ? lotName(L.lot) : null })),
    feed: s.feed.slice(-60),
    proposals: (s.proposals || []).slice(-60).map(x => ({ id: x.id, agent: x.agent, move: x.move, by: x.by, at: x.at, status: x.status, payer: x.payer, transfers: x.transfers, memo: x.memo, reason: x.reason || null, sig: x.sig || null, closedAt: x.closedAt || null })),
    rules: { ...RULES, kinds: KINDS },
  };
}

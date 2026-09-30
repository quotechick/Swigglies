// The house autopilot: plays an empty seat by its temperament. It scores the moves the rules
// allow right now and picks one, weighted; it is a rule table, not a model, and says so.
import { KINDS, RULES, OFFICE_LOT, GRID, ownedBy, lotPrice, lotAppraisal, listingFor, upgradeCost, buyoutCheck, spendable, officeSpendable } from './economy.mjs';

const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];
const dist = (a, b) => Math.abs((a % GRID) - (b % GRID)) + Math.abs(Math.floor(a / GRID) - Math.floor(b / GRID));

export function decide(s, a, P, rnd = Math.random) {
  const roam = () => ({ type: 'walk', lot: Math.floor(rnd() * GRID * GRID) });
  if (a.status !== 'ok' || rnd() < P.idle) return roam();
  const U = s.unit, cash = spendable(a), free = cash - P.floor * U;
  const mine = ownedBy(s, a.id);
  const opts = [];
  const add = (score, move) => { if (score > 0 && Number.isFinite(score)) opts.push({ score, move }); };
  const wantsCrates = Object.keys(P.kinds).some(k => KINDS[k].crates > a.crates) || mine.some(l => l.build && l.build.level < RULES.maxLevel);

  for (const t of s.agents) {
    if (t.id === a.id) continue;
    const chk = buyoutCheck(s, a, t);
    if (chk.ok && chk.price <= cash - P.floor * U * 0.5) add(P.raid * 2.2 * (chk.value / chk.price) * (1 + chk.lots * 0.15), { type: 'buyout', target: t.id });
  }

  for (const L of s.listings) {
    if (L.seller === a.id || L.price > free) continue;
    const value = L.lot != null ? lotAppraisal(s, s.lots[L.lot]) : L.qty * RULES.crateValue * U;
    const ratio = value / L.price;
    if (L.lot != null && mine.length >= P.maxLots) continue;
    if (L.foreclosure) add(P.vulture * 1.6 * ratio, { type: 'buy', listing: L.id });
    else if (ratio > 1.02) add(P.trade * 1.4 * ratio, { type: 'buy', listing: L.id });
    else if (L.qty && wantsCrates && ratio > 0.8) add(P.build * 0.9, { type: 'buy', listing: L.id });
  }

  const empty = s.lots.filter(l => l.owner == null && !l.foreclosed && l.i !== OFFICE_LOT);
  if (empty.length && lotPrice(s) <= free && mine.length < P.maxLots) {
    const near = empty.sort((x, y) => dist(x.i, a.at) - dist(y.i, a.at)).slice(0, 4);
    add(P.land * Math.max(0.2, 1.5 - mine.length * 0.12), { type: 'buy_lot', lot: pick(near, rnd).i });
  }

  const bare = mine.filter(l => !l.build && !listingFor(s, l.i));
  if (bare.length) {
    for (const [kind, bias] of Object.entries(P.kinds)) {
      const k = KINDS[kind];
      if (k.cost * U <= free && a.crates >= k.crates) add(P.build * bias * 1.3, { type: 'build', lot: bare[0].i, kind });
    }
  }

  for (const l of mine) {
    if (!l.build || l.build.level >= RULES.maxLevel || listingFor(s, l.i) || !P.kinds[l.build.kind]) continue;
    const c = upgradeCost(s, l);
    if (c.lamports <= free && a.crates >= c.crates) add(P.build * 0.8 * P.kinds[l.build.kind], { type: 'upgrade', lot: l.i });
  }

  if (P.flip && mine.length > 2 && s.listings.filter(L => L.seller === a.id).length < 2) {
    const l = mine.find(x => !listingFor(s, x.i));
    if (l) add(P.flip * 0.45, { type: 'list', lot: l.i, price_sol: +(lotAppraisal(s, l) * P.markup / 1e9).toFixed(4) });
  }

  const spare = a.crates - P.crateKeep;
  if (spare >= 3) {
    const qty = Math.min(spare, 8);
    if (P.crateSeller) add(P.crateSeller, { type: 'list', crates: qty, price_sol: +(qty * RULES.crateValue * 1.1 * U / 1e9).toFixed(4) });
    if (cash < P.floor * U && officeSpendable(s) > qty * RULES.officeBid * U) add(1.2, { type: 'sell_crates', qty: Math.min(qty, 10) });
  }
  if (wantsCrates && s.office.crates > 0) {
    const qty = Math.min(s.office.crates, 5);
    if (qty * RULES.officeAsk * U <= free) add(P.build * 0.5, { type: 'buy_crates', qty });
  }

  if (!opts.length) return roam();
  const total = opts.reduce((t, o) => t + o.score ** 2, 0);
  let r = rnd() * total;
  for (const o of opts) { r -= o.score ** 2; if (r <= 0) return o.move; }
  return opts[opts.length - 1].move;
}

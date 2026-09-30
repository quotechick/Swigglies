// MCP over streamable HTTP (JSON responses): the door the owner's ChatGPT Dot plays through.
// Closed experiment: every request needs one of the owner's seat keys (in the path, ?seat=, or a
// Bearer token). The house key is the Dot's one link: it plays any dot by naming it (agent) on every call, and
// every proposal records which dot it was for. A seat key plays only its own dot. Either way a player only
// proposes; nothing here can execute.
// Without a valid key the door answers 403 to everything, including initialize and looking.
import crypto from 'node:crypto';
import * as E from './economy.mjs';
import { b58encode } from './solana.mjs';
import { ROSTER } from './roster.mjs';
import { SIG_FEE } from './solana.mjs';
import { solscanTx, describeMove } from './hood.mjs';

const IDS = ['marrow', 'pip', 'soot', 'brine', 'lark'];
const AGENT = { type: 'string', enum: IDS, description: 'Which dot this call is for (marrow, pip, soot, brine or lark). Required with the one shared link; a seat key is always its own dot.' };
const LOT = { type: 'string', description: 'A lot on the plat, A1 to G7 (D4 is the office).' };
const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

// Money moves: from a player's seat these only ever create pending proposals (see callTool).
// (listing and delisting too: every change to the game waits for the owner, even one that moves no SOL)
const MONEY = new Set(['hood_buy_lot', 'hood_build', 'hood_upgrade', 'hood_list', 'hood_delist', 'hood_buy', 'hood_buyout', 'hood_crates']);
const PREVIEWABLE = ['hood_buy_lot', 'hood_build', 'hood_upgrade', 'hood_list', 'hood_delist', 'hood_buy', 'hood_buyout', 'hood_crates', 'hood_walk'];

const TOOLS = [
  { name: 'hood_look', description: 'Read the whole hood: the five dots (Solana wallet, SOL, estate, status), all 49 lots, every listing, the land price and the epoch. Read-only.', inputSchema: obj({}), annotations: { readOnlyHint: true } },
  { name: 'hood_rules', description: 'The rules: land, builds, upkeep, the rent roll, buyouts, foreclosure and crates, with current numbers.', inputSchema: obj({}), annotations: { readOnlyHint: true } },
  { name: 'hood_lot', description: 'Inspect one lot: owner, build and level, appraisal, what it would cost you (office price, listing or foreclosure), and its upkeep. Read-only.', inputSchema: obj({ lot: LOT }, ['lot']), annotations: { readOnlyHint: true } },
  { name: 'hood_join', description: 'Take your seat and claim your dot\'s Solana wallet. Call this first. Pass name: how the tape should call you (for example "Pip"). Returns your dot, its wallet address, balance and Solscan link. The seat stays yours while you make any hood_* call at least every twenty minutes.', inputSchema: obj({ agent: AGENT, name: { type: 'string', maxLength: 40 } }) },
  { name: 'hood_preview', description: 'Dry-run a move before making it: exactly what would be paid, from which wallet, to which wallets, the network fee, and whether the auto-signer would sign it right now. Nothing is signed or moved. Pass action (the move tool, e.g. hood_buy_lot) plus that tool\'s own arguments.', inputSchema: obj({ agent: AGENT, action: { type: 'string', enum: PREVIEWABLE }, lot: LOT, kind: { type: 'string', enum: Object.keys(E.KINDS) }, listing: { type: 'integer' }, target: { type: 'string', enum: IDS }, side: { type: 'string', enum: ['sell', 'buy'] }, qty: { type: 'integer', minimum: 1, maximum: 10 }, crates: { type: 'integer', minimum: 1 }, price_sol: { type: 'number', exclusiveMinimum: 0 } }, ['action']), annotations: { readOnlyHint: true } },
  { name: 'hood_proposals', description: 'Your proposals and what happened to each: pending (waiting for the owner), executing (sent, being confirmed), executed (confirmed, with its Solscan receipt), applied (a listing change, no SOL), rejected, stale (the board, price, recipient or fee changed before execution: propose again), expired, void (the owner stopped the hood, the run was revoked, or the server restarted) or failed. Read-only.', inputSchema: obj({ agent: AGENT, status: { type: 'string', enum: ['pending', 'executing', 'executed', 'applied', 'rejected', 'stale', 'expired', 'void', 'failed'] } }), annotations: { readOnlyHint: true } },
  { name: 'hood_proposal', description: 'One proposal by number: its immutable record (seat, action, network, payer, recipients, amounts, fee, memo, expiry, the game-state version it was based on, and the digest the owner approves), its status, and the confirmed Solscan receipt once executed. Read-only.', inputSchema: obj({ id: { type: 'integer' } }, ['id']), annotations: { readOnlyHint: true } },
  { name: 'hood_me', description: 'Your dot: wallet, spendable SOL, lots, crates, and what you can afford right now. Taking any seat tool holds the seat for twenty minutes.', inputSchema: obj({ agent: AGENT }), annotations: { readOnlyHint: true } },
  { name: 'hood_buy_lot', description: 'Propose buying an empty lot from the office at the land price (paid from your dot\'s wallet once executed; land then costs 5% more). PROPOSES only: it creates a pending proposal and signs nothing; the owner reviews and executes it. Follow it with hood_proposals.', inputSchema: obj({ agent: AGENT, lot: LOT }, ['lot']) },
  { name: 'hood_build', description: 'Build on a lot you own: house (3 units), workshop (4, makes crates every epoch), shop (5 + 2 crates), tower (8 + 5 crates), paid to the office. PROPOSES only: it creates a pending proposal and signs nothing; the owner reviews and executes it. Follow it with hood_proposals.', inputSchema: obj({ agent: AGENT, lot: LOT, kind: { type: 'string', enum: Object.keys(E.KINDS) } }, ['lot', 'kind']) },
  { name: 'hood_upgrade', description: 'Propose taking a build up one level (max 3). Costs SOL and crates; upkeep and rent roll scale with level. PROPOSES only: it creates a pending proposal and signs nothing; the owner reviews and executes it. Follow it with hood_proposals.', inputSchema: obj({ agent: AGENT, lot: LOT }, ['lot']) },
  { name: 'hood_list', description: 'Propose putting a lot you own (with whatever is on it) or some of your crates up for sale at price_sol. PROPOSES only: the listing appears once the owner applies it. Listing moves no SOL; the buyer pays you wallet to wallet.', inputSchema: obj({ agent: AGENT, lot: LOT, crates: { type: 'integer', minimum: 1 }, price_sol: { type: 'number', exclusiveMinimum: 0 } }, ['price_sol']) },
  { name: 'hood_delist', description: 'Propose pulling one of your listings. PROPOSES only: it comes down once the owner applies it.', inputSchema: obj({ agent: AGENT, listing: { type: 'integer' } }, ['listing']) },
  { name: 'hood_buy', description: 'Buy a listing by its number: another dot\'s lot or crates, or a foreclosure on the office table. PROPOSES only: it creates a pending proposal and signs nothing; the owner reviews and executes it. Follow it with hood_proposals.', inputSchema: obj({ agent: AGENT, listing: { type: 'integer' } }, ['listing']) },
  { name: 'hood_buyout', description: 'Buy out another dot that holds less SOL than you: every lot, build and crate it owns, for appraisal x 1.2, paid to that dot. PROPOSES only: it creates a pending proposal and signs nothing; the owner reviews and executes it. Follow it with hood_proposals.', inputSchema: obj({ agent: AGENT, target: { type: 'string', enum: IDS } }, ['target']) },
  { name: 'hood_crates', description: 'Trade crates with the office: side "sell" (office pays 0.25 units each) or "buy" (0.6 units each, from its stock). PROPOSES only: it creates a pending proposal and signs nothing; the owner reviews and executes it. Follow it with hood_proposals.', inputSchema: obj({ agent: AGENT, side: { type: 'string', enum: ['sell', 'buy'] }, qty: { type: 'integer', minimum: 1, maximum: 10 } }, ['side', 'qty']) },
  { name: 'hood_walk', description: 'Walk your dot to a lot. Costs nothing.', inputSchema: obj({ agent: AGENT, lot: LOT }, ['lot']) },
  { name: 'hood_say', description: 'Say one line on the tape (160 characters).', inputSchema: obj({ agent: AGENT, text: { type: 'string', maxLength: 160 } }, ['text']) },
];

const MOVES = {
  hood_buy_lot: a => ({ type: 'buy_lot', lot: a.lot }),
  hood_build: a => ({ type: 'build', lot: a.lot, kind: a.kind }),
  hood_upgrade: a => ({ type: 'upgrade', lot: a.lot }),
  hood_list: a => ({ type: 'list', lot: a.lot, crates: a.crates, price_sol: a.price_sol }),
  hood_delist: a => ({ type: 'delist', listing: a.listing }),
  hood_buy: a => ({ type: 'buy', listing: a.listing }),
  hood_buyout: a => ({ type: 'buyout', target: a.target }),
  hood_crates: a => ({ type: a.side === 'buy' ? 'buy_crates' : 'sell_crates', qty: a.qty }),
  hood_walk: a => ({ type: 'walk', lot: a.lot }),
  hood_say: a => ({ type: 'say', text: a.text }),
};

export function makeSeats() {
  const key = () => `dh_${b58encode(crypto.randomBytes(18))}`;
  return { house: key(), ...Object.fromEntries(IDS.map(id => [id, key()])) };
}

function seatFor(seats, token) {
  if (!token) return null;
  const t = Buffer.from(String(token));
  for (const [who, key] of Object.entries(seats)) {
    const k = Buffer.from(key);
    if (k.length === t.length && crypto.timingSafeEqual(k, t)) return who === 'house' ? { house: true } : { agent: who };
  }
  return null;
}

const sol = E.sol;

function lookText(p) {
  const lines = [`Swigglies on Solana ${p.cluster}. Epoch ${p.epoch}. Land costs ${sol(p.lotPrice)}. Office wallet ${p.office.address} holds ${sol(p.office.balance)} and ${p.office.crates} crates.`, '', 'THE FIVE'];
  for (const a of p.agents) lines.push(`- ${a.name} (${a.id}) ${a.stage}${a.status === 'broke' ? ' BROKE' : ''}: ${sol(a.balance)} in ${a.address}, estate ${sol(a.estate)}, ${a.lots} lots, ${a.builds} builds, ${a.crates} crates${a.shieldUntil > p.epoch ? `, shielded to epoch ${a.shieldUntil}` : ''}${a.seat ? `, seat held by ${a.seat.by}` : ', autopilot'}`);
  lines.push('', 'THE PLAT (lot: owner build)');
  const row = [];
  for (const l of p.lots) {
    const tag = l.i === p.office.lot ? 'OFFICE' : l.owner ? `${l.owner}${l.build ? ` ${l.build.kind}${l.build.level}` : ''}` : l.foreclosed ? `foreclosed${l.build ? ` ${l.build.kind}${l.build.level}` : ''}` : 'empty';
    row.push(`${l.name}:${tag}`);
    if (row.length === 7) { lines.push(row.join('  ')); row.length = 0; }
  }
  lines.push('', 'LISTINGS');
  if (!p.listings.length) lines.push('- none');
  for (const L of p.listings) lines.push(`- #${L.id} ${L.lot != null ? L.name : `${L.qty} crates`} for ${sol(L.price)} from ${L.seller === 'office' ? 'the office' : L.seller}${L.foreclosure ? ' (foreclosure, drops 10%/epoch)' : ''}`);
  lines.push('', 'LAST MOVES');
  for (const f of p.feed.slice(-8)) lines.push(`- ${f.text}`);
  return lines.join('\n');
}

function rulesText(p) {
  const u = n => sol(n * p.unit);
  const k = p.rules.kinds;
  return [
    `One hood unit is ${sol(p.unit)}. Every wallet keeps ${sol(p.reserve)} back for rent and fees.`,
    `LAND: the office sells empty lots at ${u(p.rules.lotBase)}, +5% every lot sold (now ${sol(p.lotPrice)}).`,
    `BUILD: ${Object.entries(k).map(([n, v]) => `${n} ${u(v.cost)}${v.crates ? ` + ${v.crates} crates` : ''}, upkeep ${u(v.upkeep)}/level/epoch`).join('; ')}. Upgrades to level 3 cost 0.8 x cost x level plus crates.`,
    `RENT ROLL: every epoch (${Math.round(p.epochMs / 1000)} s) the office pays out 4% of what it holds, split by build weight (house 1, workshop 0.6, shop 1.8, tower 3.6, times level) times that epoch's street traffic for each dot (0.25x to 1.75x). Upkeep is netted against it in one transaction.`,
    `BUYOUT: a dot with more SOL than another can buy it out for appraisal x 1.2, paid to the target. Both are then shielded for ${p.rules.shieldEpochs} epochs.`,
    `FORECLOSURE: a dot that cannot cover its upkeep is broke; its lots and crates go to the office table at half appraisal, dropping 10% an epoch. After ${p.rules.doleEpochs} epochs broke, the office floats it ${u(p.rules.dole)}.`,
    `CRATES: workshops make one per level per epoch. The office buys at ${u(p.rules.officeBid)} and sells at ${u(p.rules.officeAsk)}.`,
    'No platform fee: the only cut is the network fee of 5000 lamports per signature.',
  ].join('\n');
}

function meText(p, id) {
  const a = p.agents.find(x => x.id === id);
  const mine = p.lots.filter(l => l.owner === id);
  return [
    `${a.name}, ${a.stage}. Wallet ${a.address} holds ${sol(a.balance)}; you can spend ${sol(a.spendable)}. Estate ${sol(a.estate)}, net ${sol(a.net)}. ${a.crates} crates.`,
    `Your lots: ${mine.length ? mine.map(l => `${l.name}${l.build ? ` (${l.build.kind} L${l.build.level}, upkeep ${sol(l.upkeep)})` : ' (bare)'}`).join(', ') : 'none'}.`,
    `Land costs ${sol(p.lotPrice)}. Dots you could buy out (less SOL than you): ${p.agents.filter(t => t.id !== id && t.balance < a.balance && (t.lots || t.crates) && t.shieldUntil <= p.epoch).map(t => `${t.name} for about ${sol(Math.ceil(t.estate * 1.2))}`).join(', ') || 'none'}.`,
  ].join('\n');
}

function lotText(p, lotArg) {
  const i = E.parseLot(lotArg);
  const out = t => ({ content: [{ type: 'text', text: t }] });
  if (i == null) return { ...out('No such lot: use A1 to G7.'), isError: true };
  const l = p.lots[i];
  if (l.owner === 'office') return out(`D4 is the office: wallet ${p.office.address}, holding ${sol(p.office.balance)} and ${p.office.crates} crates. It sells land (now ${sol(p.lotPrice)}), takes builds and upkeep, and pays the rent roll. Not for sale.`);
  const L = p.listings.find(x => x.lot === i);
  const owner = l.owner ? p.agents.find(a => a.id === l.owner).name : l.foreclosed ? 'the office table (foreclosed)' : 'nobody';
  const cost = L ? `${L.foreclosure ? 'foreclosure' : 'listing'} #${L.id} asks ${sol(L.price)}${L.foreclosure ? ', dropping 10% an epoch' : ''} (buy it with hood_buy)` : !l.owner && !l.foreclosed ? `the office sells it for ${sol(p.lotPrice)} (hood_buy_lot)` : 'not for sale';
  return out(`Lot ${l.name}: owned by ${owner}. ${l.build ? `A level ${l.build.level} ${l.build.kind}` : 'Bare'}. Appraisal ${sol(l.appraisal)}. Cost to you: ${cost}. Upkeep ${l.upkeep ? `${sol(l.upkeep)} an epoch` : 'none while bare'}.`);
}

function joinText(p, id, tag) {
  const a = p.agents.find(x => x.id === id);
  const r = ROSTER.find(x => x.id === id);
  const scan = p.cluster === 'sim' ? '' : ` (https://solscan.io/account/${a.address}${scanQ(p)})`;
  const funded = !(p.office.balance === 0 && p.agents.every(x => x.balance === 0));
  return [
    `You are ${a.name} in Swigglies on Solana ${p.cluster}, seated as "${tag}". ${r.temper}`,
    `Your wallet: ${a.address}${scan}.`,
    'It is yours to play while you hold the seat. The hood keeps its key and signs exactly the moves you choose, under the rules, so every buy, build, upgrade and buyout comes out of this wallet and lands on chain with a receipt. The only other things that touch it are the rules: upkeep and the rent roll each epoch, and buyouts, which pay you.',
    `Balance: ${sol(a.balance)}, spendable ${sol(a.spendable)}.${funded ? '' : ' The game is waiting for funding: when the office wallet is funded it stakes all five dots at once and your balance will show here. Until then you can look, inspect lots and walk.'}`,
    `Keep the seat by making any hood_* call at least every ${Math.round((p.seatHoldMs || 1_200_000) / 60000)} minutes. Next: hood_rules once, then hood_me at the start of each turn.`,
  ].join('\n');
}

// Read-only standings for spectators (a dot browsing, a person, a script): no seat, no control.
const scanQ = p => (p.cluster === 'mainnet-beta' ? '' : `?cluster=${p.cluster}`);
const seatOf = (p, a) => (a.status === 'broke' ? 'broke' : a.seat && p.now - a.seat.lastAt < (p.seatHoldMs || 1_200_000) ? `dot: ${a.seat.by}` : 'autopilot');

export function standingsJson(p) {
  const ranked = [...p.agents].sort((x, y) => y.net - x.net);
  const scan = p.cluster !== 'sim';
  return {
    game: 'Swigglies', cluster: p.cluster, epoch: p.epoch, read_at: new Date(p.now).toISOString(),
    land_price_sol: p.lotPrice / 1e9, lots_owned: p.lots.filter(l => l.owner && l.owner !== 'office').length, lots_total: 48,
    funded: p.staked ?? !(p.office.balance === 0 && p.agents.every(a => a.balance === 0)),
    stake_per_dot_sol: p.stake ? p.stake.perDot / 1e9 : null,
    office: { wallet: p.office.address, sol: p.office.balance / 1e9, crates: p.office.crates, solscan: scan ? `https://solscan.io/account/${p.office.address}${scanQ(p)}` : null },
    dots: ranked.map((a, i) => ({
      rank: i + 1, id: a.id, name: a.name, stage: a.stage, status: a.status, seat: seatOf(p, a),
      sol: a.balance / 1e9, estate_sol: a.estate / 1e9, net_sol: a.net / 1e9, lots: a.lots, builds: a.builds, crates: a.crates,
      record: a.stats, wallet: a.address, solscan: scan ? `https://solscan.io/account/${a.address}${scanQ(p)}` : null,
    })),
    listings: p.listings.map(L => ({ id: L.id, what: L.lot != null ? L.name : `${L.qty} crates`, price_sol: L.price / 1e9, seller: L.seller, foreclosure: L.foreclosure })),
    last_moves: p.feed.filter(f => !['delist'].includes(f.kind)).slice(-15).reverse().map(f => ({ at: new Date(f.t).toISOString(), kind: f.kind, text: f.text, receipt: f.sig && scan ? `https://solscan.io/tx/${f.sig}${scanQ(p)}` : null })),
  };
}

export function standingsText(p, publicUrl = '') {
  const j = standingsJson(p);
  const n = v => `${+v.toFixed(4)} SOL`;
  const lines = [`Swigglies standings · Solana ${j.cluster} · epoch ${j.epoch} · read ${j.read_at}`];
  if (!j.funded) lines.push(`The five hold no SOL yet: the office stakes each${j.stake_per_dot_sol ? ` with up to ${n(j.stake_per_dot_sol)}` : ''} once it is funded${p.stake?.needs ? ` with about ${n(p.stake.needs / 1e9)}` : ''} (it holds ${n(j.office.sol)} now).`);
  lines.push(`Land ${n(j.land_price_sol)} · ${j.lots_owned}/48 lots owned · office ${n(j.office.sol)}, ${j.office.crates} crates`, '');
  for (const d of j.dots) {
    lines.push(`${d.rank}. ${d.name} (${d.stage}${d.status === 'broke' ? ', BROKE' : ''}) net ${n(d.net_sol)} = ${n(d.sol)} cash + ${n(d.estate_sol)} estate · ${d.lots} lots, ${d.builds} builds, ${d.crates} crates · ${d.seat}`);
    lines.push(`   wallet ${d.wallet}${d.solscan ? ` · ${d.solscan}` : ''}`);
  }
  lines.push('', 'LISTINGS');
  if (!j.listings.length) lines.push('- none');
  for (const L of j.listings) lines.push(`- #${L.id} ${L.what} for ${n(L.price_sol)} from ${L.seller}${L.foreclosure ? ' (foreclosure)' : ''}`);
  lines.push('', 'LAST MOVES');
  if (!j.last_moves.length) lines.push('- none yet');
  for (const m of j.last_moves) lines.push(`- ${m.at.slice(11, 19)} ${m.text}${m.receipt ? ` · receipt ${m.receipt}` : ''}`);
  if (publicUrl) lines.push('', `Watch: ${publicUrl} · 3D: ${publicUrl}hood · 2D: ${publicUrl}hood?view=2d · JSON: ${publicUrl}api/standings.json`);
  return lines.join('\n') + '\n';
}

export function createMcp({ hood, seats }) {
  const sessions = new Map();
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

  // hood_preview: plan the move against the live state without applying or signing it, then ask the
  // auto-signer's guard (guard.mjs) whether it would sign. The state is untouched.
  async function preview(args, id) {
    if (!PREVIEWABLE.includes(args.action)) return text(`action must be one of: ${PREVIEWABLE.join(', ')}`, true);
    const plan = E.planMove(hood.s, id, MOVES[args.action](args));
    if (plan.error) return { ...text(`The rules would refuse this, so there is nothing to sign: ${plan.error}`), structuredContent: { action: args.action, would_sign: false, reason: plan.error } };
    if (!plan.transfers.length) return { ...text('No transaction needed: this move is free and happens off chain.'), structuredContent: { action: args.action, on_chain: false, would_sign: true } };
    const nameOf = addr => (addr === hood.s.office.address ? 'the office' : hood.s.agents.find(a => a.address === addr)?.name || addr);
    const signers = new Set([plan.payer, ...plan.transfers.map(t => t.from)]).size;
    const pr = hood.chain.priority;
    const fee = SIG_FEE * signers + (pr ? Math.ceil((pr.units * pr.microLamports) / 1e6) : 0);
    const verdict = hood.chain.check ? await hood.chain.check({ payer: plan.payer, transfers: plan.transfers, memo: plan.memo }) : { ok: true, why: null };
    const left = hood.chain.remainingToday ? await hood.chain.remainingToday(plan.payer) : null;
    const transfers = plan.transfers.map(t => ({ from: t.from, from_name: nameOf(t.from), to: t.to, to_name: nameOf(t.to), lamports: t.lamports }));
    const lines = [
      `${nameOf(plan.payer)} would pay ${transfers.map(t => `${sol(t.lamports)} to ${t.to_name}`).join(', ')}, plus a network fee of about ${sol(fee)}.`,
      `Memo on chain: "${plan.memo}". Every counterparty is a hood wallet.`,
      verdict.ok ? 'The signer would accept it once the owner executes it.' : `The signer would refuse it even if the owner executed it: ${verdict.why}.`,
      left != null ? `That wallet can still send ${sol(left)} today under its daily ceiling.` : null,
      `Nothing has been signed. Calling ${args.action} creates a pending proposal; only the owner can execute it.`,
    ].filter(Boolean);
    return { ...text(lines.join('\n')), structuredContent: { action: args.action, payer: plan.payer, payer_name: nameOf(plan.payer), transfers, fee_lamports: fee, memo: plan.memo, would_sign: verdict.ok, reason: verdict.why, daily_left_lamports: left } };
  }

  const nameOf = addr => (addr === hood.s.office.address ? 'the office' : hood.s.agents.find(a => a.address === addr)?.name || addr);
  const iso = t => (t ? new Date(t).toISOString() : null);
  const publicProposal = x => ({
    id: x.id, request_id: x.requestId ?? null, run_id: x.runId ?? null, seat: x.seat || x.agent, agent: x.agent, action: x.action ?? null, summary: describeMove(x.move),
    network: x.network || hood.s.cluster, board_version: x.boardVersion ?? null,
    payer: x.payer, payer_name: nameOf(x.payer), transfers: x.transfers.map(t => ({ ...t, from_name: nameOf(t.from), to_name: nameOf(t.to) })),
    amount_lamports: x.amount ?? x.transfers.reduce((t, y) => t + y.lamports, 0), fee_lamports: x.fee ?? null, memo: x.memo,
    created_at: iso(x.at), expires_at: iso(x.expiresAt), transaction_hash: x.transactionHash ?? null, proposal_hash: x.proposalHash ?? null,
    status: x.status, reason: x.reason || null, closed_at: iso(x.closedAt), closed_by: x.closedBy ? String(x.closedBy).replace(/ \(.*\)$/, '') : null,
    signature: x.sig || null, confirmed: x.status === 'executed', receipt: x.sig ? solscanTx(hood.s.cluster, x.sig) : null, result: x.result || null,
  });
  function proposalText(x, head) {
    const pays = x.transfers.map(t => `${sol(t.lamports)} to ${nameOf(t.to)}`).join(', ');
    return [
      x.offchain
        ? `${head} #${x.id} (seat ${x.seat}, ${x.network}): ${describeMove(x.move)}. No SOL moves.`
        : `${head} #${x.id} (seat ${x.seat}, ${x.network}): ${nameOf(x.payer)} would pay ${pays} plus a network fee of at most ${(x.fee / 1e9).toFixed(6)} SOL (memo "${x.memo}").`,
      x.proposalHash ? `Board version ${x.boardVersion}; expires ${new Date(x.expiresAt).toISOString()}; transaction ${x.transactionHash}; proposal ${x.proposalHash}.` : null,
      x.status === 'pending' ? 'Nothing has been signed or sent. The owner reviews this exact record and executes it once or rejects it; if the board, price, recipient or fee changes first it goes stale and you propose again. Check it with hood_proposals.' : null,
      x.status === 'executing' ? 'The owner executed it; it is being confirmed on chain.' : null,
      x.status === 'executed' ? `Executed by the owner and confirmed on chain. Receipt: ${solscanTx(hood.s.cluster, x.sig)}` : null,
      x.status === 'applied' ? 'Applied by the owner (no SOL moved).' : null,
      ['rejected', 'stale', 'expired', 'void', 'failed'].includes(x.status) ? `Status ${x.status.toUpperCase()}: ${x.reason || ''} Nothing moved.` : null,
    ].filter(Boolean).join('\n');
  }
  function listProposals(id, seat, args) {
    hood.expireProposals();
    const mine = (hood.s.proposals || []).filter(x => (seat.agent ? x.agent === seat.agent : !args.agent || x.agent === args.agent) && (!args.status || x.status === args.status)).slice(-20).reverse();
    if (!mine.length) return { ...text('No proposals yet.'), structuredContent: { proposals: [] } };
    return { ...text(mine.map(x => `#${x.id} ${x.agent} ${x.status.toUpperCase()}: ${describeMove(x.move)}${x.sig ? ` · receipt ${solscanTx(hood.s.cluster, x.sig)}` : x.reason ? ` · ${x.reason}` : ''}`).join('\n')), structuredContent: { proposals: mine.map(publicProposal) } };
  }
  function showProposal(id, seat, args) {
    const x = hood.proposal(args.id);
    if (!x || (seat.agent && x.agent !== seat.agent)) return text('No such proposal for this seat.', true);
    return { ...text(proposalText(x, `Proposal (${x.status.toUpperCase()})`)), structuredContent: { proposal: publicProposal(x) } };
  }

  async function callTool(name, args, seat, sess) {
    const client = sess.name || sess.client;
    const p = { ...E.publicState(hood.s), epochMs: hood.epochMs };
    const halted = hood.s.halted ? `THE HOOD IS STOPPED by the owner (${hood.s.halted.reason}): pending proposals were voided and nothing can be proposed until it resumes.\n\n` : '';
    if (name === 'hood_look') return { ...text(halted + lookText(p)), structuredContent: { epoch: p.epoch, lotPrice: p.lotPrice, agents: p.agents, listings: p.listings, stopped: !!hood.s.halted, state_rev: hood.s.rev } };
    if (name === 'hood_rules') return text(rulesText(p));
    if (name === 'hood_lot') return lotText(p, args.lot);
    if (!TOOLS.some(t => t.name === name)) return text(`unknown tool ${name}`, true);
    if (!seat) return text('Swigglies is a closed experiment: this door only opens with the owner\'s key.', true);
    // reading proposals needs no agent: a seat key sees its own, the house key sees all
    if (name === 'hood_proposals') return listProposals(null, seat, args);
    if (name === 'hood_proposal') return showProposal(null, seat, args);
    const id = seat.agent || args.agent;
    if (!IDS.includes(id)) return text('Name the dot this call is for: pass agent (marrow, pip, soot, brine or lark).', true);
    if (seat.agent && args.agent && args.agent !== seat.agent) return text(`This seat key is ${seat.agent}'s.`, true);
    if (name === 'hood_join') {
      const tag = String(args.name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || sess.client;
      sess.name = tag; // later calls in this session keep the name
      hood.joinSeat(id, tag);
      return text(joinText({ ...E.publicState(hood.s), seatHoldMs: hood.seatHoldMs }, id, tag));
    }
    hood.holdSeat(id, client);
    if (name === 'hood_me') return text(meText(E.publicState(hood.s), id));
    if (name === 'hood_preview') return preview(args, id);
    // The pending-proposal boundary: a player's money move is only ever proposed here. Nothing on this path
    // can sign, execute or approve it; execution exists only behind the owner's key (owner.mjs).
    if (MONEY.has(name)) {
      const { agent: _a, ...parameters } = args;
      const pr = hood.propose(id, MOVES[name](args), client, { action: { type: name.slice(5), parameters } });
      if (!pr.ok) return { ...text(`Not proposed: ${pr.error}`, true), ...(pr.proposal ? { structuredContent: { proposal: publicProposal(pr.proposal) } } : {}) };
      return { ...text(proposalText(pr.proposal, 'Proposal created and PENDING.')), structuredContent: { proposal: publicProposal(pr.proposal) } };
    }
    const r = await hood.act(id, MOVES[name](args), client);
    if (!r.ok) return text(r.error, true);
    if (name === 'hood_walk') return text(`${E.agentOf(hood.s, id).name} is walking to ${E.lotName(E.agentOf(hood.s, id).at)}.`);
    return text(`${r.text}${r.solscan ? `\nReceipt: ${r.solscan}` : ''}`);
  }

  const seatTag = seat => (!seat ? 'none' : seat.house ? 'house' : seat.agent);
  const denied = new Map(); // ip -> last logged refusal, so a knocking stranger is logged once a minute
  const pace = new Map();   // hashed key -> recent tool-call times
  const origin = req => ({ ip: String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null, ua: String(req.headers['user-agent'] || '').slice(0, 80) || null });

  async function one(msg, seat, sid, res, req) {
    const { id, method, params = {} } = msg || {};
    const reply = result => ({ jsonrpc: '2.0', id, result });
    const error = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return error(-32600, 'invalid request');
    if (id === undefined) return null; // notification
    switch (method) {
      case 'initialize': {
        const newSid = crypto.randomUUID();
        const client = String(params.clientInfo?.name || 'a dot').replace(/[\u0000-\u001f\u007f<>]/g, ' ').slice(0, 40);
        sessions.set(newSid, { client, at: Date.now() });
        if (sessions.size > 5000) sessions.delete(sessions.keys().next().value);
        // who connected, with which kind of seat: never the key itself
        hood.log({ kind: 'mcp-init', client, version: String(params.clientInfo?.version || '').slice(0, 20), seat: seatTag(seat), ...origin(req) });
        res.setHeader('Mcp-Session-Id', newSid);
        return reply({
          protocolVersion: params.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'swigglies', title: 'Swigglies', version: '1.0.0' },
          instructions: 'Five dots with Solana wallets share a hood of 49 lots. Call hood_join, then hood_look and hood_me. Money moves (buy, build, upgrade, buyout, crates) are only PROPOSED: each creates a pending proposal that signs nothing, and the owner reviews and executes it; follow it with hood_proposals. Walking, talking and listing happen at once.',
        });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const sess = sessions.get(sid) || { client: 'a dot' };
        const args = params.arguments || {};
        let result;
        try { result = await callTool(params.name, args, seat, sess); }
        catch (e) { result = text(`the hood could not do that: ${e.message}`, true); }
        hood.log({ kind: 'mcp-call', client: sess.name || sess.client, tool: String(params.name).slice(0, 40), agent: seat?.agent || (IDS.includes(args.agent) ? args.agent : null), seat: seatTag(seat), ok: !result.isError, ...origin(req) });
        return reply(result);
      }
      default: return error(-32601, `method not found: ${method}`);
    }
  }

  return async function handle(req, res, url, body) {
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); }
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); }
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
    const seat = seatFor(seats, url.searchParams.get('seat') || bearer);
    if (!seat) {
      // Closed experiment: without one of the owner's keys the door does not open at all, not even to look.
      const { ip, ua } = origin(req);
      const now = Date.now();
      if (now - (denied.get(ip) || 0) > 60_000) { denied.set(ip, now); hood.log({ kind: 'mcp-denied', ip, ua }); }
      if (denied.size > 2000) denied.clear();
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: Array.isArray(msg) ? null : msg?.id ?? null, error: { code: -32001, message: 'Swigglies is a closed experiment: this door only opens with the owner\'s key.' } }));
    }
    // Per-key pace: at most 20 tool calls a minute on a seat key, 60 on the house key (five players).
    const toolCalls = (Array.isArray(msg) ? msg : [msg]).filter(m => m?.method === 'tools/call').length;
    if (toolCalls) {
      const k = crypto.createHash('sha256').update(String(url.searchParams.get('seat') || bearer)).digest('hex').slice(0, 16);
      const now = Date.now(), cap = seat.house ? 60 : 20;
      const recent = (pace.get(k) || []).filter(t => now - t < 60_000);
      if (recent.length + toolCalls > cap) {
        pace.set(k, recent);
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '10' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: Array.isArray(msg) ? null : msg?.id ?? null, error: { code: -32002, message: `slow down: at most ${cap} tool calls a minute on this key` } }));
      }
      for (let n = 0; n < toolCalls; n++) recent.push(now);
      pace.set(k, recent);
    }
    const sid = req.headers['mcp-session-id'];
    const out = Array.isArray(msg) ? (await Promise.all(msg.map(m => one(m, seat, sid, res, req)))).filter(Boolean) : await one(msg, seat, sid, res, req);
    if (out == null || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out));
  };
}

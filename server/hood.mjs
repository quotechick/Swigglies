// The hood's ledger. One queue: every move is planned, sent to Solana, confirmed, and only then
// applied; balances are re-read from the chain after every transaction, so SOL shown is chain truth.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import * as E from './economy.mjs';
import { decide } from './autopilot.mjs';
import { PERSONA } from './roster.mjs';
import { SIG_FEE, templateHash } from './solana.mjs';

const ledgerRow = f => ({ id: f.id, t: f.t, epoch: f.epoch ?? null, kind: f.kind, who: f.who || [], lamports: f.lamports || 0, text: f.text, sig: f.sig, by: f.by || null });

export const solscanTx = (cluster, sig) => `https://solscan.io/tx/${sig}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;

// A proposal executes only if a fresh plan pays exactly the same wallets exactly the same amounts.
const sameTransfers = (p, x) => p.payer === x.payer && p.memo === (x.planMemo ?? x.memo) && p.transfers.length === x.transfers.length
  && p.transfers.every((t, i) => t.from === x.transfers[i].from && t.to === x.transfers[i].to && t.lamports === x.transfers[i].lamports);

// The immutable commitment of a proposal, in this exact order (the runner's dothood-proposal-v1 contract):
// proposalHash = SHA-256 of the UTF-8 JSON of these fields. The owner's Accept names it and transactionHash.
export const PROPOSAL_FIELDS = ['id', 'requestId', 'runId', 'seat', 'boardVersion', 'action', 'network', 'payer', 'transfers', 'amount', 'fee', 'expiresAt', 'transactionHash'];
export const proposalImmutable = x => Object.fromEntries(PROPOSAL_FIELDS.map(k => [k, k === 'id' ? String(x.id) : x[k]]));
export const proposalHash = x => crypto.createHash('sha256').update(JSON.stringify(proposalImmutable(x))).digest('hex');

export const describeMove = m => {
  const lot = String(m.lot ?? '').toUpperCase();
  switch (m.type) {
    case 'buy_lot': return `buying ${lot} from the office`;
    case 'build': return `building a ${m.kind} on ${lot}`;
    case 'upgrade': return `upgrading ${lot}`;
    case 'buy': return `buying listing #${m.listing}`;
    case 'buyout': return `buying out ${m.target}`;
    case 'sell_crates': return `selling ${m.qty} crates to the office`;
    case 'buy_crates': return `buying ${m.qty} crates from the office`;
    default: return m.type;
  }
};

export class Hood extends EventEmitter {
  constructor({ chain, office, agents, stateFile, logFile, unit, cluster, tickMs = 12_000, epochMs = 120_000, seatHoldMs = 1_200_000, rnd = Math.random, stakeLamports = 0, maxTxPerDay = 3000, proposalTtlMs = 1_800_000, autopilot = true, ownerExecutes = false }) {
    super();
    Object.assign(this, { chain, stateFile, logFile, tickMs, epochMs, seatHoldMs, rnd, stakeLamports, maxTxPerDay, proposalTtlMs, autopilot, ownerExecutes });
    this.housePlans = new Map(); // house proposal id -> { p, finish }; in memory only (a restart voids them)
    this._approving = false;
    this.ledger = this.loadLedger();
    this.keyByAddress = new Map([office, ...agents].map(w => [w.kp.address, w.kp]));
    this.q = Promise.resolve();
    this.logWrites = 0;
    this.rr = -1;
    const roster = agents.map(w => ({ ...w.r, address: w.kp.address }));
    if (stateFile && fs.existsSync(stateFile)) {
      this.s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (this.s.office.address !== office.kp.address || roster.some(r => E.agentOf(this.s, r.id)?.address !== r.address)) {
        throw new Error('state file belongs to different wallets; refusing to mix them');
      }
    } else {
      this.s = E.freshState({ unit, cluster, office: office.kp.address, agents: roster });
    }
    this.s.cluster = cluster;
    // names and colours come from the roster, so a restyle reaches a running game
    for (const r of roster) Object.assign(E.agentOf(this.s, r.id), { name: r.name, color: r.color });
  }

  run(fn) {
    const p = this.q.then(fn);
    this.q = p.catch(() => {});
    return p;
  }

  save() {
    if (!this.stateFile) return;
    fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.s));
    fs.renameSync(this.stateFile + '.tmp', this.stateFile);
  }

  log(row) {
    if (!this.logFile) return;
    fs.appendFileSync(this.logFile, JSON.stringify({ t: Date.now(), ...row }) + '\n');
    if (++this.logWrites % 500 === 0) { try { if (fs.statSync(this.logFile).size > 50e6) fs.renameSync(this.logFile, `${this.logFile}.1`); } catch {} }
  }

  // Every on-chain move since the start, for the ledger page: rebuilt from the event log at boot.
  loadLedger() {
    const out = [];
    for (const file of this.logFile ? [`${this.logFile}.1`, this.logFile] : []) {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"sig":"')) continue;
        // tape entries are logged with their own kind (buy_lot, buyout, epoch…); a receipt + text + id marks them
        try { const r = JSON.parse(line); if (r.sig && r.text && Number.isInteger(r.id)) out.push(ledgerRow(r)); } catch {}
      }
    }
    return out.slice(-50_000);
  }

  // First funding: once the office holds SOL and none of the five has any, the office stakes them.
  // Fixed mode (stakeLamports > 0): each dot gets that stake once the office can cover (nearly) all five,
  // keeping 0.05 SOL for fees and the first rent rolls. Proportional mode: 80% of the office, split five ways.
  // Either way the hood unit is scaled so each dot starts with 100 units.
  async stakeIfReady() {
    const s = this.s;
    if (s.staked || s.halted) return false;
    if (s.agents.some(a => a.balance > 0)) { s.staked = true; this.save(); return false; }
    const n = s.agents.length, spend = E.officeSpendable(s);
    let each;
    if (this.stakeLamports > 0) {
      if (spend < this.stakeLamports * n * 0.95) return false;
      each = Math.min(this.stakeLamports, Math.floor((spend - 50_000_000) / n));
    } else {
      if (spend < 50_000_000) return false;
      each = Math.floor((spend * 0.8) / n);
    }
    const transfers = s.agents.map(a => ({ from: s.office.address, to: a.address, lamports: each }));
    const plan = { payer: s.office.address, transfers, memo: 'swigglies: the office stakes the five' };
    const finish = async sig => {
      s.unit = Math.max(1_000_000, Math.round(each / 100 / 10_000) * 10_000);
      s.staked = true;
      s.epochAt = Date.now();
      try { await this.refresh(); } catch (e) { this.chainFail(e); }
      this.publish([{ kind: 'stake', who: s.agents.map(a => a.id), lamports: each * s.agents.length, text: `The office staked the five: ${E.sol(each)} each. One hood unit is now ${E.sol(s.unit)}, so land opens at ${E.sol(E.lotPrice(s))}.` }],
        s.agents.map(a => ({ kind: 'pay', from: 'office', to: a.id, lamports: each })), sig, 'office');
    };
    if (this.ownerExecutes) { this.proposeHouse('stake', plan, finish); return false; }
    await finish(await this.sendPlan(plan));
    return true;
  }

  async refresh() {
    const wallets = [this.s.office, ...this.s.agents];
    const bals = await this.chain.balances(wallets.map(w => w.address));
    wallets.forEach((w, i) => { w.balance = bals[i]; });
    this.s.chain = { ...(this.s.chain || {}), ok: true, at: Date.now() };
  }

  chainFail(e) { this.s.chain = { ...(this.s.chain || {}), ok: false, error: String(e.message || e).slice(0, 200), errorAt: Date.now() }; }

  publish(feed, fx, sig, by) {
    for (const f of feed) {
      Object.assign(f, { id: this.s.nextFeed++, t: Date.now(), sig: sig || null, by: by || null, epoch: this.s.epoch });
      this.s.feed.push(f);
      this.log({ kind: 'feed', ...f });
      if (f.sig) { this.ledger.push(ledgerRow(f)); if (this.ledger.length > 55_000) this.ledger.splice(0, 5_000); }
    }
    if (this.s.feed.length > 200) this.s.feed.splice(0, this.s.feed.length - 200);
    this.s.rev++;
    this.save();
    this.emit('change', { feed, fx });
  }

  // Daily on-chain transaction cap per paying wallet, so a leaked seat key cannot burn a wallet down on
  // fees. The office (epoch settlements, staking, crate bids) is exempt.
  txToday(payer) {
    const day = new Date().toISOString().slice(0, 10);
    if (!this.s.txDay || this.s.txDay.day !== day) this.s.txDay = { day, counts: {} };
    return this.s.txDay.counts[payer] || 0;
  }

  async sendPlan(p, templateHash = null) {
    if (this.ownerExecutes && !this._approving) throw Object.assign(new Error('signing guard: here only the owner\'s Accept signs, and this is not an approved proposal'), { guard: true });
    const { signature, fee } = await this.chain.send({ payer: p.payer, transfers: p.transfers, memo: p.memo, templateHash, keyFor: addr => this.keyByAddress.get(addr) });
    const made = this.txToday(p.payer) + 1;
    this.s.txDay.counts[p.payer] = made;
    this.s.totals.txs++;
    this.s.totals.fees += fee;
    this.s.totals.moved += p.transfers.reduce((t, x) => t + x.lamports, 0);
    return signature;
  }

  act(id, move, by = 'autopilot') { return this.run(() => this._act(id, move, by)); }

  async _act(id, move, by) {
    const p = E.planMove(this.s, id, move);
    if (p.error) return { ok: false, error: p.error };
    if (this.ownerExecutes && p.transfers.length) return { ok: false, error: 'every transaction here needs the owner\'s click: propose it instead' };
    if (p.transfers.length && p.payer !== this.s.office.address && this.txToday(p.payer) >= this.maxTxPerDay) {
      return { ok: false, error: `this wallet has made its ${this.maxTxPerDay} on-chain moves for today (UTC); it can act again tomorrow` };
    }
    let sig = null;
    if (p.transfers.length) {
      try { sig = await this.sendPlan(p); }
      catch (e) {
        if (e.guard) {
          // the auto-signer's guard said no: nothing was signed, the chain itself is fine
          this.log({ kind: 'guard-refused', id, move, error: e.message });
          return { ok: false, error: `refused by the auto-signer's guard, nothing was signed: ${e.message.replace(/^signing guard: /, '')}` };
        }
        this.chainFail(e);
        this.log({ kind: 'tx-fail', id, move, error: e.message });
        try { await this.refresh(); } catch {}
        this.publish([], [], null, by);
        return { ok: false, error: `the transaction did not land: ${e.message}` };
      }
    }
    const feed = p.apply();
    if (sig) { try { await this.refresh(); } catch (e) { this.chainFail(e); } }
    this.publish(feed, p.fx, sig, by);
    return { ok: true, sig, text: feed.map(f => f.text).join(' ') || 'done', solscan: sig ? solscanTx(this.s.cluster, sig) : null };
  }

  settle() {
    return this.run(async () => {
      if (this.s.halted) return { ok: false, halted: true };
      if (this.ownerExecutes) {
        if ((this.s.proposals || []).some(x => x.kind === 'house' && x.action.type === 'epoch' && this.open(x))) return { ok: false, waiting: true };
        try { await this.refresh(); } catch (e) { this.chainFail(e); }
        const p = E.planEpoch(this.s, Date.now(), this.rnd);
        if (!p.transfers.length) { const { feed, fx } = p.apply(); this.publish(feed, [...p.fx, ...fx], null, 'office'); return { ok: true, sig: null }; }
        const x = this.proposeHouse('epoch', p, async sig => {
          const { feed, fx } = p.apply();
          try { await this.refresh(); } catch (e) { this.chainFail(e); }
          this.publish(feed, [...p.fx, ...fx], sig, 'office');
        });
        return { ok: false, proposed: x?.id ?? null };
      }
      try { await this.refresh(); } catch (e) { this.chainFail(e); }
      let p = E.planEpoch(this.s, Date.now(), this.rnd);
      let sig = null;
      if (p.transfers.length) {
        try { sig = await this.sendPlan(p); }
        catch (e) {
          this.chainFail(e);
          this.log({ kind: 'epoch-fail', epoch: this.s.epoch, error: e.message });
          try { await this.refresh(); } catch {}
          p = E.planEpoch(this.s, Date.now(), this.rnd);
          try { sig = p.transfers.length ? await this.sendPlan(p) : null; }
          catch (e2) {
            // Two misses in a row: the epoch still turns, but no SOL moves this time.
            this.chainFail(e2);
            this.s.epoch++;
            this.s.epochAt = Date.now();
            this.publish([{ kind: 'jam', who: [], text: `Epoch ${this.s.epoch}: the rent roll could not settle on chain (${e2.message.slice(0, 80)}). No SOL moved and nobody was foreclosed.` }], [], null, 'office');
            return { ok: false };
          }
        }
      }
      const { feed, fx } = p.apply();
      if (sig) { try { await this.refresh(); } catch (e) { this.chainFail(e); } }
      this.publish(feed, [...p.fx, ...fx], sig, 'office');
      return { ok: true, sig };
    });
  }

  // ---- Proposals: the pending-proposal boundary ------------------------------------------------------
  // Every player move that changes the game is only ever proposed. propose() plans it against the live
  // board and stores an immutable record (PROPOSAL_FIELDS, hashed as proposalHash) as pending: nothing is
  // signed, sent or applied. Only approve(), reachable solely through the owner's key or password
  // (owner.mjs, admin.mjs), executes it: once, and only while the board version, the plan, the fee and the
  // exact transaction are still the ones proposed. Anything else sends it stale (reapproval_required) and
  // the player must propose again. Where the owner executes everything (ownerExecutes, i.e. mainnet), the
  // house's own transactions (the opening stake, each epoch's rent roll) are proposals as well, and
  // sendPlan() refuses to sign anything that is not inside an owner approval.

  // A version of everything that decides what a move costs and does: balances, crates, lots, builds,
  // listings, the epoch and the unit. Proposals, seats, the tape and walking do not change it.
  boardVersion() {
    const s = this.s;
    const core = [s.epoch, s.unit, !!s.staked, s.office.balance, s.agents.map(a => [a.id, a.balance, a.crates, a.status, a.shieldUntil ?? null]), s.lots, s.listings];
    return `b${crypto.createHash('sha256').update(JSON.stringify(core)).digest('hex').slice(0, 24)}`;
  }

  // The network fee a plan pays: one base fee per signer, plus the priority fee on mainnet.
  feeFor(p) {
    const signers = new Set([p.payer, ...p.transfers.map(t => t.from)]).size;
    const pr = this.chain.priority;
    return SIG_FEE * signers + (pr ? Math.ceil((pr.units * pr.microLamports) / 1e6) : 0);
  }

  // The exact unsigned transaction (blockhash aside) that a plan sends with this memo.
  txTemplate(p, memo) { return templateHash({ payer: p.payer, transfers: p.transfers, memo, priority: this.chain.priority || null }); }

  open(x) { return x.status === 'pending' || x.status === 'executing'; }

  runRevoked(runId, seat) { const t = this.s.revokedRuns?.[runId]; return !!(t && (t.all || t.seats.includes(seat))); }

  // meta: { requestId, runId, action, note, ttlMs } from the runner API or the MCP door
  propose(id, move, by, meta = {}) {
    const s = this.s;
    if (s.halted) return { ok: false, code: 'stopped', error: `the owner stopped the hood (${s.halted.reason}); nothing can be proposed until it resumes` };
    if (meta.runId && this.runRevoked(meta.runId, id)) return { ok: false, code: 'run_revoked', error: 'this run was revoked; start a new run' };
    const p = E.planMove(s, id, move);
    if (p.error) return { ok: false, code: 'rules', error: p.error };
    const offchain = !p.transfers.length;
    if (offchain && !['list', 'delist'].includes(move.type)) return { ok: false, code: 'no_effect', error: 'this move changes nothing the owner needs to approve, so it is not a proposal' };
    this.expireProposals();
    s.proposals ||= [];
    const transfers = p.transfers.map(t => ({ from: t.from, to: t.to, lamports: t.lamports }));
    const mine = s.proposals.filter(x => x.seat === id && this.open(x));
    const twin = mine.find(x => JSON.stringify(x.move) === JSON.stringify(move) && JSON.stringify(x.transfers) === JSON.stringify(transfers));
    if (twin) return { ok: false, code: 'duplicate_pending', error: `an identical proposal (#${twin.id}) is already pending; wait for the owner`, proposal: twin };
    if (mine.length >= 5) return { ok: false, code: 'too_many_pending', error: 'this seat already has 5 proposals open; wait for the owner' };
    const a = E.agentOf(s, id);
    const payer = offchain ? a.address : p.payer;
    const amount = transfers.reduce((t, x) => t + x.lamports, 0);
    const fee = offchain ? 0 : this.feeFor(p);
    if (!offchain) {
      // what this payer's other open proposals would already spend, plus one epoch of the seat's upkeep
      const reserved = s.proposals.filter(x => this.open(x) && x.payer === payer).reduce((t, x) => t + x.amount + x.fee, 0);
      const upkeep = payer === a.address ? E.ownedBy(s, id).reduce((t, l) => t + E.upkeepOf(s, l), 0) : 0;
      const room = (payer === s.office.address ? s.office.balance : a.balance) - E.RESERVE - upkeep;
      if (reserved + amount + fee > room) return { ok: false, code: 'insufficient_cushion', error: `with ${E.sol(reserved)} already reserved by open proposals and one epoch of upkeep kept back, this wallet cannot also cover ${E.sol(amount + fee)}` };
    }
    const nid = (s.nextProposal || 0) + 1, at = Date.now();
    const memo = offchain ? null : `${p.memo} [p${nid}]`;
    const x = {
      id: nid, requestId: meta.requestId || `mcp-${nid}`, runId: meta.runId || 'mcp', seat: id, boardVersion: this.boardVersion(),
      action: meta.action || { type: move.type, parameters: Object.fromEntries(Object.entries(move).filter(([k, v]) => k !== 'type' && v !== undefined)) },
      network: s.cluster, payer, transfers, amount, fee, expiresAt: at + (meta.ttlMs || this.proposalTtlMs),
      transactionHash: offchain ? crypto.createHash('sha256').update(JSON.stringify({ network: s.cluster, seat: id, operation: move })).digest('hex') : this.txTemplate(p, memo),
      // bookkeeping, outside the hash
      kind: 'player', agent: id, move: { ...move }, memo, planMemo: p.memo, offchain, at, epoch: s.epoch, stateRev: s.rev,
      note: meta.note ? String(meta.note).slice(0, 240) : null, by: String(by || 'a player').slice(0, 40), status: 'pending',
    };
    x.proposalHash = proposalHash(x);
    s.nextProposal = nid;
    s.proposals.push(x);
    if (s.proposals.length > 500) s.proposals.splice(0, s.proposals.length - 500);
    this.log({ kind: 'proposal', ...x });
    this.publish([{ kind: 'proposal', who: [id], text: `${a.name} proposed ${describeMove(x.move)} (#${x.id}${offchain ? ', no SOL moves' : `, ${E.sol(amount)}`}): pending the owner's review.` }], [], null, x.by);
    return { ok: true, proposal: x };
  }

  // The house's own transaction as a proposal (ownerExecutes only). `finish(sig)` applies it once sent.
  proposeHouse(type, p, finish) {
    const s = this.s;
    if (s.halted || (s.proposals || []).some(x => x.kind === 'house' && x.action.type === type && this.open(x))) return null;
    s.proposals ||= [];
    const nid = (s.nextProposal || 0) + 1, at = Date.now(), memo = `${p.memo} [p${nid}]`;
    const transfers = p.transfers.map(t => ({ from: t.from, to: t.to, lamports: t.lamports }));
    const x = {
      id: nid, requestId: `house-${nid}`, runId: 'house', seat: 'office', boardVersion: this.boardVersion(), action: { type, parameters: {} },
      network: s.cluster, payer: p.payer, transfers, amount: transfers.reduce((t, y) => t + y.lamports, 0), fee: this.feeFor(p),
      expiresAt: at + this.proposalTtlMs, transactionHash: this.txTemplate(p, memo),
      kind: 'house', agent: null, move: { type }, memo, planMemo: p.memo, offchain: false, at, epoch: s.epoch, stateRev: s.rev, note: null, by: 'the house', status: 'pending',
    };
    x.proposalHash = proposalHash(x);
    s.nextProposal = nid;
    s.proposals.push(x);
    this.housePlans.set(nid, { p, finish });
    this.log({ kind: 'proposal', ...x });
    this.publish([{ kind: 'proposal', who: [], text: `The house proposed ${type === 'epoch' ? `the rent roll for epoch ${s.epoch + 1}` : 'the opening stake'} (#${nid}, ${E.sol(x.amount)}): pending the owner's review.` }], [], null, 'the house');
    return x;
  }

  proposal(pid) { return (this.s.proposals || []).find(x => x.id === Number(pid)) || null; }

  expireProposals(now = Date.now()) {
    for (const x of this.s.proposals || []) {
      const end = x.expiresAt ?? x.at + this.proposalTtlMs;
      if (x.status === 'pending' && now >= end) {
        Object.assign(x, { status: 'expired', closedAt: now, reason: `not executed within ${Math.round((end - x.at) / 60000)} minutes` });
        this.housePlans.delete(x.id);
      }
    }
  }

  // Void every pending proposal (the owner stopped the hood, or the server restarted): nothing moved.
  voidPending(reason, by = 'owner', which = () => true) {
    const open = (this.s.proposals || []).filter(x => x.status === 'pending' && which(x));
    for (const x of open) { Object.assign(x, { status: 'void', reason, closedAt: Date.now(), closedBy: by }); this.housePlans.delete(x.id); }
    if (open.length) {
      this.log({ kind: 'proposals-void', ids: open.map(x => x.id), reason });
      this.publish([{ kind: 'proposal-void', who: [...new Set(open.map(x => x.agent).filter(Boolean))], text: `${open.length} pending proposal${open.length > 1 ? 's were' : ' was'} voided: ${reason}. Nothing moved.` }], [], null, by);
    }
    return open.length;
  }

  // A run revoked by its seat (or by the keeper for all five): its pending proposals are voided and any
  // later submission under that run id is refused, durably.
  revokeRun(runId, seat, by) {
    return this.run(async () => {
      const s = this.s;
      s.revokedRuns ||= {};
      const t = (s.revokedRuns[runId] ||= { at: Date.now(), all: false, seats: [] });
      if (seat) { if (!t.seats.includes(seat)) t.seats.push(seat); } else t.all = true;
      const keys = Object.keys(s.revokedRuns);
      if (keys.length > 500) delete s.revokedRuns[keys[0]];
      const n = this.voidPending(`run ${runId} was revoked`, by, x => x.runId === runId && (!seat || x.seat === seat));
      this.save();
      return { ok: true, revoked: n };
    });
  }

  // The owner's stop switch: voids every pending proposal and refuses new ones, and the house stops
  // settling epochs and staking, until resume().
  halt(by = 'owner', reason = 'stopped by the owner') {
    return this.run(async () => {
      if (this.s.halted) return { ok: true, already: true, voided: 0 };
      this.s.halted = { at: Date.now(), by, reason: String(reason).slice(0, 120) };
      const n = this.voidPending(`the owner stopped the hood (${this.s.halted.reason})`, by);
      this.publish([{ kind: 'halt', who: [], text: `The owner stopped the hood. ${n} pending proposal${n === 1 ? '' : 's'} voided; no new proposals, no settlements until it resumes.` }], [], null, by);
      return { ok: true, voided: n };
    });
  }

  resume(by = 'owner') {
    return this.run(async () => {
      if (!this.s.halted) return { ok: true, already: true };
      this.s.halted = null;
      this.s.epochAt = Date.now();
      this.publish([{ kind: 'resume', who: [], text: 'The owner resumed the hood. Proposals are open again.' }], [], null, by);
      return { ok: true };
    });
  }

  planFor(x) {
    if (x.kind === 'house') return this.housePlans.get(x.id)?.p || { error: 'the house plan is gone (the server restarted)' };
    return E.planMove(this.s, x.agent, x.move);
  }

  // Everything that must still hold at the moment of execution, besides the signer's guard.
  bindingProblem(x, p) {
    if (p.error) return `the rules now refuse it: ${p.error}`;
    if (x.network !== this.s.cluster) return `it was proposed on ${x.network}, the hood is on ${this.s.cluster}`;
    const bv = this.boardVersion();
    if (bv !== x.boardVersion) return `the board changed since it was proposed (version ${x.boardVersion} is now ${bv})`;
    if (!x.offchain) {
      if (!sameTransfers(p, x)) return 'the payer, a recipient, an amount or the memo changed since it was proposed';
      if (this.feeFor(p) > x.fee) return `the network fee rose above the proposed ${x.fee} lamports`;
      if (this.txTemplate(p, x.memo) !== x.transactionHash) return 'the exact transaction changed (instructions, accounts or fee settings)';
    }
    if (proposalHash(x) !== x.proposalHash) return 'the stored record does not match its hash';
    return null;
  }

  // Re-check a pending proposal now: would executing it do exactly what was proposed?
  async review(pid) {
    const x = this.proposal(pid);
    if (!x) return { ok: false, why: 'no such proposal' };
    if (x.status !== 'pending') return { ok: false, why: `it is ${x.status}` };
    if (this.s.halted) return { ok: false, why: 'the hood is stopped' };
    const p = this.planFor(x);
    const problem = this.bindingProblem(x, p);
    if (problem) return { ok: false, why: `${problem}: ${x.kind === 'house' ? 'the house proposes it again' : 'the player must propose again'}` };
    if (x.offchain) return { ok: true, why: null };
    const guard = this.chain.check ? await this.chain.check({ payer: p.payer, transfers: p.transfers, memo: x.memo }) : { ok: true, why: null };
    if (!guard.ok) return { ok: false, why: `the signer would refuse it: ${guard.why}` };
    return { ok: true, why: null };
  }

  // hashes: { proposalHash, transactionHash } as the owner reviewed them. Approving executes that exact
  // record once (pending -> executing, persisted before anything is sent); any other state refuses.
  approve(pid, by = 'owner', hashes = {}) { return this.run(() => this._approve(pid, by, hashes)); }

  async _approve(pid, by, hashes) {
    this.expireProposals();
    const x = this.proposal(pid);
    if (!x) return { ok: false, code: 'unknown_proposal', error: 'no such proposal' };
    if (x.status !== 'pending') return { ok: false, code: 'not_pending', error: `proposal #${x.id} is ${x.status}; it cannot execute (again)` };
    if (hashes.proposalHash !== x.proposalHash || hashes.transactionHash !== x.transactionHash) return { ok: false, code: 'review_mismatch', error: `proposal #${x.id} is not the one you reviewed (hash mismatch); reload and review it again` };
    if (this.s.halted) return { ok: false, code: 'stopped', error: 'the hood is stopped' };
    const close = (status, reason) => { Object.assign(x, { status, reason, closedAt: Date.now(), closedBy: by }); this.housePlans.delete(x.id); this.log({ kind: `proposal-${status}`, id: x.id, reason }); };
    const p = this.planFor(x);
    const problem = this.bindingProblem(x, p);
    if (problem) {
      close('stale', problem);
      this.publish([{ kind: 'proposal-stale', who: x.agent ? [x.agent] : [], text: `Proposal #${x.id} went stale before it was executed; nothing moved.` }], [], null, by);
      return { ok: false, code: 'reapproval_required', error: `proposal #${x.id} is stale: ${x.reason}` };
    }
    if (x.offchain) {
      const feed = p.apply();
      feed.forEach(f => { f.text = `${f.text} (proposal #${x.id}, applied by the owner)`; });
      Object.assign(x, { status: 'applied', closedAt: Date.now(), closedBy: by, result: feed.map(f => f.text).join(' ') });
      this.log({ kind: 'proposal-applied', id: x.id });
      this.publish(feed, p.fx || [], null, x.by);
      return { ok: true, proposal: x };
    }
    if (x.kind === 'player' && x.payer !== this.s.office.address && this.txToday(x.payer) >= this.maxTxPerDay) return { ok: false, code: 'daily_cap', error: 'that wallet has used its daily transactions' };
    // the intent is on disk before anything is sent: a crash from here on is reconciled by the memo tag, never re-sent
    Object.assign(x, { status: 'executing', executingAt: Date.now(), closedBy: by });
    this.save();
    let sig;
    this._approving = true;
    try { sig = await this.sendPlan({ ...p, memo: x.memo }, x.transactionHash); }
    catch (e) {
      if (e.guard) {
        close('failed', `the signer refused it, nothing was signed: ${e.message.replace(/^signing guard: /, '')}`);
        this.publish([], [], null, by);
        return { ok: false, code: 'refused', error: `proposal #${x.id}: ${x.reason}` };
      }
      // uncertain: it may still land. It stays executing; reconcile() finds it by its memo tag, or fails it
      // once its blockhash has expired. It is never sent a second time.
      x.lastError = String(e.message).slice(0, 200);
      this.chainFail(e);
      try { await this.refresh(); } catch {}
      this.publish([], [], null, by);
      return { ok: false, code: 'executing', error: `proposal #${x.id} was sent but is not confirmed yet (${x.lastError}); it stays EXECUTING and is reconciled on chain, never sent again` };
    } finally { this._approving = false; }
    return this.finishExecuted(x, p, sig, by);
  }

  async finishExecuted(x, p, sig, by, reconciled = false) {
    Object.assign(x, { status: 'executed', sig, closedAt: Date.now(), closedBy: by, confirmed: true, ...(reconciled ? { reconciled: true } : {}) });
    if (x.kind === 'house') {
      const plan = this.housePlans.get(x.id);
      this.housePlans.delete(x.id);
      this.log({ kind: 'proposal-executed', id: x.id, sig });
      if (plan) await plan.finish(sig); else this.publish([], [], sig, by);
      x.result = this.s.feed.filter(f => f.sig === sig).map(f => f.text).join(' ') || `The house executed ${x.action.type === 'epoch' ? 'the rent roll' : 'the opening stake'}.`;
      this.save();
      this.emit('executed', { proposal: x, receipt: solscanTx(this.s.cluster, sig) });
      return { ok: true, sig, proposal: x };
    }
    const feed = p.apply();
    try { await this.refresh(); } catch (e) { this.chainFail(e); }
    feed.forEach(f => { f.text = `${f.text} (proposal #${x.id}, executed by the owner)`; });
    x.result = feed.map(f => f.text).join(' ');
    this.log({ kind: 'proposal-executed', id: x.id, sig });
    this.publish(feed, p.fx, sig, x.by, p.sigs);
    this.emit('executed', { proposal: x, receipt: solscanTx(this.s.cluster, sig) });
    return { ok: true, sig, proposal: x };
  }

  // Proposals left EXECUTING by an interruption: once their blockhash has surely expired, look for their memo
  // tag on chain. Found: confirmed (and applied if the rules still take it exactly). Not found: failed.
  async reconcile(now = Date.now()) {
    for (const x of (this.s.proposals || []).filter(y => y.status === 'executing')) {
      if (now - (x.executingAt || 0) < 150_000 || !this.chain.findMemo) continue;
      let hit;
      try { hit = await this.chain.findMemo(x.payer, `[p${x.id}]`); } catch (e) { this.chainFail(e); continue; }
      if (hit?.ok) {
        const p = this.planFor(x);
        if (!p.error && sameTransfers(p, x)) { await this.finishExecuted(x, p, hit.signature, x.closedBy || 'owner', true); continue; }
        Object.assign(x, { status: 'executed', sig: hit.signature, confirmed: true, reconciled: true, closedAt: now, reason: 'it landed on chain after an interruption, but the board had moved, so its game effect was not applied: the owner should look at it' });
        this.publish([{ kind: 'proposal-reconciled', who: x.agent ? [x.agent] : [], text: `Proposal #${x.id} landed on chain after an interruption; the owner is checking its effect.` }], [], hit.signature, 'office');
      } else {
        Object.assign(x, { status: 'failed', closedAt: now, reason: hit ? 'it reached the chain but failed there; only the network fee was spent' : 'it never landed on chain (its blockhash has expired); nothing moved' });
        this.publish([{ kind: 'proposal-failed', who: x.agent ? [x.agent] : [], text: `Proposal #${x.id} did not execute: ${x.reason}.` }], [], null, 'office');
      }
      this.housePlans.delete(x.id);
    }
  }

  reject(pid, by = 'owner', reason = '') {
    return this.run(async () => {
      const x = this.proposal(pid);
      if (!x) return { ok: false, error: 'no such proposal' };
      if (x.status !== 'pending') return { ok: false, error: `proposal #${x.id} is ${x.status}` };
      Object.assign(x, { status: 'rejected', reason: String(reason || 'rejected by the owner').slice(0, 200), closedAt: Date.now(), closedBy: by });
      this.housePlans.delete(x.id);
      this.log({ kind: 'proposal-rejected', id: x.id, reason: x.reason });
      this.publish([{ kind: 'proposal-rejected', who: x.agent ? [x.agent] : [], text: `The owner rejected proposal #${x.id}; nothing moved.` }], [], null, by);
      return { ok: true, proposal: x };
    });
  }

  held(a, now = Date.now()) { return !!(a.seat && now - a.seat.lastAt < this.seatHoldMs); }

  holdSeat(id, by) {
    const a = E.agentOf(this.s, id);
    const fresh = !this.held(a);
    if (!fresh && a.seat.named) { a.seat.lastAt = Date.now(); return; } // a joined dot keeps the name it gave
    a.seat = { by: String(by || 'a dot').slice(0, 40), lastAt: Date.now() };
    if (fresh) this.publish([{ kind: 'seat', who: [id], text: `A dot (${a.seat.by}) took ${a.name}'s seat. The autopilot steps back.` }], [], null, a.seat.by);
  }

  // hood_join: a dot names itself, takes the seat and is handed that dot's wallet.
  joinSeat(id, by) {
    const a = E.agentOf(this.s, id);
    const name = String(by || 'a dot').slice(0, 40);
    const again = this.held(a) && a.seat.by === name;
    a.seat = { by: name, lastAt: Date.now(), named: true, joinedAt: again ? a.seat.joinedAt : Date.now() };
    const wallet = `${a.address.slice(0, 4)}…${a.address.slice(-4)}`;
    const text = name === a.name
      ? `${a.name} took its seat. Wallet ${wallet} is its to play; the autopilot steps back.`
      : `${name} joined as ${a.name}. Wallet ${wallet} is theirs to play; the autopilot steps back.`;
    if (!again) this.publish([{ kind: 'seat', who: [id], text }], [], null, name);
    else this.save();
  }

  // The autopilot plays a seat nobody holds. It is off where the owner executes every player move (mainnet):
  // there, a quiet seat simply waits.
  async autopilotStep() {
    if (!this.autopilot || this.s.halted) return null;
    const n = this.s.agents.length;
    for (let k = 0; k < n; k++) {
      this.rr = (this.rr + 1) % n;
      const a = this.s.agents[this.rr];
      if (this.held(a)) continue;
      if (a.seat) { a.seat = null; this.publish([{ kind: 'seat', who: [a.id], text: `${a.name}'s dot went quiet for ${Math.round(this.seatHoldMs / 60000)} minutes. The autopilot has the seat again.` }], [], null, 'office'); }
      const move = decide(this.s, a, PERSONA[a.id], this.rnd);
      const r = await this.act(a.id, move, 'autopilot');
      if (!r.ok) this.log({ kind: 'autopilot-miss', id: a.id, move, error: r.error });
      return r;
    }
    return null;
  }

  start() {
    const guard = (name, fn) => async () => {
      if (this[name]) return;
      this[name] = true;
      try { await fn(); } catch (e) { this.log({ kind: 'loop-error', loop: name, error: e.message }); } finally { this[name] = false; }
    };
    this.run(() => this.refresh().catch(e => this.chainFail(e))).then(() => this.publish([], [], null, null))
      .then(() => this.run(() => this.stakeIfReady().catch(e => this.chainFail(e))));
    this.timers = [
      setInterval(guard('_tick', () => this.autopilotStep()), this.tickMs),
      setInterval(guard('_epoch', async () => { if (Date.now() - this.s.epochAt >= this.epochMs) await this.settle(); }), 5_000),
      setInterval(guard('_refresh', () => this.run(async () => {
        const before = this.s.agents.map(a => a.balance).join() + this.s.office.balance;
        try { await this.refresh(); } catch (e) { this.chainFail(e); }
        if (before !== this.s.agents.map(a => a.balance).join() + this.s.office.balance) this.publish([], [], null, null);
        await this.stakeIfReady().catch(e => this.chainFail(e));
        this.expireProposals();
        await this.reconcile();
      })), 30_000),
    ];
  }

  stop() { (this.timers || []).forEach(clearInterval); }
}

// The runner's door (protocol dothood-proposal-v1, see docs/RUNNER_SERVER_CONTRACT.md). Five fixed-seat
// principals, each authenticated by its seat key (Authorization: Bearer <seat key>): a seat can observe the
// board, stage inert pending proposals for its own seat, read its own proposals (status, confirmed receipt) and
// revoke its own run. The house key is the keeper: observe, and revoke a run for all five; nothing else.
// Nothing here signs, executes, applies or approves: execution exists only behind the owner (owner.mjs,
// admin.mjs). The seat always comes from the key, never from the request.
//   GET  /runner/v1/board
//   POST /runner/v1/proposals              {protocol, seat, runId, requestId, boardVersion, action, reason?}
//   GET  /runner/v1/proposals/{id}
//   POST /runner/v1/runs/{runId}/revoke
import crypto from 'node:crypto';
import * as E from './economy.mjs';
import { solscanTx, proposalImmutable } from './hood.mjs';

const IDS = ['marrow', 'pip', 'soot', 'brine', 'lark'];
const TOKEN = /^[A-Za-z0-9._:-]{1,80}$/;
const LOT = v => typeof v === 'string' && /^[A-G][1-7]$/.test(v) && v !== 'D4';
const COUNT = (v, max = 1e6) => Number.isSafeInteger(v) && v > 0 && v <= max;
// allowed parameters per action: [required, optional], and how each is checked
const ACTIONS = {
  buy_lot: [['lot'], []], build: [['lot', 'kind'], []], upgrade: [['lot'], []],
  list: [['price_sol'], ['lot', 'crates']], delist: [['listing'], []], buy: [['listing'], []],
  buyout: [['target'], []], crates: [['side', 'qty'], []],
};
const FIELD = {
  lot: LOT, kind: v => Object.hasOwn(E.KINDS, v), listing: v => COUNT(v), crates: v => COUNT(v), qty: v => COUNT(v, 10),
  side: v => v === 'buy' || v === 'sell', price_sol: v => Number.isFinite(v) && v > 0 && v <= 1000 && Number.isSafeInteger(Math.round(v * 1e9)),
  target: v => IDS.includes(v),
};
const MOVE = {
  buy_lot: p => ({ type: 'buy_lot', lot: p.lot }), build: p => ({ type: 'build', lot: p.lot, kind: p.kind }), upgrade: p => ({ type: 'upgrade', lot: p.lot }),
  list: p => ({ type: 'list', lot: p.lot, crates: p.crates, price_sol: p.price_sol }), delist: p => ({ type: 'delist', listing: p.listing }),
  buy: p => ({ type: 'buy', listing: p.listing }), buyout: p => ({ type: 'buyout', target: p.target }),
  crates: p => ({ type: p.side === 'buy' ? 'buy_crates' : 'sell_crates', qty: p.qty }),
};
// the runner's state names
const STATE = { pending: 'pending', executing: 'executing', executed: 'confirmed', applied: 'applied', rejected: 'rejected', expired: 'expired', void: 'revoked', stale: 'reapproval_required', failed: 'failed' };
const plain = o => o && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;

// ttlMs: the runner refuses an expiry more than 2 minutes out; 110 s leaves room for clock skew between machines.
export function createRunnerApi({ hood, seats, ttlMs = 110_000, perMinute = 60 }) {
  const keys = Object.entries(seats).map(([who, k]) => [who, Buffer.from(k)]);
  const pace = new Map();
  const idem = new Map(); // `${seat}|${runId}|${requestId}` -> { fingerprint, id }; rebuilt from the proposals
  for (const x of hood.s.proposals || []) if (x.runId && x.requestId && x.seat) idem.set(`${x.seat}|${x.runId}|${x.requestId}`, { fingerprint: x.fingerprint || null, id: x.id });

  const principal = req => {
    const got = Buffer.from(/^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1] || '');
    for (const [who, k] of keys) if (got.length === k.length && crypto.timingSafeEqual(got, k)) return who === 'house' ? { keeper: true } : { seat: who };
    return null;
  };
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(body)); };
  const fail = (res, code, error, extra = {}) => send(res, code, { ok: false, error, ...extra });

  function board() {
    const s = hood.s;
    const players = IDS.map(id => {
      const a = E.agentOf(s, id), est = E.estate(s, id);
      return { id, wallet: a.address, balance: a.balance, spendable: Math.min(a.balance, E.spendable(a)), upkeep: E.ownedBy(s, id).reduce((t, l) => t + E.upkeepOf(s, l), 0), estate: Math.round(est), net: Math.round(a.balance + est), lots: E.ownedBy(s, id).length };
    });
    const lots = s.lots.map(l => ({ lot: E.lotName(l.i), owner: l.owner, build: l.build ? { kind: l.build.kind, level: l.build.level } : null }));
    return {
      network: s.cluster, version: hood.boardVersion(), office: s.office.address, players,
      text: `Epoch ${s.epoch}. Land costs ${E.sol(E.lotPrice(s))}. ${s.halted ? 'THE HOOD IS STOPPED: proposals are refused until the owner resumes it. ' : ''}Every change you propose waits for the owner's review; nothing executes on your call.`,
      lots, listings: s.listings.map(L => ({ ...L })), lotPrice: E.lotPrice(s), epoch: s.epoch, stopped: !!s.halted,
    };
  }

  function view(x) {
    const out = { ...proposalImmutable(x), proposalHash: x.proposalHash, state: STATE[x.status] || x.status };
    if (x.status === 'executed' && x.sig) Object.assign(out, { signature: x.sig, receipt: solscanTx(hood.s.cluster, x.sig) });
    if (x.reason) out.reason = x.reason;
    return out;
  }

  function stage(who, raw) {
    let r;
    try { r = JSON.parse(raw || ''); } catch { return [400, { ok: false, error: 'bad_json' }]; }
    if (!plain(r) || !Object.keys(r).every(k => ['protocol', 'seat', 'runId', 'requestId', 'boardVersion', 'action', 'reason'].includes(k))) return [400, { ok: false, error: 'unknown_fields' }];
    if (r.protocol !== 'dothood-proposal-v1') return [400, { ok: false, error: 'protocol' }];
    if (r.seat !== who) return [403, { ok: false, error: 'wrong_seat' }];
    if (!TOKEN.test(r.runId || '') || !TOKEN.test(r.requestId || '')) return [400, { ok: false, error: 'bad_ids' }];
    if (['mcp', 'house'].includes(r.runId)) return [400, { ok: false, error: 'reserved_run_id' }];
    if (typeof r.boardVersion !== 'string' || !plain(r.action) || !Object.keys(r.action).every(k => k === 'type' || k === 'parameters')) return [400, { ok: false, error: 'bad_action' }];
    const spec = ACTIONS[r.action.type], params = r.action.parameters;
    if (!spec) return [400, { ok: false, error: 'unknown_proposal_action' }];
    if (!plain(params) || !Object.keys(params).every(k => spec[0].includes(k) || spec[1].includes(k))) return [400, { ok: false, error: 'unknown_argument' }];
    if (!spec[0].every(k => Object.hasOwn(params, k)) || !Object.entries(params).every(([k, v]) => FIELD[k](v))) return [400, { ok: false, error: 'bad_argument' }];
    if (r.action.type === 'list' && ('lot' in params) === ('crates' in params)) return [400, { ok: false, error: 'one_listing_asset' }];
    if (r.action.type === 'buyout' && params.target === who) return [400, { ok: false, error: 'bad_target' }];
    if (r.reason !== undefined && (typeof r.reason !== 'string' || r.reason.length > 240)) return [400, { ok: false, error: 'bad_reason' }];
    // idempotency: the same request again returns the same record; a different payload under it is refused
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([r.protocol, r.seat, r.runId, r.requestId, r.boardVersion, r.action, r.reason ?? null])).digest('hex');
    const key = `${who}|${r.runId}|${r.requestId}`, seen = idem.get(key);
    if (seen) {
      const x = hood.proposal(seen.id);
      if (seen.fingerprint !== fingerprint || !x) return [409, { ok: false, error: 'idempotency_conflict' }];
      return [200, view(x)];
    }
    if (hood.runRevoked(r.runId, who)) return [409, { ok: false, error: 'run_revoked' }];
    if (hood.s.halted) return [409, { ok: false, error: 'stopped' }];
    if (r.boardVersion !== hood.boardVersion()) return [409, { ok: false, error: 'stale_board', boardVersion: hood.boardVersion() }];
    const note = r.reason ? r.reason.replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim() : null;
    const pr = hood.propose(who, MOVE[r.action.type](params), `runner:${who}`, { requestId: r.requestId, runId: r.runId, action: { type: r.action.type, parameters: params }, note, ttlMs });
    if (!pr.ok) return [409, { ok: false, error: pr.code || 'refused', detail: pr.error }];
    pr.proposal.fingerprint = fingerprint;
    idem.set(key, { fingerprint, id: pr.proposal.id });
    hood.save();
    return [201, view(pr.proposal)];
  }

  return async function handle(req, res, url, body) {
    const who = principal(req);
    if (!who) return fail(res, 401, 'unauthenticated');
    const k = who.seat || 'keeper', now = Date.now();
    const times = (pace.get(k) || []).filter(t => now - t < 60_000);
    if (times.length >= perMinute) return fail(res, 429, 'rate_limited');
    times.push(now); pace.set(k, times);
    const p = url.pathname;
    if (req.method === 'GET' && p === '/runner/v1/board') return send(res, 200, board());
    if (req.method === 'POST' && p === '/runner/v1/proposals') {
      if (!who.seat) return fail(res, 403, 'keeper_cannot_propose');
      return send(res, ...await hood.run(async () => stage(who.seat, body)));
    }
    const one = /^\/runner\/v1\/proposals\/(\d{1,9})$/.exec(p);
    if (req.method === 'GET' && one) {
      hood.expireProposals();
      const x = hood.proposal(one[1]);
      if (!x || !who.seat || x.seat !== who.seat) return fail(res, 404, 'unknown_proposal');
      return send(res, 200, view(x));
    }
    const rv = /^\/runner\/v1\/runs\/([A-Za-z0-9._:-]{1,80})\/revoke$/.exec(p);
    if (req.method === 'POST' && rv) {
      if (['mcp', 'house'].includes(rv[1])) return fail(res, 400, 'reserved_run_id');
      const r = await hood.revokeRun(rv[1], who.seat || null, who.seat ? `runner:${who.seat}` : 'keeper');
      return send(res, 200, { ok: true, runId: rv[1], revoked: r.revoked, scope: who.seat || 'all' });
    }
    return fail(res, 404, 'not_here');
  };
}

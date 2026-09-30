// The owner's side: the only place a pending proposal can be executed. Two doors lead to the same core:
//   - the owner API (below): answers only to a request made on this machine itself (the owner's SSH tunnel, used by
//     scripts on the owner's machine), never to one relayed by the website's proxy, and only with the owner key;
//   - the admin page (admin.mjs): the website's /admin/, behind the owner's password, a CSRF token and a
//     per-proposal review challenge.
//   GET  /owner-api/proposals        pending (each re-checked right now) + recent history
//   GET  /owner-api/stream           server-sent events: a nudge whenever anything changes
//   POST /owner-api/approve {id, proposalHash, transactionHash}   execute that exact pending proposal once
//   POST /owner-api/reject  {id, reason}
//   POST /owner-api/stop    {reason}  void every pending proposal, refuse new ones, pause settlements
//   POST /owner-api/resume
import crypto from 'node:crypto';
import * as E from './economy.mjs';
import { solscanTx, describeMove } from './hood.mjs';

export function makeOwnerKey() {
  return `dho_${crypto.randomBytes(24).toString('base64url')}`;
}

const HEX64 = /^[0-9a-f]{64}$/;
const feeSol = l => `${(l / 1e9).toFixed(6)} SOL`;

export function createOwnerCore({ hood }) {
  const streams = new Set();
  hood.on('change', () => { for (const res of streams) res.write('event: change\ndata: {}\n\n'); });
  setInterval(() => { for (const res of streams) res.write(': keepalive\n\n'); }, 25_000).unref();

  const nameOf = addr => (addr === hood.s.office.address ? 'the office' : hood.s.agents.find(a => a.address === addr)?.name || addr);
  const agentOf = id => hood.s.agents.find(a => a.id === id);
  const view = async x => ({
    id: x.id, kind: x.kind || 'player', agent: x.agent, seat: x.seat, requestId: x.requestId, runId: x.runId,
    name: x.kind === 'house' ? 'The house' : agentOf(x.agent)?.name, color: x.kind === 'house' ? '#0b0b0b' : agentOf(x.agent)?.color, by: x.by,
    move: describeMove(x.move), action: x.action, offchain: !!x.offchain, note: x.note || null, status: x.status,
    network: x.network, boardVersion: x.boardVersion, proposalHash: x.proposalHash, transactionHash: x.transactionHash,
    fee: x.fee != null ? feeSol(x.fee) : null, expiresAt: x.expiresAt, at: x.at, closedAt: x.closedAt || null, reason: x.reason || null,
    payer: x.payer, payerName: nameOf(x.payer), memo: x.memo,
    transfers: x.transfers.map(t => ({ to: t.to, toName: nameOf(t.to), from: t.from, fromName: nameOf(t.from), lamports: t.lamports, sol: E.sol(t.lamports) })),
    total: x.offchain ? 'no SOL' : E.sol(x.amount),
    receipt: x.sig ? solscanTx(hood.s.cluster, x.sig) : null, result: x.result || null,
    check: x.status === 'pending' ? await hood.review(x.id) : null,
  });

  return {
    async state() {
      hood.expireProposals();
      const all = hood.s.proposals || [];
      const pending = await Promise.all(all.filter(x => x.status === 'pending').map(view));
      const executing = await Promise.all(all.filter(x => x.status === 'executing').map(view));
      const recent = await Promise.all(all.filter(x => x.status !== 'pending' && x.status !== 'executing').slice(-40).reverse().map(view));
      return {
        ok: true, cluster: hood.s.cluster, epoch: hood.s.epoch, rev: hood.s.rev, boardVersion: hood.boardVersion(), now: Date.now(), ttlMs: hood.proposalTtlMs, halted: hood.s.halted || null,
        wallets: [{ name: 'Office', color: '#0b0b0b', balance: E.sol(hood.s.office.balance) }, ...hood.s.agents.map(a => ({ name: a.name, color: a.color, balance: E.sol(a.balance), seat: a.seat?.by || null }))],
        pending, executing, recent, x: hood.xStatus ? hood.xStatus() : null,
      };
    },
    stream(req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 3000\nevent: change\ndata: {}\n\n');
      streams.add(res);
      req.on('close', () => streams.delete(res));
    },
    // kind: 'approve' | 'reject' | 'stop' | 'resume'; body: the raw JSON; by: who pressed it (goes in the log and
    // the public feed). Approve names the exact record the owner reviewed: both of its hashes.
    async act(kind, body, by) {
      let msg;
      try { msg = JSON.parse(body || '{}'); } catch { return [400, { ok: false, error: 'bad json' }]; }
      if (kind === 'stop' || kind === 'resume') {
        const r = kind === 'stop' ? await hood.halt(by, String(msg.reason || 'stopped by the owner')) : await hood.resume(by);
        hood.log({ kind: `owner-${kind}`, by, ok: r.ok });
        return [200, { ok: r.ok, voided: r.voided ?? null }];
      }
      const id = Number(msg.id);
      if (!Number.isInteger(id)) return [400, { ok: false, error: 'id required' }];
      if (kind === 'approve' && !(HEX64.test(String(msg.proposalHash || '')) && HEX64.test(String(msg.transactionHash || '')))) {
        return [400, { ok: false, error: 'proposalHash and transactionHash required: approve the exact proposal you reviewed' }];
      }
      const r = kind === 'approve'
        ? await hood.approve(id, by, { proposalHash: msg.proposalHash, transactionHash: msg.transactionHash })
        : await hood.reject(id, by, msg.reason);
      hood.log({ kind: `owner-${kind}`, id, by, ok: r.ok, error: r.error || null });
      return [200, { ok: r.ok, code: r.code || null, error: r.error || null, receipt: r.sig ? solscanTx(hood.s.cluster, r.sig) : null }];
    },
  };
}

export const sendJson = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

export function createOwnerApi({ hood, ownerKey, core = createOwnerCore({ hood }) }) {
  const key = Buffer.from(ownerKey);
  const authorized = req => {
    // local only: the site's nginx proxy always adds X-Forwarded-For, the owner's SSH tunnel never does
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress) && !req.headers['x-forwarded-for'];
    const got = Buffer.from(/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1] || '');
    return local && got.length === key.length && crypto.timingSafeEqual(got, key);
  };

  return async function handle(req, res, url, body) {
    if (!authorized(req)) return sendJson(res, 403, { ok: false, error: 'owner only' });
    const p = url.pathname;
    if (req.method === 'GET' && p === '/owner-api/proposals') return sendJson(res, 200, await core.state());
    if (req.method === 'GET' && p === '/owner-api/stream') return core.stream(req, res);
    const kind = /^\/owner-api\/(approve|reject|stop|resume)$/.exec(p)?.[1];
    if (req.method === 'POST' && kind) return sendJson(res, ...(await core.act(kind, body, 'owner (tunnel)')));
    return sendJson(res, 404, { ok: false, error: 'not here' });
  };
}

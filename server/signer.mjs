// Swigglies signer: the only process that holds wallet keys. The game server (website + MCP door) proposes
// payment plans { payer, transfers, memo } over a local Unix socket; the signer checks each one against
// the guard (guard.mjs), builds the transaction itself, signs it, submits it and returns the receipt.
// No HTTP, no MCP, no model and no player ever reaches this process. A player (a ChatGPT Dot) only
// proposes moves; this process decides whether they are signed.
//
//   node signer.mjs        (as the signer's own user; env: SWIGGLIES_KEY, CLUSTER, STATE_DIR,
//                           SIGNER_SOCKET, AUTOSIGN_DAILY_SOL, RPC_URL, PRIORITY_MICROLAMPORTS, COMPUTE_UNITS)
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKeystore } from './keystore.mjs';
import { SolanaChain, SimChain, LAMPORTS, isAddress } from './solana.mjs';
import { guardChain } from './guard.mjs';
import { ROSTER } from './roster.mjs';

// The request handler, separate from the socket so tests can drive it directly.
export function createSigner({ chain, office, agents, cluster, stateDir = null, dailyCapLamports = null, maxSendsPerMinute = 120 }) {
  const wallets = [office, ...agents.map(a => a.kp)];
  const byAddr = new Map(wallets.map(kp => [kp.address, kp]));
  const guarded = guardChain(chain, { wallets: wallets.map(kp => kp.address), cluster, stateDir, dailyCapLamports });
  let queue = Promise.resolve();
  const recent = [];
  const plain = plan => ({
    payer: String(plan?.payer || ''),
    memo: typeof plan?.memo === 'string' ? plan.memo.slice(0, 200) : '',
    transfers: Array.isArray(plan?.transfers) ? plan.transfers.slice(0, 8).map(t => ({ from: String(t?.from || ''), to: String(t?.to || ''), lamports: t?.lamports })) : [],
    templateHash: /^[0-9a-f]{64}$/.test(plan?.templateHash || '') ? plan.templateHash : null,
  });

  async function handle(req) {
    switch (req?.op) {
      case 'addresses':
        return { ok: true, cluster, priority: guarded.priority, office: office.address, agents: Object.fromEntries(agents.map(a => [a.id, a.kp.address])) };
      case 'check':
        return { ok: true, verdict: guarded.check(plain(req.plan)) };
      case 'remaining':
        return { ok: true, lamports: isAddress(req.address) ? guarded.remainingToday(req.address) : null };
      case 'send': {
        const now = Date.now();
        while (recent.length && now - recent[0] > 60_000) recent.shift();
        if (recent.length >= maxSendsPerMinute) return { ok: false, guard: true, error: `signing guard: more than ${maxSendsPerMinute} signatures a minute` };
        recent.push(now);
        const plan = plain(req.plan);
        // one signature at a time, in the order they arrive
        const run = queue.then(() => guarded.send({ ...plan, keyFor: addr => byAddr.get(addr) }));
        queue = run.catch(() => {});
        try {
          const r = await run;
          return { ok: true, signature: r.signature, signatures: r.signatures || [r.signature], fee: r.fee };
        } catch (e) {
          return { ok: false, guard: !!e.guard, error: e.message };
        }
      }
      default:
        return { ok: false, error: 'unknown op' };
    }
  }
  return { handle, guarded };
}

// Line-delimited JSON over a Unix socket: each request { id, op, ... } gets { id, ... } back.
export function serveSigner(signer, socketPath, mode = 0o660) {
  if (fs.existsSync(socketPath)) fs.rmSync(socketPath);
  const server = net.createServer(conn => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', chunk => {
      buf += chunk;
      if (buf.length > 64_000) { conn.destroy(); return; }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let req;
        try { req = JSON.parse(line); } catch { conn.write(`${JSON.stringify({ ok: false, error: 'bad json' })}\n`); continue; }
        signer.handle(req).then(res => conn.write(`${JSON.stringify({ id: req.id, ...res })}\n`), e => conn.write(`${JSON.stringify({ id: req.id, ok: false, error: e.message })}\n`));
      }
    });
    conn.on('error', () => {});
  });
  return new Promise(resolve => server.listen(socketPath, () => { fs.chmodSync(socketPath, mode); resolve(server); }));
}

// Wallet file names: mainnet wallets are their own set, never the devnet rehearsal keys.
export const walletName = (cluster, id) => (cluster === 'mainnet-beta' ? `mainnet-${id}` : id);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const cluster = env.CLUSTER || 'devnet';
  const stateDir = env.STATE_DIR || '/var/lib/swigglies-signer';
  const socketPath = env.SIGNER_SOCKET || '/run/swigglies-signer/signer.sock';
  const rpcUrl = env.RPC_URL || (cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : `https://api.${cluster}.solana.com`);
  const priority = cluster === 'mainnet-beta' || env.PRIORITY_MICROLAMPORTS
    ? { units: Number(env.COMPUTE_UNITS || 30_000), microLamports: Number(env.PRIORITY_MICROLAMPORTS ?? 50_000) } : null;
  const keys = openKeystore(path.join(stateDir, 'keys'), env.SWIGGLIES_KEY || env.DOTHOOD_KEY);
  const office = keys.wallet(walletName(cluster, 'office'));
  const agents = ROSTER.map(r => ({ id: r.id, kp: keys.wallet(walletName(cluster, r.id)) }));
  const chain = cluster === 'sim' ? new SimChain() : new SolanaChain({ rpcUrl, cluster, priority });
  if (cluster === 'sim') [office, ...agents.map(a => a.kp)].forEach(kp => chain.fund(kp.address, LAMPORTS));
  const signer = createSigner({
    chain, office, agents, cluster, stateDir,
    dailyCapLamports: env.AUTOSIGN_DAILY_SOL ? Math.round(Number(env.AUTOSIGN_DAILY_SOL) * LAMPORTS) : null,
  });
  await serveSigner(signer, socketPath);
  console.log(`swigglies signer · ${cluster} via ${cluster === 'sim' ? 'in-process chain' : rpcUrl} · socket ${socketPath} · office ${office.address}`);
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { fs.rmSync(socketPath, { force: true }); process.exit(0); });
}

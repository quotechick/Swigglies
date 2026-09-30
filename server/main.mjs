// Swigglies server: static pages, the live state (JSON + server-sent events), and the MCP seat door.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKeystore } from './keystore.mjs';
import { SolanaChain, SimChain, LAMPORTS, clusterFiles } from './solana.mjs';
import { Hood } from './hood.mjs';
import { guardChain } from './guard.mjs';
import { RemoteSigner, SplitChain } from './signer-client.mjs';
import { createOwnerApi, createOwnerCore, makeOwnerKey } from './owner.mjs';
import { createAdmin } from './admin.mjs';
import { createRunnerApi } from './runner-api.mjs';
import { createXPoster } from './xpost.mjs';
import { ROSTER } from './roster.mjs';
import { publicState } from './economy.mjs';
import { createMcp, makeSeats, standingsText, standingsJson } from './mcp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const cfg = {
  port: Number(env.PORT || 8162),
  host: env.HOST || '127.0.0.1',
  stateDir: env.STATE_DIR || path.join(here, '..', '.state'),
  webDir: env.WEB_DIR || path.join(here, '..', 'web'),
  cluster: env.CLUSTER || 'devnet',
  unit: Number(env.UNIT_LAMPORTS || 10_000_000),
  tickMs: Number(env.TICK_MS || 12_000),
  epochMs: Number(env.EPOCH_MS || 120_000),
  seatHoldMs: Number(env.SEAT_HOLD_MS || 1_200_000),
  publicUrl: env.PUBLIC_URL || '',
  stakeLamports: Math.round(Number(env.STAKE_SOL ?? 1) * LAMPORTS), // each dot's starting stake; 0 = 80% of the office, split
  maxTxPerDay: Number(env.MAX_TX_PER_DAY || 3000),
};
cfg.rpc = env.RPC_URL || (cfg.cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : `https://api.${cfg.cluster}.solana.com`);
// Mainnet moves carry a small priority fee so they still land when the network is busy (default 30k CU at
// 50k micro-lamports = 1,500 lamports a move); devnet only if PRIORITY_MICROLAMPORTS is set.
cfg.priority = cfg.cluster === 'mainnet-beta' || env.PRIORITY_MICROLAMPORTS
  ? { units: Number(env.COMPUTE_UNITS || 30_000), microLamports: Number(env.PRIORITY_MICROLAMPORTS ?? 50_000) } : null;
cfg.files = clusterFiles(cfg.cluster);

fs.mkdirSync(cfg.stateDir, { recursive: true });

const seatsFile = path.join(cfg.stateDir, 'seats.json');
if (!fs.existsSync(seatsFile)) fs.writeFileSync(seatsFile, JSON.stringify(makeSeats(), null, 1), { mode: 0o600 });
const seats = JSON.parse(fs.readFileSync(seatsFile, 'utf8'));

// Two ways to sign. With SIGNER_SOCKET (production), this process holds no keys at all: it reads balances
// from the RPC and asks the separate signer process (signer.mjs) to check, sign and send every plan.
// Without it (local simulator, tests), the keys are opened here and the same guard wraps the chain.
let office, agents, chain;
if (env.SIGNER_SOCKET) {
  const signer = new RemoteSigner(env.SIGNER_SOCKET);
  const addrs = await signer.addresses();
  if (addrs.cluster !== cfg.cluster) throw new Error(`the signer runs ${addrs.cluster} but this server is set to ${cfg.cluster}`);
  // both sides compile the reviewed transaction: their fee settings must be identical
  if (JSON.stringify(addrs.priority ?? null) !== JSON.stringify(cfg.priority)) throw new Error(`the signer's priority fee ${JSON.stringify(addrs.priority)} differs from this server's ${JSON.stringify(cfg.priority)}`);
  office = { kp: { address: addrs.office } };
  agents = ROSTER.map(r => ({ r, kp: { address: addrs.agents[r.id] } }));
  chain = new SplitChain({ reader: new SolanaChain({ rpcUrl: cfg.rpc, cluster: cfg.cluster }), signer, cluster: cfg.cluster, priority: cfg.priority });
} else {
  const keys = openKeystore(path.join(cfg.stateDir, 'keys'), env.SWIGGLIES_KEY || env.DOTHOOD_KEY);
  office = { kp: keys.wallet('office') };
  agents = ROSTER.map(r => ({ r, kp: keys.wallet(r.id) }));
  const rawChain = cfg.cluster === 'sim' ? new SimChain() : new SolanaChain({ rpcUrl: cfg.rpc, cluster: cfg.cluster, priority: cfg.priority });
  if (cfg.cluster === 'sim') [office, ...agents].forEach(w => rawChain.fund(w.kp.address, LAMPORTS));
  chain = guardChain(rawChain, {
    wallets: [office, ...agents].map(w => w.kp.address), cluster: cfg.cluster, stateDir: cfg.stateDir,
    dailyCapLamports: env.AUTOSIGN_DAILY_SOL ? Math.round(Number(env.AUTOSIGN_DAILY_SOL) * LAMPORTS) : null,
  });
}

const hood = new Hood({
  chain, office, agents, unit: cfg.unit, cluster: cfg.cluster, tickMs: cfg.tickMs, epochMs: cfg.epochMs, seatHoldMs: cfg.seatHoldMs,
  stakeLamports: cfg.stakeLamports, maxTxPerDay: cfg.maxTxPerDay,
  // on mainnet the owner executes every player move, so no autopilot spends a quiet seat's wallet
  autopilot: env.AUTOPILOT ? env.AUTOPILOT === '1' : cfg.cluster !== 'mainnet-beta',
  // ...and every transaction, the house's own included, waits for the owner's Accept
  ownerExecutes: env.OWNER_EXECUTES ? env.OWNER_EXECUTES === '1' : cfg.cluster === 'mainnet-beta',
  stateFile: path.join(cfg.stateDir, cfg.files.state), logFile: path.join(cfg.stateDir, cfg.files.log),
});
// a proposal is reviewed against the board it was made on: none survives a restart
hood.voidPending('the server restarted', 'office');
const mcp = createMcp({ hood, seats });
// the proposal-only runner's door (restricted-runner/): seat keys stage pending proposals, nothing more
const runner = createRunnerApi({ hood, seats, ttlMs: Number(env.RUNNER_TTL_MS || 110_000) });

// The owner key: executes pending proposals, and only from this machine (the owner's SSH tunnel). See owner.mjs.
const ownerKeyFile = path.join(cfg.stateDir, 'owner.key');
if (!fs.existsSync(ownerKeyFile)) fs.writeFileSync(ownerKeyFile, makeOwnerKey(), { mode: 0o600 });
// every executed transaction is posted to X with its Solscan receipt, once the owner's X keys are set
const xposter = createXPoster({ hood, env, stateDir: cfg.stateDir });
hood.xStatus = () => xposter.status();
const ownerCore = createOwnerCore({ hood });
const owner = createOwnerApi({ hood, core: ownerCore, ownerKey: fs.readFileSync(ownerKeyFile, 'utf8').trim() });
// ...and the website's /admin/ page, behind the owner's password (STATE_DIR/admin.json; node tools.mjs admin-password)
const admin = createAdmin({ hood, core: ownerCore, stateDir: cfg.stateDir });

const snapshot = () => ({
  ...publicState(hood.s), epochMs: cfg.epochMs, tickMs: cfg.tickMs, seatHoldMs: cfg.seatHoldMs,
  staked: !!hood.s.staked || hood.s.agents.some(a => a.balance > 0),
  stake: { perDot: cfg.stakeLamports, needs: cfg.stakeLamports ? Math.ceil(cfg.stakeLamports * 5 * 0.95) : 50_000_000 },
  ledgerSize: hood.ledger.length,
});
const streams = new Set();
hood.on('change', ({ feed, fx }) => {
  const data = `event: state\ndata: ${JSON.stringify({ state: snapshot(), feed, fx })}\n\n`;
  for (const res of streams) res.write(data);
});
setInterval(() => { for (const res of streams) res.write(': keepalive\n\n'); }, 25_000);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };
const PAGES = { '/': 'index.html', '/hood': 'hood.html', '/ledger': 'ledger.html' };
// the old public "seat a dot" page is gone: the experiment is closed, so its address points at the explainer
const RETIRED = new Set(['/dots', '/dots.html', '/js/dots.js']);

function serveStatic(req, res, pathname) {
  const rel = PAGES[pathname] || pathname.replace(/^\/+/, '');
  const file = path.resolve(cfg.webDir, rel);
  if (!file.startsWith(path.resolve(cfg.webDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not here');
  }
  const ext = path.extname(file);
  const size = fs.statSync(file).size;
  const head = {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': rel.startsWith('vendor/') || rel.startsWith('media/') ? 'public, max-age=86400' : 'no-cache',
    'x-content-type-options': 'nosniff', 'accept-ranges': 'bytes',
  };
  // byte ranges, so a phone can play and seek the film
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...head, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (p === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(snapshot()));
    }
    if (p === '/api/stream') {
      if (streams.size > 800) { res.writeHead(503); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`retry: 3000\nevent: state\ndata: ${JSON.stringify({ state: snapshot(), feed: [], fx: [] })}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (p === '/api/ledger') {
      // every on-chain move since the start, newest first, paged with ?before=<id>&limit=<n>
      const before = Number(url.searchParams.get('before')) || Infinity;
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const rows = [];
      for (let i = hood.ledger.length - 1; i >= 0 && rows.length < limit; i--) if (hood.ledger[i].id < before) rows.push(hood.ledger[i]);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ cluster: hood.s.cluster, total: hood.ledger.length, rows, more: rows.length === limit && rows.at(-1).id > (hood.ledger[0]?.id ?? 0) }));
    }
    if (p === '/api/standings' || p === '/api/standings.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end(standingsText(snapshot(), cfg.publicUrl));
    }
    if (p === '/api/standings.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(standingsJson(snapshot()), null, 1));
    }
    if (p === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, rev: hood.s.rev, epoch: hood.s.epoch, cluster: cfg.cluster, chain: hood.s.chain || null, streams: streams.size }));
    }
    if (p === '/mcp' || p.startsWith('/mcp/')) {
      // the seat key may ride in the path (/mcp/<key>) for connector forms that drop query strings
      if (p.length > 5) url.searchParams.set('seat', decodeURIComponent(p.slice(5)));
      return mcp(req, res, url, req.method === 'POST' ? await readBody(req) : '');
    }
    if (p.startsWith('/owner-api/')) return owner(req, res, url, req.method === 'POST' ? await readBody(req, 8192) : '');
    if (p.startsWith('/runner/v1/')) return runner(req, res, url, req.method === 'POST' ? await readBody(req, 8192) : '');
    if (p === '/admin' || p.startsWith('/admin/')) return admin(req, res, url, req.method === 'POST' ? await readBody(req, 8192) : '');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (RETIRED.has(p)) { res.writeHead(301, { location: p.startsWith('/js/') ? '../#experiment' : './#experiment' }); return res.end(); }
    return serveStatic(req, res, p);
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('error');
    hood.log({ kind: 'http-error', path: p, error: e.message });
  }
});

// Devnet only: while the hood is unstaked and the office is empty, ask the public faucet again every
// 30 minutes. When SOL lands, the refresh loop sees it and the office stakes the five by itself.
if (cfg.cluster === 'devnet' && env.AUTO_AIRDROP !== '0' && env.NO_LOOP !== '1') {
  const tryAirdrop = async () => {
    if (hood.s.staked || hood.s.office.balance >= 50_000_000) return;
    for (const amount of [2, 1]) {
      try { hood.log({ kind: 'airdrop', sol: amount, sig: await chain.airdrop(office.kp.address, amount * LAMPORTS) }); return; }
      catch (e) { hood.log({ kind: 'airdrop-miss', sol: amount, error: e.message.slice(0, 140) }); }
    }
  };
  setTimeout(tryAirdrop, 60_000);
  setInterval(tryAirdrop, 30 * 60_000);
}

// On stop (deploys restart the service), finish whatever move is between send and apply, save, exit.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    hood.stop();
    server.close();
    for (const res of streams) res.end();
    const drained = hood.run(() => hood.save());
    Promise.race([drained, new Promise(r => setTimeout(r, 80_000))]).finally(() => process.exit(0));
  });
}

server.listen(cfg.port, cfg.host, () => {
  console.log(`swigglies on ${cfg.host}:${cfg.port} · ${cfg.cluster === 'sim' ? 'simulated chain (in-process, no network)' : `${cfg.cluster} via ${cfg.rpc}`} · unit ${cfg.unit} lamports`);
  console.log(`office ${office.kp.address} · ${agents.map(w => `${w.r.id} ${w.kp.address}`).join(' · ')}`);
  if (env.NO_LOOP !== '1') hood.start();
});

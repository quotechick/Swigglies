// Keeper tools, run on the box with the server's environment loaded:
//   node tools.mjs addresses        the six wallets with Solscan links and balances
//   node tools.mjs airdrop [sol]    ask the devnet faucet for SOL for every wallet under 0.5 SOL
//   node tools.mjs seats            the MCP seat keys (house key + one per dot)
//   node tools.mjs export-keys      Solana CLI keypair arrays, for importing a wallet elsewhere
//   node tools.mjs seed <sol>       the office pays each dot <sol> in one transaction (fund the office first)
//   node tools.mjs probe            build + sign a real transfer and have devnet simulate it with sigVerify
//   node tools.mjs probe-exec       run our exact messages on devnet's runtime from funded fee payers (no SOL needed)
//   node tools.mjs who              MCP clients that connected, what they called, and who holds each seat
//   node tools.mjs rotate-seats     new seat keys (restart the service after)
//   node tools.mjs autosign on|off|status   the auto-signer's off switch, network check and today's signed/refused count
//   node tools.mjs sweep <address> --yes   END OF A RUN: send everything in the six wallets to <address>
//                                          (stop the service first so nothing moves mid-sweep)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openKeystore } from './keystore.mjs';
import { SolanaChain, LAMPORTS, MEMO_PROGRAM, SIG_FEE, secretKey64, newKeypair, compileMessage, signTransaction, clusterFiles, isAddress } from './solana.mjs';
import { ROSTER } from './roster.mjs';
import { walletName } from './signer.mjs';
import { writeAdminPassword, makeAdminPassword } from './admin.mjs';

const env = process.env;
const stateDir = env.STATE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.state'); // same default as main.mjs
const cluster = env.CLUSTER || 'devnet';
const rpcUrl = env.RPC_URL || (cluster === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : `https://api.${cluster}.solana.com`);
// Keys are opened only by the commands that need them (run these as the signer's user with its env);
// mainnet wallets are their own set (see signer.mjs walletName).
const KEY_COMMANDS = new Set(['addresses', 'airdrop', 'export-keys', 'seed', 'sweep']);
const wallets = KEY_COMMANDS.has(process.argv[2]) ? (() => {
  const keys = openKeystore(path.join(stateDir, 'keys'), env.SWIGGLIES_KEY || env.DOTHOOD_KEY);
  return [['office', keys.wallet(walletName(cluster, 'office'))], ...ROSTER.map(r => [r.id, keys.wallet(walletName(cluster, r.id))])];
})() : [];
const priority = cluster === 'mainnet-beta' ? { units: Number(env.COMPUTE_UNITS || 30_000), microLamports: Number(env.PRIORITY_MICROLAMPORTS ?? 50_000) } : null;
const chain = new SolanaChain({ rpcUrl, cluster, priority });
const moveFee = SIG_FEE + (priority ? Math.ceil((priority.units * priority.microLamports) / 1e6) : 0);
const scan = a => `https://solscan.io/account/${a}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;

const cmd = process.argv[2];
if (cmd === 'addresses') {
  const bals = await chain.balances(wallets.map(([, kp]) => kp.address));
  wallets.forEach(([name, kp], i) => console.log(`${name.padEnd(7)} ${(bals[i] / LAMPORTS).toFixed(4).padStart(10)} SOL  ${scan(kp.address)}`));
} else if (cmd === 'airdrop') {
  if (cluster === 'mainnet-beta') throw new Error('no faucet on mainnet');
  const want = Math.round(Number(process.argv[3] || 1) * LAMPORTS);
  const bals = await chain.balances(wallets.map(([, kp]) => kp.address));
  for (const [i, [name, kp]] of wallets.entries()) {
    if (bals[i] >= LAMPORTS / 2) { console.log(`${name}: has ${(bals[i] / LAMPORTS).toFixed(3)} SOL, skipped`); continue; }
    try { console.log(`${name}: airdrop ${await chain.airdrop(kp.address, want)}`); }
    catch (e) { console.log(`${name}: faucet said no: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500));
  }
} else if (cmd === 'admin-password') {
  const pw = process.argv[3] === '--stdin' ? fs.readFileSync(0, 'utf8').trim() : makeAdminPassword();
  const file = await writeAdminPassword(stateDir, pw);
  if (process.argv[3] === '--stdin') console.error(`admin password set (${file})`);
  else { console.log(pw); console.error(`admin password set (${file}); the line above is shown only this once`); }
} else if (cmd === 'seats') {
  console.log(fs.readFileSync(path.join(stateDir, 'seats.json'), 'utf8'));
} else if (cmd === 'export-keys') {
  for (const [name, kp] of wallets) console.log(`${name} ${kp.address}\n${JSON.stringify([...secretKey64(kp)])}\n`);
} else if (cmd === 'seed') {
  const each = Math.round(Number(process.argv[3]) * LAMPORTS);
  if (!(each > 0)) throw new Error('usage: seed <sol per dot>');
  const office = wallets[0][1];
  const byAddr = new Map(wallets.map(([, kp]) => [kp.address, kp]));
  const { signature } = await chain.send({ payer: office.address, transfers: wallets.slice(1).map(([, kp]) => ({ from: office.address, to: kp.address, lamports: each })), memo: 'swigglies: the office stakes the five', keyFor: a => byAddr.get(a) });
  console.log(`seeded ${wallets.length - 1} dots with ${each / LAMPORTS} SOL each: https://solscan.io/tx/${signature}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`);
} else if (cmd === 'probe') {
  const a = newKeypair(), b = newKeypair(), c = newKeypair();
  const { value: { blockhash } } = await chain.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const { message, signers } = compileMessage({ payer: a.address, transfers: [{ from: a.address, to: b.address, lamports: 1_000_000 }, { from: c.address, to: a.address, lamports: 900_000 }], memo: 'swigglies: probe', blockhash });
  const { tx } = signTransaction(message, signers, addr => [a, b, c].find(k => k.address === addr));
  const good = await chain.rpc('simulateTransaction', [tx.toString('base64'), { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]);
  console.log('well-formed, signed:', JSON.stringify(good.value.err), '(AccountNotFound = parsed and signatures verified; payer simply has no SOL)');
  const bad = Buffer.from(tx); bad[10] ^= 0xff;
  try { const r = await chain.rpc('simulateTransaction', [bad.toString('base64'), { encoding: 'base64', sigVerify: true, commitment: 'confirmed' }]); console.log('tampered signature:', JSON.stringify(r.value.err)); }
  catch (e) { console.log('tampered signature rejected:', e.message.slice(0, 120)); }
} else if (cmd === 'probe-exec') {
  // Execution check without funds: borrow two funded fee payers from the latest finalized block, build our
  // exact messages from them, and let devnet simulate with signatures skipped, reading back post balances.
  const slot = await chain.rpc('getSlot', [{ commitment: 'finalized' }]);
  const block = await chain.rpc('getBlock', [slot, { transactionDetails: 'accounts', rewards: false, maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
  const payers = [...new Set(block.transactions.map(t => t.transaction.accountKeys[0].pubkey))].slice(0, 80);
  const bals = await chain.balances(payers);
  const [w1, w2] = payers.filter((p, i) => bals[i] > 0.3 * LAMPORTS);
  if (!w2) throw new Error('no two funded fee payers in the latest block; run again');
  const [a, b, c] = [newKeypair().address, newKeypair().address, newKeypair().address];
  const { value: { blockhash } } = await chain.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const sim = async (label, payer, transfers, watch) => {
    const { message, signers } = compileMessage({ payer, transfers, memo: 'swigglies: exec probe', blockhash });
    const tx = Buffer.concat([Buffer.from([signers.length]), Buffer.alloc(64 * signers.length), message]);
    const r = await chain.rpc('simulateTransaction', [tx.toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } }]);
    const post = (r.value.accounts || []).map(x => (x ? x.lamports : 0));
    const memo = (r.value.logs || []).some(l => l.includes(`${MEMO_PROGRAM} success`));
    console.log(`${label}: err=${JSON.stringify(r.value.err)} memo_ok=${memo} post=${JSON.stringify(post)} signers=${signers.length}`);
  };
  const cu = async (label, transfers, priority) => {
    const { message, signers } = compileMessage({ payer: w1, transfers, memo: 'swigglies: epoch 123 rent roll', blockhash, priority });
    const tx = Buffer.concat([Buffer.from([signers.length]), Buffer.alloc(64 * signers.length), message]);
    const r = await chain.rpc('simulateTransaction', [tx.toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
    console.log(`${label}: err=${JSON.stringify(r.value.err)} compute units used=${r.value.unitsConsumed}`);
  };
  const fresh = () => newKeypair().address;
  await cu('compute: 1 transfer + memo', [{ from: w1, to: fresh(), lamports: 5_000_000 }], null);
  await cu('compute: 6 transfers + memo + priority fee', [1, 2, 3, 4, 5, 6].map(() => ({ from: w1, to: fresh(), lamports: 5_000_000 })), { units: 30_000, microLamports: 50_000 });
  await sim('move (2 transfers + memo)', w1, [{ from: w1, to: a, lamports: 50_000_000 }, { from: w1, to: b, lamports: 20_000_000 }], [a, b]);
  await sim('epoch shape (2 signers, both directions)', w1, [{ from: w1, to: c, lamports: 30_000_000 }, { from: w2, to: w1, lamports: 1_000_000 }], [c]);
  await sim('rent rule (1000 lamports to a new account)', w1, [{ from: w1, to: newKeypair().address, lamports: 1000 }], []);
} else if (cmd === 'who') {
  // Who has connected over MCP, what they called, and who holds each seat right now. Keys are never logged.
  const files = clusterFiles(cluster);
  const all = fs.readFileSync(path.join(stateDir, files.log), 'utf8').trim().split('\n').slice(-5000)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const rows = all.filter(r => r.kind === 'mcp-init' || r.kind === 'mcp-call');
  const refused = new Map();
  for (const r of all.filter(x => x.kind === 'mcp-denied')) {
    const d = refused.get(r.ip) || { n: 0, first: r.t, last: r.t, ua: r.ua };
    d.n++; d.last = r.t; refused.set(r.ip, d);
  }
  const when = t => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  const byClient = new Map();
  for (const r of rows) {
    const k = `${r.client} · ${r.ip || '?'}`;
    const c = byClient.get(k) || { first: r.t, last: r.t, inits: 0, calls: 0, tools: {}, seats: new Set(), agents: new Set(), ua: r.ua };
    c.last = r.t; c.seats.add(r.seat);
    if (r.kind === 'mcp-init') c.inits++; else { c.calls++; c.tools[r.tool] = (c.tools[r.tool] || 0) + 1; if (r.agent) c.agents.add(r.agent); }
    byClient.set(k, c);
  }
  console.log(byClient.size ? 'MCP clients (newest last):' : 'No MCP connections logged yet.');
  for (const [k, c] of [...byClient].sort((x, y) => x[1].last - y[1].last)) {
    console.log(`- ${k}  ${when(c.first)} → ${when(c.last)}  seat key: ${[...c.seats].join('/')}  ${c.inits} connects, ${c.calls} calls${c.agents.size ? `  plays: ${[...c.agents].join(', ')}` : ''}`);
    if (c.calls) console.log(`    tools: ${Object.entries(c.tools).map(([t, n]) => `${t}×${n}`).join(' ')}`);
    if (c.ua) console.log(`    agent string: ${c.ua}`);
  }
  console.log(refused.size ? '\nRefused (no valid key), by IP:' : '\nNo refused connection attempts.');
  for (const [ip, d] of refused) console.log(`- ${ip}  ${d.n}× (logged at most once a minute)  ${when(d.first)} → ${when(d.last)}  ${d.ua || ''}`);
  const s = JSON.parse(fs.readFileSync(path.join(stateDir, files.state), 'utf8'));
  const hold = Number(env.SEAT_HOLD_MS || 1_200_000);
  console.log('\nSeats now:');
  for (const a of s.agents) {
    const held = a.seat && Date.now() - a.seat.lastAt < hold;
    console.log(`- ${a.name.padEnd(7)} ${held ? `${a.seat.named ? 'JOINED' : 'held'} by ${a.seat.by}, last call ${Math.round((Date.now() - a.seat.lastAt) / 60000)} min ago` : 'autopilot'}`);
  }
} else if (cmd === 'autosign') {
  // The operator's switch for the auto-signer's guard (guard.mjs): off stops every signature at once.
  const off = path.join(stateDir, 'AUTOSIGN_OFF');
  const sub = process.argv[3] || 'status';
  if (sub === 'off') fs.writeFileSync(off, new Date().toISOString());
  else if (sub === 'on') fs.rmSync(off, { force: true });
  else if (sub !== 'status') throw new Error('usage: autosign on | off | status');
  const { GENESIS } = await import('./guard.mjs');
  let net = 'unchecked';
  try { const g = await chain.rpc('getGenesisHash', []); net = g === GENESIS[cluster] ? `verified ${cluster}` : `WRONG NETWORK (genesis ${g})`; } catch (e) { net = `unreachable: ${e.message}`; }
  const audit = path.join(stateDir, 'signing-audit.jsonl');
  const today = new Date().toISOString().slice(0, 10);
  const rows = fs.existsSync(audit) ? fs.readFileSync(audit, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => new Date(r.t).toISOString().startsWith(today)) : [];
  console.log(`auto-signing: ${fs.existsSync(off) ? 'OFF' : 'on'} · cluster ${cluster} · RPC ${net}`);
  console.log(`daily ceiling per wallet: ${env.AUTOSIGN_DAILY_SOL ? `${env.AUTOSIGN_DAILY_SOL} SOL` : cluster === 'mainnet-beta' ? 'NOT SET: mainnet signing is refused until AUTOSIGN_DAILY_SOL is set' : 'none (devnet)'}`);
  console.log(`today: ${rows.filter(r => r.ok).length} signed, ${rows.filter(r => !r.ok).length} refused${rows.some(r => !r.ok) ? ` (last refusal: ${rows.filter(r => !r.ok).at(-1).why})` : ''}`);
} else if (cmd === 'sweep') {
  // Recover everything at the end of a run: each of the six wallets sends its whole balance, minus its own
  // fee, to the given address, closing the account to zero. Root-only (needs SWIGGLIES_KEY and the key files).
  const to = process.argv[3];
  if (!isAddress(to) || process.argv[4] !== '--yes') throw new Error('usage: sweep <destination address> --yes   (stop the service first)');
  const bals = await chain.balances(wallets.map(([, kp]) => kp.address));
  const byAddr = new Map(wallets.map(([, kp]) => [kp.address, kp]));
  const scanTx = sig => `https://solscan.io/tx/${sig}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;
  let total = 0;
  for (const [i, [name, kp]] of wallets.entries()) {
    const send = bals[i] - moveFee;
    if (send <= 0 || kp.address === to) { console.log(`${name}: nothing to sweep`); continue; }
    try {
      const { signature } = await chain.send({ payer: kp.address, transfers: [{ from: kp.address, to, lamports: send }], memo: `swigglies: sweep ${name} at the end of a run`, keyFor: a => byAddr.get(a) });
      total += send;
      console.log(`${name}: ${(send / LAMPORTS).toFixed(6)} SOL → ${to}  ${scanTx(signature)}`);
    } catch (e) { console.log(`${name}: sweep failed: ${e.message}`); }
  }
  console.log(`swept ${(total / LAMPORTS).toFixed(6)} SOL in all`);
} else if (cmd === 'rotate-seats') {
  // New house key + five seat keys; the old ones stop working after the service restarts.
  const { makeSeats } = await import('./mcp.mjs');
  const file = path.join(stateDir, 'seats.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(makeSeats(), null, 1), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  console.log('new seat keys written. Now: restart the server, then read them with: tools.mjs seats');
} else {
  console.log('usage: node tools.mjs addresses | airdrop [sol] | seats | rotate-seats | who | export-keys | seed <sol> | autosign on|off|status | sweep <address> --yes | probe | probe-exec');
}

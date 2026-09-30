// node test/run.mjs — wallet bytes, the rules, a long autopilot season on the in-process chain
// (lamports conserved to the fee), and the MCP door.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as S from '../solana.mjs';
import * as E from '../economy.mjs';
import { Hood } from '../hood.mjs';
import { ROSTER } from '../roster.mjs';
import { createMcp, makeSeats, standingsText, standingsJson } from '../mcp.mjs';
import { openKeystore } from '../keystore.mjs';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok ${passed} - ${name}`); };

await test('base58 round-trips and knows the system program', () => {
  for (let i = 0; i < 200; i++) {
    const b = crypto.randomBytes(i % 40);
    if (i % 7 === 0 && b.length) b[0] = 0;
    assert.deepEqual(S.b58decode(S.b58encode(b)), b);
  }
  assert.equal(S.b58encode(Buffer.alloc(32)), S.SYSTEM_PROGRAM);
  assert.equal(S.b58decode(S.MEMO_PROGRAM).length, 32);
});

await test('ed25519 matches RFC 8032 test 1', () => {
  const kp = S.keypairFromSeed(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
  assert.equal(kp.publicKey.toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const sig = crypto.sign(null, Buffer.alloc(0), kp.privateKey).toString('hex');
  assert.equal(sig, 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
  assert.ok(S.verify(kp.address, Buffer.alloc(0), Buffer.from(sig, 'hex')));
});

await test('legacy message layout: header, key order, transfer and memo bytes', () => {
  const [a, b, c] = [S.newKeypair(), S.newKeypair(), S.newKeypair()];
  const blockhash = S.b58encode(crypto.randomBytes(32));
  const { message, signers, accounts } = S.compileMessage({ payer: a.address, transfers: [{ from: a.address, to: b.address, lamports: 1234567 }, { from: c.address, to: a.address, lamports: 42 }], memo: 'swigglies: hi', blockhash });
  assert.deepEqual(signers, [a.address, c.address]);
  assert.deepEqual(accounts, [a.address, c.address, b.address, S.SYSTEM_PROGRAM, S.MEMO_PROGRAM]);
  assert.deepEqual([...message.subarray(0, 3)], [2, 0, 2]);
  assert.equal(message[3], 5);
  let o = 4 + 5 * 32;
  assert.equal(S.b58encode(message.subarray(o, o + 32)), blockhash); o += 32;
  assert.equal(message[o++], 3);
  assert.deepEqual([...message.subarray(o, o + 5)], [3, 2, 0, 2, 12]); o += 5;
  assert.equal(message.readUInt32LE(o), 2);
  assert.equal(message.readBigUInt64LE(o + 4), 1234567n); o += 12;
  assert.deepEqual([...message.subarray(o, o + 5)], [3, 2, 1, 0, 12]); o += 17;
  assert.deepEqual([...message.subarray(o, o + 3)], [4, 0, 13]);
  assert.equal(message.subarray(o + 3).toString(), 'swigglies: hi');
  const keyFor = addr => [a, b, c].find(k => k.address === addr);
  const { tx, signature } = S.signTransaction(message, signers, keyFor);
  assert.equal(tx[0], 2);
  assert.ok(S.verify(c.address, message, tx.subarray(65, 129)));
  assert.equal(S.b58decode(signature).length, 64);
});

await test('mainnet priority fee: ComputeBudget limit + price go first, byte-exact', () => {
  const [a, b] = [S.newKeypair(), S.newKeypair()];
  const blockhash = S.b58encode(crypto.randomBytes(32));
  const { message, accounts } = S.compileMessage({ payer: a.address, transfers: [{ from: a.address, to: b.address, lamports: 7 }], memo: 'm', blockhash, priority: { units: 30_000, microLamports: 50_000 } });
  assert.deepEqual(accounts, [a.address, b.address, S.SYSTEM_PROGRAM, S.MEMO_PROGRAM, S.COMPUTE_BUDGET_PROGRAM]);
  assert.deepEqual([...message.subarray(0, 3)], [1, 0, 3]);
  let o = 4 + 5 * 32 + 32;
  assert.equal(message[o++], 4, 'limit, price, transfer, memo');
  assert.deepEqual([...message.subarray(o, o + 3)], [4, 0, 5]); o += 3;
  assert.equal(message[o], 2); assert.equal(message.readUInt32LE(o + 1), 30_000); o += 5;
  assert.deepEqual([...message.subarray(o, o + 3)], [4, 0, 9]); o += 3;
  assert.equal(message[o], 3); assert.equal(message.readBigUInt64LE(o + 1), 50_000n); o += 9;
  assert.equal(message[o], 2, 'then the System transfer');
  assert.equal(S.clusterFiles('mainnet-beta').state, 'state-mainnet.json');
  assert.equal(S.clusterFiles('devnet').state, 'state.json');
});

await test('keystore seals seeds and reopens the same wallet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-keys-'));
  const master = crypto.randomBytes(32).toString('hex');
  const k1 = openKeystore(dir, master).wallet('pip');
  const k2 = openKeystore(dir, master).wallet('pip');
  assert.equal(k1.address, k2.address);
  assert.ok(!fs.readFileSync(path.join(dir, 'pip.json'), 'utf8').includes(k1.seed.toString('hex')));
  assert.throws(() => openKeystore(dir, crypto.randomBytes(32).toString('hex')).wallet('pip'));
});

await test('sim chain enforces fees and the rent floor', async () => {
  const ch = new S.SimChain();
  const [a, b] = [S.newKeypair(), S.newKeypair()];
  const keyFor = addr => [a, b].find(k => k.address === addr);
  ch.fund(a.address, S.LAMPORTS);
  await assert.rejects(ch.send({ payer: a.address, transfers: [{ from: a.address, to: b.address, lamports: 1000 }], keyFor }), /rent/);
  await ch.send({ payer: a.address, transfers: [{ from: a.address, to: b.address, lamports: S.RENT_MIN }], memo: 'x', keyFor });
  assert.deepEqual(await ch.balances([a.address, b.address]), [S.LAMPORTS - S.RENT_MIN - S.SIG_FEE, S.RENT_MIN]);
});

function makeHood({ funds = S.LAMPORTS, seed = 7 } = {}) {
  const chain = new S.SimChain();
  const office = { kp: S.newKeypair() };
  const agents = ROSTER.map(r => ({ r, kp: S.newKeypair() }));
  chain.fund(office.kp.address, funds / 5);
  agents.forEach(w => chain.fund(w.kp.address, funds));
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const hood = new Hood({ chain, office, agents, unit: 10_000_000, cluster: 'sim', rnd });
  return { hood, chain, office, agents };
}

await test('the rules: land, build, list, buy, and buyout only downward', async () => {
  const { hood } = makeHood();
  await hood.run(() => hood.refresh());
  const s = hood.s;
  const r1 = await hood.act('pip', { type: 'buy_lot', lot: 'A1' });
  assert.ok(r1.ok, r1.error);
  assert.equal(s.lots[0].owner, 'pip');
  assert.equal(s.office.lotsSold, 1);
  assert.match((await hood.act('lark', { type: 'buy_lot', lot: 'A1' })).error, /not the office's/);
  assert.match((await hood.act('pip', { type: 'buy_lot', lot: 'D4' })).error, /not for sale/);
  assert.match((await hood.act('pip', { type: 'build', lot: 'A1', kind: 'shop' })).error, /crates/);
  assert.ok((await hood.act('pip', { type: 'build', lot: 'A1', kind: 'house' })).ok);
  assert.ok((await hood.act('pip', { type: 'list', lot: 'A1', price_sol: 0.05 })).ok);
  const L = s.listings[0];
  assert.match((await hood.act('pip', { type: 'buy', listing: L.id })).error, /own listing/);
  const larkBefore = E.agentOf(s, 'lark').balance, pipBefore = E.agentOf(s, 'pip').balance;
  assert.ok((await hood.act('lark', { type: 'buy', listing: L.id })).ok);
  assert.equal(s.lots[0].owner, 'lark');
  assert.equal(E.agentOf(s, 'pip').balance - pipBefore, 0.05 * S.LAMPORTS);
  assert.equal(larkBefore - E.agentOf(s, 'lark').balance, 0.05 * S.LAMPORTS + S.SIG_FEE);
  // Lark spent more than Marrow, so Lark cannot buy Marrow out, but Marrow can buy Lark out.
  assert.ok((await hood.act('marrow', { type: 'buy_lot', lot: 'B1' })).ok);
  assert.match((await hood.act('lark', { type: 'buyout', target: 'marrow' })).error, /less SOL/);
  const price = Math.ceil(E.estate(s, 'lark') * E.RULES.buyoutPremium);
  const rich = E.agentOf(s, 'brine');
  const larkCash = E.agentOf(s, 'lark').balance;
  const r2 = await hood.act('brine', { type: 'buyout', target: 'lark' });
  assert.ok(r2.ok, r2.error);
  assert.equal(s.lots[0].owner, 'brine');
  assert.equal(E.agentOf(s, 'lark').balance - larkCash, price);
  assert.equal(rich.shieldUntil, s.epoch + E.RULES.shieldEpochs);
  assert.match((await hood.act('marrow', { type: 'buyout', target: 'brine' })).error, /shielded|less SOL/);
});

await test('foreclosure: a dot that cannot cover upkeep loses everything to the office table', async () => {
  const { hood } = makeHood();
  await hood.run(() => hood.refresh());
  const s = hood.s, pip = E.agentOf(s, 'pip');
  assert.ok((await hood.act('pip', { type: 'buy_lot', lot: 'A1' })).ok);
  assert.ok((await hood.act('pip', { type: 'build', lot: 'A1', kind: 'house' })).ok);
  // drain Pip down to the reserve by sending it to Soot outside the rules
  const spare = pip.balance - E.RESERVE - S.SIG_FEE;
  await hood.chain.send({ payer: pip.address, transfers: [{ from: pip.address, to: E.agentOf(s, 'soot').address, lamports: spare }], keyFor: a => hood.keyByAddress.get(a) });
  s.office.balance = 0; // no rent roll this epoch
  hood.chain.bal.set(s.office.address, E.RESERVE);
  await hood.settle();
  assert.equal(pip.status, 'broke');
  assert.equal(s.lots[0].owner, null);
  assert.ok(s.lots[0].foreclosed);
  const L = s.listings.find(x => x.lot === 0);
  assert.ok(L.foreclosure && L.seller === 'office');
  const p0 = L.price;
  await hood.settle();
  assert.ok(L.price < p0, 'foreclosure price drops each epoch');
  assert.ok((await hood.act('brine', { type: 'buy', listing: L.id })).ok);
  assert.equal(s.lots[0].owner, 'brine');
  assert.equal(s.lots[0].build.kind, 'house');
});

await test('a long season on autopilot: SOL is conserved to the fee and everything happens', async () => {
  const { hood, chain, office, agents } = makeHood({ seed: 11 });
  const all = [office, ...agents].map(w => w.kp.address);
  const total0 = (await chain.balances(all)).reduce((x, y) => x + y, 0);
  await hood.run(() => hood.refresh());
  const kinds = {};
  hood.on('change', ({ feed }) => feed.forEach(f => { kinds[f.kind] = (kinds[f.kind] || 0) + 1; }));
  for (let e = 0; e < 400; e++) {
    for (let t = 0; t < 10; t++) await hood.autopilotStep();
    await hood.settle();
  }
  const total1 = (await chain.balances(all)).reduce((x, y) => x + y, 0);
  assert.equal(total0 - total1, chain.fees, 'only network fees leave the hood');
  const s = hood.s;
  for (const a of s.agents) assert.equal(a.balance, chain.bal.get(a.address) || 0);
  for (const L of s.listings) if (L.lot != null) assert.ok(L.seller === 'office' ? s.lots[L.lot].owner == null : s.lots[L.lot].owner === L.seller, `listing ${L.id} matches its lot`);
  const summary = Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(`   season: ${chain.count} txs, fees ${chain.fees} lamports; ${summary}`);
  console.log(`   end: ${s.agents.map(a => `${a.name} ${(a.balance / 1e9).toFixed(3)} SOL + ${(E.estate(s, a.id) / 1e9).toFixed(3)} estate ${a.status}`).join(' | ')}; office ${(s.office.balance / 1e9).toFixed(3)}; lots owned ${s.lots.filter(l => l.owner && l.owner !== 'office').length}/48`);
  for (const k of ['buy_lot', 'build', 'upgrade', 'buy', 'buyout', 'epoch']) assert.ok(kinds[k] > 0, `saw ${k}`);
});

await test('first funding: the office stakes the five once and scales the unit', async () => {
  const chain = new S.SimChain();
  const office = { kp: S.newKeypair() };
  const agents = ROSTER.map(r => ({ r, kp: S.newKeypair() }));
  chain.fund(office.kp.address, 5 * S.LAMPORTS);
  const hood = new Hood({ chain, office, agents, unit: 10_000_000, cluster: 'sim' });
  await hood.run(() => hood.refresh());
  assert.equal(await hood.run(() => hood.stakeIfReady()), true);
  const each = hood.s.agents[0].balance;
  assert.ok(hood.s.agents.every(a => a.balance === each) && each > 0.79 * S.LAMPORTS);
  assert.equal(hood.s.unit, Math.max(1_000_000, Math.round(each / 100 / 10_000) * 10_000));
  assert.equal(await hood.run(() => hood.stakeIfReady()), false);
  assert.match(hood.s.feed.at(-1).text, /staked the five/);
  assert.ok((await hood.act('pip', { type: 'buy_lot', lot: 'A1' })).ok);
});

await test('MCP: closed to anyone without a key; the owner\'s keys look, join and act', async () => {
  const { hood } = makeHood();
  await hood.run(() => hood.refresh());
  const seats = makeSeats();
  const handle = createMcp({ hood, seats });
  const call = async (msg, q = '', headers = {}) => {
    let status = 0, out = '', hdrs = {};
    const res = { setHeader: (k, v) => { hdrs[k.toLowerCase()] = v; }, writeHead: (c, h = {}) => { status = c; Object.assign(hdrs, h); }, end: b => { out = b || ''; } };
    await handle({ method: 'POST', headers }, res, new URL(`http://x/mcp${q}`), JSON.stringify(msg));
    return { status, body: out ? JSON.parse(out) : null, hdrs };
  };
  // no key, or a wrong key: nothing at all, not even initialize or a look
  for (const [q, headers] of [['', {}], ['?seat=dh_notakey', {}], ['', { authorization: 'Bearer dh_nope' }]]) {
    const denied = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'stranger' } } }, q, headers);
    assert.equal(denied.status, 403);
    assert.match(denied.body.error.message, /closed experiment/);
  }
  assert.equal((await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'hood_look', arguments: {} } })).status, 403);
  const key = { authorization: `Bearer ${seats.house}` };
  const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test-dot' } } }, '', key);
  assert.equal(init.body.result.serverInfo.name, 'swigglies');
  const sid = init.hdrs['mcp-session-id'];
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, '', key)).status, 202);
  const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, '', key);
  assert.ok(list.body.result.tools.length >= 12);
  const look = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hood_look', arguments: {} } }, '', key);
  assert.match(look.body.result.content[0].text, /THE FIVE/);
  const noAgent = await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hood_buy_lot', arguments: { lot: 'C3' } } }, '', key);
  assert.match(noAgent.body.result.content[0].text, /pass agent/);
  // the one shared link proposes for the dot it names, and the proposal is recorded under that dot
  const viaLink = await call({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'hood_buy_lot', arguments: { lot: 'E5', agent: 'lark' } } }, '', key);
  assert.equal(viaLink.body.result.structuredContent.proposal.seat, 'lark');
  assert.equal(viaLink.body.result.structuredContent.proposal.status, 'pending');
  const wrong = await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hood_buy_lot', arguments: { lot: 'C3', agent: 'pip' } } }, `?seat=${seats.soot}`);
  assert.match(wrong.body.result.content[0].text, /soot's/);
  const ok = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'hood_buy_lot', arguments: { lot: 'C3' } } }, '', { authorization: `Bearer ${seats.soot}`, 'mcp-session-id': sid });
  assert.ok(!ok.body.result.isError, ok.body.result.content[0].text);
  assert.equal(ok.body.result.structuredContent.proposal.status, 'pending', 'a player only proposes');
  assert.equal(hood.s.lots[E.parseLot('C3')].owner, null, 'nothing executes until the owner does');
  assert.equal(E.agentOf(hood.s, 'soot').seat.by, 'test-dot');
  const house = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hood_me', arguments: { agent: 'lark' } } }, `?seat=${seats.house}`);
  assert.match(house.body.result.content[0].text, /^Lark/);
  // lot inspector, read-only
  const lot = await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'hood_lot', arguments: { lot: 'e4' } } }, '', key);
  assert.match(lot.body.result.content[0].text, /^Lot E4: owned by nobody\. Bare\. Appraisal .* the office sells it for/);
  const office = await call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'hood_lot', arguments: { lot: 'D4' } } }, '', key);
  assert.match(office.body.result.content[0].text, /^D4 is the office/);
  // hood_join: the player names itself, is handed its wallet, and keeps that name on later calls in the session
  const h = { authorization: `Bearer ${seats.brine}`, 'mcp-session-id': sid };
  const join = await call({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'hood_join', arguments: { agent: 'brine', name: 'Brine' } } }, '', h);
  const brine = E.agentOf(hood.s, 'brine');
  assert.ok(!join.body.result.isError);
  assert.match(join.body.result.content[0].text, new RegExp(`^You are Brine .*\\nYour wallet: ${brine.address}`));
  assert.equal(brine.seat.by, 'Brine');
  assert.match(hood.s.feed.at(-1).text, /^Brine took its seat\. Wallet /);
  await call({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'hood_me', arguments: { agent: 'brine' } } }, '', h);
  assert.equal(brine.seat.by, 'Brine', 'the joined name sticks');
  const feedLen = hood.s.feed.length;
  await call({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'hood_join', arguments: { agent: 'brine', name: 'Brine' } } }, '', h);
  assert.equal(hood.s.feed.length, feedLen, 'joining again under the same name is quiet');
});

await test('spectator standings: read-only text and JSON, ranked by net worth, no keys', async () => {
  const { hood } = makeHood();
  await hood.run(() => hood.refresh());
  assert.ok((await hood.act('pip', { type: 'buy_lot', lot: 'A1' })).ok);
  const p = { ...E.publicState(hood.s), seatHoldMs: 1_200_000 };
  const j = standingsJson(p);
  assert.equal(j.dots.length, 5);
  assert.ok(j.dots.every((d, i) => i === 0 || j.dots[i - 1].net_sol >= d.net_sol));
  assert.ok(j.funded && j.last_moves[0].text.includes('Pip bought A1'));
  const t = standingsText(p, 'https://example.test/swigglies/');
  assert.match(t, /Swigglies standings/);
  assert.match(t, /Watch: https:\/\/example\.test\/swigglies\//);
  assert.ok(!/dh_|seed|DOTHOOD_KEY/.test(JSON.stringify(j) + t), 'no secrets in standings');
});

await test('fixed stake: 1 SOL a dot once the office can cover it; the office keeps the rest', async () => {
  const setup = officeSol => {
    const chain = new S.SimChain();
    const office = { kp: S.newKeypair() };
    const agents = ROSTER.map(r => ({ r, kp: S.newKeypair() }));
    chain.fund(office.kp.address, officeSol * S.LAMPORTS);
    let x = 5; const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    return { chain, office, agents, hood: new Hood({ chain, office, agents, unit: 10_000_000, cluster: 'sim', stakeLamports: S.LAMPORTS, rnd }) };
  };
  const low = setup(2);
  await low.hood.run(() => low.hood.refresh());
  assert.equal(await low.hood.run(() => low.hood.stakeIfReady()), false, 'waits while the office cannot cover the stake');
  const five = setup(5);
  await five.hood.run(() => five.hood.refresh());
  assert.equal(await five.hood.run(() => five.hood.stakeIfReady()), true);
  const each5 = five.hood.s.agents[0].balance;
  assert.ok(each5 > 0.98 * S.LAMPORTS && each5 < S.LAMPORTS, `5 SOL in the office gives just under 1 SOL a dot (${each5})`);
  const ten = setup(10);
  await ten.hood.run(() => ten.hood.refresh());
  assert.equal(await ten.hood.run(() => ten.hood.stakeIfReady()), true);
  assert.ok(ten.hood.s.agents.every(a => a.balance === S.LAMPORTS), 'exactly 1 SOL each');
  assert.ok(ten.hood.s.office.balance > 4.99 * S.LAMPORTS, 'the office keeps the other ~5 SOL');
  assert.equal(ten.hood.s.unit, 10_000_000);
  // a season with a rich office still has buyouts and upkeep pressure, and conserves SOL to the fee
  const all = [ten.office, ...ten.agents].map(w => w.kp.address);
  const before = (await ten.chain.balances(all)).reduce((a, b) => a + b, 0) + ten.chain.fees;
  const kinds = {};
  ten.hood.on('change', ({ feed }) => feed.forEach(f => { kinds[f.kind] = (kinds[f.kind] || 0) + 1; }));
  for (let e = 0; e < 200; e++) { for (let t = 0; t < 10; t++) await ten.hood.autopilotStep(); await ten.hood.settle(); }
  const after = (await ten.chain.balances(all)).reduce((a, b) => a + b, 0) + ten.chain.fees;
  assert.equal(after, before);
  console.log(`   rich-office season (200 epochs): ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  assert.ok(kinds.buy_lot > 0 && kinds.build > 0 && kinds.epoch > 0);
});

await test('daily transaction cap per wallet; the office is exempt', async () => {
  const chain = new S.SimChain();
  const office = { kp: S.newKeypair() };
  const agents = ROSTER.map(r => ({ r, kp: S.newKeypair() }));
  [office, ...agents].forEach(w => chain.fund(w.kp.address, S.LAMPORTS));
  const hood = new Hood({ chain, office, agents, unit: 10_000_000, cluster: 'sim', maxTxPerDay: 2 });
  await hood.run(() => hood.refresh());
  assert.ok((await hood.act('pip', { type: 'buy_lot', lot: 'A1' })).ok);
  assert.ok((await hood.act('pip', { type: 'buy_lot', lot: 'B1' })).ok);
  assert.match((await hood.act('pip', { type: 'buy_lot', lot: 'C1' })).error, /2 on-chain moves for today/);
  assert.ok((await hood.act('pip', { type: 'walk', lot: 'C1' })).ok, 'free moves still work');
  assert.ok((await hood.act('lark', { type: 'buy_lot', lot: 'C1' })).ok, 'other wallets unaffected');
});

await test('MCP pace: 20 tool calls a minute on a seat key, then 429', async () => {
  const { hood } = makeHood();
  await hood.run(() => hood.refresh());
  const seats = makeSeats();
  const handle = createMcp({ hood, seats });
  let last = 0;
  for (let n = 1; n <= 21; n++) {
    const res = { setHeader() {}, writeHead(c) { last = c; }, end() {} };
    await handle({ method: 'POST', headers: { authorization: `Bearer ${seats.lark}` } }, res, new URL('http://x/mcp'), JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name: 'hood_look', arguments: {} } }));
    if (n <= 20) assert.equal(last, 200, `call ${n}`);
  }
  assert.equal(last, 429);
});

await test('ledger: every on-chain move is kept and rebuilt from the event log after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-ledger-'));
  const chain = new S.SimChain();
  const office = { kp: S.newKeypair() };
  const agents = ROSTER.map(r => ({ r, kp: S.newKeypair() }));
  [office, ...agents].forEach(w => chain.fund(w.kp.address, S.LAMPORTS));
  const opts = { chain, office, agents, unit: 10_000_000, cluster: 'sim', stateFile: path.join(dir, 'state.json'), logFile: path.join(dir, 'events.jsonl') };
  const hood = new Hood(opts);
  await hood.run(() => hood.refresh());
  await hood.act('pip', { type: 'buy_lot', lot: 'A1' });
  await hood.act('pip', { type: 'walk', lot: 'B2' });
  await hood.act('lark', { type: 'buy_lot', lot: 'B1' });
  assert.equal(hood.ledger.length, 2, 'walks are not on chain');
  assert.ok(hood.ledger.every(r => r.sig && r.text && Number.isInteger(r.epoch)));
  const again = new Hood(opts);
  assert.deepEqual(again.ledger.map(r => r.sig), hood.ledger.map(r => r.sig));
});

await test('auto-signer guard: only hood wallets, daily ceiling, off switch, pinned network, audit', async () => {
  const { guardChain, GENESIS } = await import('../guard.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-guard-'));
  const raw = new S.SimChain();
  const six = [S.newKeypair(), S.newKeypair(), S.newKeypair(), S.newKeypair(), S.newKeypair(), S.newKeypair()];
  const outsider = S.newKeypair();
  six.forEach(k => raw.fund(k.address, S.LAMPORTS));
  const keyFor = a => [...six, outsider].find(k => k.address === a);
  const g = guardChain(raw, { wallets: six.map(k => k.address), cluster: 'sim', stateDir: dir, dailyCapLamports: 0.3 * S.LAMPORTS });
  const [a, b] = six;
  const pay = (to, lamports, memo = 'swigglies: test') => g.send({ payer: a.address, transfers: [{ from: a.address, to, lamports }], memo, keyFor });
  assert.ok((await pay(b.address, 0.2 * S.LAMPORTS)).signature);
  await assert.rejects(pay(outsider.address, 1_000_000), /outside the six hood wallets/);
  await assert.rejects(pay(b.address, 1_000_000, 'not ours'), /no swigglies memo/);
  await assert.rejects(pay(b.address, 0.2 * S.LAMPORTS), /daily ceiling/);
  assert.equal(g.remainingToday(a.address), 0.1 * S.LAMPORTS);
  fs.writeFileSync(path.join(dir, 'AUTOSIGN_OFF'), '');
  await assert.rejects(pay(b.address, 1_000_000), /switched off/);
  fs.rmSync(path.join(dir, 'AUTOSIGN_OFF'));
  assert.ok((await pay(b.address, 1_000_000)).signature, 'back on');
  assert.equal(raw.bal.get(outsider.address) || 0, 0, 'nothing ever reached the outsider');
  const audit = fs.readFileSync(path.join(dir, 'signing-audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(audit.filter(r => r.ok).length, 2);
  assert.equal(audit.filter(r => !r.ok).length, 4);
  // mainnet: no ceiling, no signature; wrong network: no signature
  const main = guardChain(raw, { wallets: six.map(k => k.address), cluster: 'mainnet-beta' });
  await assert.rejects(main.send({ payer: a.address, transfers: [{ from: a.address, to: b.address, lamports: 1_000_000 }], memo: 'swigglies: x', keyFor }), /daily ceiling/);
  const liar = { cluster: 'devnet', rpc: async () => GENESIS['mainnet-beta'], send: async () => { throw new Error('must not be reached'); }, balances: async () => [] };
  const pinned = guardChain(liar, { wallets: six.map(k => k.address), cluster: 'devnet' });
  await assert.rejects(pinned.send({ payer: a.address, transfers: [{ from: a.address, to: b.address, lamports: 1 }], memo: 'swigglies: x', keyFor }), /RPC is not devnet/);
});

await test('hood_preview: exact debit and counterparties, the guard\'s verdict, and the state untouched', async () => {
  const { hood } = makeHood();
  await hood.run(() => hood.refresh());
  const seats = makeSeats();
  const handle = createMcp({ hood, seats });
  const call = async args => {
    let out = '';
    const res = { setHeader() {}, writeHead() {}, end(b) { out = b; } };
    await handle({ method: 'POST', headers: { authorization: `Bearer ${seats.house}` } }, res, new URL('http://x/mcp'), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hood_preview', arguments: args } }));
    return JSON.parse(out).result;
  };
  const before = JSON.stringify(hood.s.lots) + hood.s.office.lotsSold;
  const r = await call({ agent: 'pip', action: 'hood_buy_lot', lot: 'C4' });
  assert.equal(r.structuredContent.would_sign, true);
  assert.equal(r.structuredContent.transfers.length, 1);
  assert.equal(r.structuredContent.transfers[0].to_name, 'the office');
  assert.equal(r.structuredContent.transfers[0].lamports, E.lotPrice(hood.s));
  assert.match(r.content[0].text, /^Pip would pay .* to the office/);
  assert.equal(JSON.stringify(hood.s.lots) + hood.s.office.lotsSold, before, 'nothing changed');
  const no = await call({ agent: 'pip', action: 'hood_buy_lot', lot: 'D4' });
  assert.equal(no.structuredContent.would_sign, false);
  const free = await call({ agent: 'pip', action: 'hood_walk', lot: 'A1' });
  assert.equal(free.structuredContent.on_chain, false);
});

await test('separate signer: the game server holds no keys; plans cross a socket and are guarded there', async () => {
  const { createSigner, serveSigner, walletName } = await import('../signer.mjs');
  const { RemoteSigner, SplitChain } = await import('../signer-client.mjs');
  const raw = new S.SimChain();
  const office = S.newKeypair();
  const agents = ROSTER.map(r => ({ id: r.id, kp: S.newKeypair() }));
  [office, ...agents.map(a => a.kp)].forEach(k => raw.fund(k.address, S.LAMPORTS));
  const sock = path.join(os.tmpdir(), `dh-signer-${process.pid}.sock`);
  const server = await serveSigner(createSigner({ chain: raw, office, agents, cluster: 'sim' }), sock);
  const remote = new RemoteSigner(sock);
  const addrs = await remote.addresses();
  assert.equal(addrs.office, office.address);
  const chain = new SplitChain({ reader: raw, signer: remote, cluster: 'sim' });
  const hood = new Hood({ chain, office: { kp: { address: addrs.office } }, agents: ROSTER.map(r => ({ r, kp: { address: addrs.agents[r.id] } })), unit: 10_000_000, cluster: 'sim' });
  assert.ok([...hood.keyByAddress.values()].every(k => !k.privateKey && !k.seed), 'no private key in the game server');
  await hood.run(() => hood.refresh());
  const r = await hood.act('pip', { type: 'buy_lot', lot: 'A1' });
  assert.ok(r.ok, r.error);
  assert.equal(hood.s.lots[0].owner, 'pip');
  await assert.rejects(chain.send({ payer: addrs.office, transfers: [{ from: addrs.office, to: S.newKeypair().address, lamports: 1_000_000 }], memo: 'swigglies: x' }), e => e.guard && /outside the six/.test(e.message));
  assert.equal((await chain.check({ payer: addrs.office, transfers: [{ from: addrs.office, to: addrs.agents.pip, lamports: 1 }], memo: 'swigglies: ok' })).ok, true);
  assert.equal(walletName('mainnet-beta', 'office'), 'mainnet-office');
  assert.equal(walletName('devnet', 'office'), 'office');
  server.close();
});

await test('pending-proposal boundary: player tools only propose; only the owner, locally, executes the exact proposal', async () => {
  const { createOwnerApi } = await import('../owner.mjs');
  const { hood, chain } = makeHood();
  await hood.run(() => hood.refresh());
  const seats = makeSeats();
  const mcp = createMcp({ hood, seats });
  const ownerKey = 'dho_test-owner-key-000000000000000';
  const owner = createOwnerApi({ hood, ownerKey });
  const tool = async (name, args, key = seats.house) => {
    let out = '';
    await mcp({ method: 'POST', headers: { authorization: `Bearer ${key}` } }, { setHeader() {}, writeHead() {}, end(b) { out = b; } }, new URL('http://x/mcp'), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    return JSON.parse(out).result;
  };
  const ownerCall = async (method, pathname, body, { key = ownerKey, ip = '127.0.0.1', xff = null } = {}) => {
    let status = 0, out = '';
    const headers = { authorization: `Bearer ${key}`, ...(xff ? { 'x-forwarded-for': xff } : {}) };
    await owner({ method, headers, socket: { remoteAddress: ip }, on() {} }, { writeHead(c) { status = c; }, end(b) { out = b; }, write() {} }, new URL(`http://x${pathname}`), body ? JSON.stringify(body) : '');
    return { status, body: out ? JSON.parse(out) : null };
  };
  const txs0 = chain.count, lots0 = JSON.stringify(hood.s.lots);
  // a money tool only proposes
  const r1 = await tool('hood_buy_lot', { lot: 'C4' }, seats.pip);
  const r2 = await tool('hood_buy_lot', { lot: 'C5' }, seats.lark);
  assert.equal(r1.structuredContent.proposal.status, 'pending');
  assert.equal(r2.structuredContent.proposal.status, 'pending');
  assert.match(r1.content[0].text, /PENDING[\s\S]*Nothing has been signed/);
  assert.equal(chain.count, txs0, 'no transaction was sent');
  assert.equal(JSON.stringify(hood.s.lots), lots0, 'the board did not change');
  // no player tool can execute or approve
  const names = await new Promise(resolve => mcp({ method: 'POST', headers: { authorization: `Bearer ${seats.house}` } }, { setHeader() {}, writeHead() {}, end(b) { resolve(JSON.parse(b).result.tools.map(t => t.name)); } }, new URL('http://x/mcp'), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })));
  assert.ok(!names.some(n => /approve|execute|sign|accept/.test(n)), `no approval tool in ${names}`);
  // the owner endpoints refuse: through the website proxy, with a player's key, with a wrong key, from elsewhere
  assert.equal((await ownerCall('POST', '/owner-api/approve', { id: 1 }, { xff: '203.0.113.9' })).status, 403);
  assert.equal((await ownerCall('POST', '/owner-api/approve', { id: 1 }, { key: seats.house })).status, 403);
  assert.equal((await ownerCall('POST', '/owner-api/approve', { id: 1 }, { key: 'dho_wrong-key-00000000000000000000' })).status, 403);
  assert.equal((await ownerCall('POST', '/owner-api/approve', { id: 1 }, { ip: '10.0.0.5' })).status, 403);
  assert.equal(chain.count, txs0, 'still nothing sent');
  // the owner sees both, re-checked; executes #1 exactly
  const list = await ownerCall('GET', '/owner-api/proposals');
  assert.equal(list.body.pending.length, 2);
  assert.ok(list.body.pending.every(x => x.check.ok));
  const ex = await ownerCall('POST', '/owner-api/approve', { id: r1.structuredContent.proposal.id, proposalHash: r1.structuredContent.proposal.proposal_hash, transactionHash: r1.structuredContent.proposal.transaction_hash });
  assert.equal(ex.body.ok, true);
  assert.equal(chain.count, txs0 + 1);
  assert.equal(hood.s.lots[E.parseLot('C4')].owner, 'pip');
  const after = await tool('hood_proposal', { id: r1.structuredContent.proposal.id });
  assert.equal(after.structuredContent.proposal.status, 'executed');
  // #2 was priced before #1 raised the land price: it must go stale, not execute at a new price
  const st = await ownerCall('POST', '/owner-api/approve', { id: r2.structuredContent.proposal.id, proposalHash: r2.structuredContent.proposal.proposal_hash, transactionHash: r2.structuredContent.proposal.transaction_hash });
  assert.equal(st.body.ok, false);
  assert.match(st.body.error, /stale/);
  assert.equal(hood.s.lots[E.parseLot('C5')].owner, null);
  assert.equal(chain.count, txs0 + 1);
  // reject moves nothing; expiry moves nothing
  const r3 = await tool('hood_buy_lot', { lot: 'C6' }, seats.soot);
  assert.equal((await ownerCall('POST', '/owner-api/reject', { id: r3.structuredContent.proposal.id, reason: 'no' })).body.ok, true);
  const r4 = await tool('hood_buy_lot', { lot: 'B6' }, seats.brine);
  hood.proposal(r4.structuredContent.proposal.id).expiresAt -= 31 * 60_000;
  assert.match((await ownerCall('POST', '/owner-api/approve', { id: r4.structuredContent.proposal.id, proposalHash: r4.structuredContent.proposal.proposal_hash, transactionHash: r4.structuredContent.proposal.transaction_hash })).body.error, /expired/);
  assert.equal(chain.count, txs0 + 1, 'only the one executed proposal ever moved money');
});

await test('admin page: only a logged-in owner, from the page itself, can accept; the password is only a hash on disk', async () => {
  const { createOwnerCore } = await import('../owner.mjs');
  const { createAdmin, writeAdminPassword } = await import('../admin.mjs');
  const { hood, chain } = makeHood();
  await hood.run(() => hood.refresh());
  const seats = makeSeats();
  const mcp = createMcp({ hood, seats });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-admin-'));
  const admin = createAdmin({ hood, core: createOwnerCore({ hood }), stateDir: dir });
  const call = async (method, pathname, { body = '', cookie = '', headers = {}, ip = '198.51.100.7' } = {}) => {
    let status = 0, hdrs = {}, out = '';
    const h = { host: 'hood.example', 'x-forwarded-proto': 'https', 'x-forwarded-prefix': '/swigglies', 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), ...headers };
    await admin({ method, headers: h, socket: { remoteAddress: '127.0.0.1' }, on() {} }, { writeHead(c, x = {}) { status = c; hdrs = x; }, end(b) { out = String(b ?? ''); }, write() {} }, new URL(`http://x${pathname}`), body);
    return { status, headers: hdrs, body: out };
  };
  const tool = async (name, args) => {
    let out = '';
    await mcp({ method: 'POST', headers: { authorization: `Bearer ${seats.pip}` } }, { setHeader() {}, writeHead() {}, end(b) { out = b; } }, new URL('http://x/mcp'), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    return JSON.parse(out).result;
  };
  // not set up: says how, and nothing opens
  assert.match((await call('GET', '/admin/')).body, /not set yet/);
  assert.equal((await call('POST', '/admin/login', { body: 'password=anything-at-all' })).status, 503);
  const pw = 'correct horse battery staple';
  await writeAdminPassword(dir, pw);
  assert.ok(!fs.readFileSync(path.join(dir, 'admin.json'), 'utf8').includes('horse'), 'only a hash is stored');
  const prop = await tool('hood_buy_lot', { lot: 'C4' });
  const pid = prop.structuredContent.proposal.id, txs0 = chain.count;
  let act = { body: JSON.stringify({ id: pid, proposalHash: prop.structuredContent.proposal.proposal_hash, transactionHash: prop.structuredContent.proposal.transaction_hash }), headers: { 'x-swigglies-admin': '1', origin: 'https://hood.example', 'content-type': 'application/json' } };
  // without a session: the login page, and every API call refused
  assert.match((await call('GET', '/admin/')).body, /type="password"/);
  assert.equal((await call('GET', '/admin/api/state')).status, 401);
  assert.equal((await call('POST', '/admin/api/approve', act)).status, 401);
  assert.equal((await call('GET', '/admin/admin.js')).status, 303);
  // wrong password, then a forged cookie
  assert.equal((await call('POST', '/admin/login', { body: 'password=wrong' })).status, 401);
  assert.equal((await call('POST', '/admin/api/approve', { ...act, cookie: `dh_admin=${'A'.repeat(43)}` })).status, 401);
  assert.equal(chain.count, txs0, 'nothing moved');
  // the right password: a strict, http-only, path-scoped, secure cookie
  const ok = await call('POST', '/admin/login', { body: `password=${encodeURIComponent(pw)}`, headers: { origin: 'https://hood.example' } });
  assert.equal(ok.status, 303);
  const setc = ok.headers['set-cookie'];
  assert.match(setc, /HttpOnly/); assert.match(setc, /SameSite=Strict/); assert.match(setc, /Secure/); assert.match(setc, /Path=\/swigglies\/admin;/);
  const cookie = setc.split(';')[0];
  assert.match((await call('GET', '/admin/', { cookie })).body, /admin\.js/);
  const st = JSON.parse((await call('GET', '/admin/api/state', { cookie })).body);
  assert.equal(st.pending.length, 1); assert.equal(st.pending[0].check.ok, true);
  assert.match(st.csrf, /^[\w-]{40,}$/); assert.match(st.pending[0].challenge, /^\d+\.[\w-]{40,}$/);
  // without the CSRF token, or without the review challenge, Accept is refused
  assert.equal((await call('POST', '/admin/api/approve', { ...act, cookie })).status, 403);
  act = { body: act.body, headers: { ...act.headers, 'x-csrf-token': st.csrf } };
  assert.equal((await call('POST', '/admin/api/approve', { ...act, cookie })).status, 409, 'no review challenge');
  const forged = JSON.stringify({ ...JSON.parse(act.body), challenge: `${Date.now()}.${'A'.repeat(43)}` });
  assert.equal((await call('POST', '/admin/api/approve', { ...act, body: forged, cookie })).status, 409, 'forged challenge');
  act = { ...act, body: JSON.stringify({ ...JSON.parse(act.body), challenge: st.pending[0].challenge }) };
  // logged in, but another site (or a plain form) tries to press Accept: refused
  assert.equal((await call('POST', '/admin/api/approve', { ...act, cookie, headers: { ...act.headers, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('POST', '/admin/api/approve', { ...act, cookie, headers: { origin: 'https://hood.example' } })).status, 403);
  assert.equal((await call('POST', '/admin/api/approve', { ...act, cookie, headers: { 'x-swigglies-admin': '1' } })).status, 403);
  assert.equal(chain.count, txs0, 'still nothing moved');
  // the owner presses Accept on the page: exactly that proposal executes
  const done = JSON.parse((await call('POST', '/admin/api/approve', { ...act, cookie })).body);
  assert.equal(done.ok, true);
  assert.equal(chain.count, txs0 + 1);
  assert.equal(hood.s.lots[E.parseLot('C4')].owner, 'pip');
  assert.equal(hood.proposal(pid).status, 'executed');
  assert.ok(!JSON.stringify(hood.s.feed || []).includes('198.51.100.7'), 'the owner address stays out of the public feed');
  // log out ends the session
  await call('POST', '/admin/logout', { cookie });
  assert.equal((await call('GET', '/admin/api/state', { cookie })).status, 401);
  // brute force: after five wrong tries from one address, even the right password is refused for a while
  for (let i = 0; i < 5; i++) await call('POST', '/admin/login', { body: 'password=nope', ip: '203.0.113.50' });
  assert.equal((await call('POST', '/admin/login', { body: `password=${encodeURIComponent(pw)}`, ip: '203.0.113.50' })).status, 429);
});

await test("the Dot's contract: bound record, seat binding, exact-once execution, fee/price/state drift goes stale, stop voids", async () => {
  const { proposalHash } = await import('../hood.mjs');
  const { createOwnerCore } = await import('../owner.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-contract-'));
  const chain = new S.SimChain();
  const office = { kp: S.newKeypair() };
  const agents = ROSTER.map(r => ({ r, kp: S.newKeypair() }));
  chain.fund(office.kp.address, S.LAMPORTS / 5);
  agents.forEach(w => chain.fund(w.kp.address, S.LAMPORTS));
  const opts = { chain, office, agents, unit: 10_000_000, cluster: 'sim', stateFile: path.join(dir, 'state.json'), logFile: path.join(dir, 'events.jsonl') };
  const hood = new Hood(opts);
  await hood.run(() => hood.refresh());
  const seats = makeSeats();
  const mcp = createMcp({ hood, seats });
  const core = createOwnerCore({ hood });
  const tool = async (name, args, key) => {
    let out = '';
    await mcp({ method: 'POST', headers: { authorization: `Bearer ${key}` } }, { setHeader() {}, writeHead() {}, end(b) { out = b; } }, new URL('http://x/mcp'), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }));
    return JSON.parse(out).result;
  };
  const approve = x => core.act('approve', JSON.stringify({ id: x.id, proposalHash: x.proposalHash ?? x.proposal_hash, transactionHash: x.transactionHash ?? x.transaction_hash }), 'owner (test)').then(([, b]) => b);
  const txs0 = chain.count;

  // the one shared link must name the dot; a seat key acts only for its own dot
  assert.match((await tool('hood_buy_lot', { lot: 'C4' }, seats.house)).content[0].text, /pass agent/);
  assert.match((await tool('hood_buy_lot', { agent: 'pip', lot: 'C4' }, seats.soot)).content[0].text, /soot's/);

  // the record: immutable id, seat, action, payer, recipient, amount, fee, network, expiry, state version, digest
  const before = hood.s.rev;
  const r = await tool('hood_buy_lot', { lot: 'C4' }, seats.pip);
  const pub = r.structuredContent.proposal, x = hood.proposal(pub.id);
  for (const k of ['id', 'request_id', 'run_id', 'seat', 'action', 'network', 'board_version', 'payer', 'transfers', 'amount_lamports', 'fee_lamports', 'expires_at', 'transaction_hash', 'proposal_hash']) assert.ok(pub[k] != null, `proposal carries ${k}`);
  assert.equal(pub.seat, 'pip'); assert.equal(pub.network, 'sim'); assert.equal(pub.board_version, x.boardVersion); assert.ok(before <= hood.s.rev);
  assert.deepEqual(pub.action, { type: 'buy_lot', parameters: { lot: 'C4' } });
  assert.equal(pub.payer, E.agentOf(hood.s, 'pip').address);
  assert.equal(pub.transfers[0].to, hood.s.office.address);
  assert.equal(pub.fee_lamports, S.SIG_FEE);
  assert.equal(pub.proposal_hash, proposalHash(x));
  assert.equal(pub.transaction_hash, S.templateHash({ payer: x.payer, transfers: x.transfers, memo: x.memo }), 'the exact unsigned transaction');
  assert.match(x.memo, /\[p\d+\]$/, 'the memo carries the proposal id, for reconciliation');
  assert.equal(Date.parse(pub.expires_at) - Date.parse(pub.created_at), 30 * 60_000);
  assert.equal(chain.count, txs0, 'staging signs and sends nothing');
  // the same move again from the same seat is not a second proposal
  assert.match((await tool('hood_buy_lot', { lot: 'C4' }, seats.pip)).content[0].text, /identical proposal \(#\d+\) is already pending/);

  // Accept names the exact record: no hashes, or different ones, execute nothing
  assert.match((await core.act('approve', JSON.stringify({ id: x.id }), 'o'))[1].error, /proposalHash and transactionHash required/);
  assert.match((await approve({ ...x, proposalHash: 'f'.repeat(64) })).error, /hash mismatch/);
  assert.match((await approve({ ...x, transactionHash: 'f'.repeat(64) })).error, /hash mismatch/);
  assert.equal(chain.count, txs0);

  // two clicks at once: exactly one execution
  const [a1, a2] = await Promise.all([approve(x), approve(x)]);
  assert.equal([a1, a2].filter(v => v.ok).length, 1);
  assert.match([a1, a2].find(v => !v.ok).error, /is executed; it cannot execute \(again\)/);
  assert.equal(chain.count, txs0 + 1);
  assert.match((await approve(x)).error, /cannot execute/);
  assert.equal(chain.count, txs0 + 1, 'executed once, never twice');
  // the agent reads the confirmed result and its receipt
  const seen = (await tool('hood_proposal', { id: x.id }, seats.pip)).structuredContent.proposal;
  assert.equal(seen.status, 'executed'); assert.equal(seen.confirmed, true); assert.ok(seen.signature); assert.match(seen.receipt, /^https:\/\/solscan\.io\/tx\//);
  assert.equal(seen.closed_by, 'owner');

  // the fee limit: a fee above the proposed one sends it stale
  const f = (await tool('hood_buy_lot', { lot: 'B2' }, seats.soot)).structuredContent.proposal;
  hood.chain.priority = { units: 30_000, microLamports: 1_000_000 };
  assert.match((await approve(f)).error, /stale: the network fee rose/);
  hood.chain.priority = null;
  // the price: another sale raises land, so an older proposal goes stale instead of executing at a new price
  const g1 = (await tool('hood_buy_lot', { lot: 'F6' }, seats.brine)).structuredContent.proposal;
  const g2 = (await tool('hood_buy_lot', { lot: 'F2' }, seats.lark)).structuredContent.proposal;
  assert.equal((await approve(g1)).ok, true);
  assert.match((await approve(g2)).error, /stale: the board changed/);
  assert.equal(chain.count, txs0 + 2);
  assert.equal(hood.proposal(g2.id).status, 'stale');

  // stopping voids every pending proposal and refuses new ones; resuming reopens
  const h1 = (await tool('hood_buy_lot', { lot: 'A1' }, seats.marrow)).structuredContent.proposal;
  assert.equal((await core.act('stop', '{}', 'owner (test)'))[1].voided, 1);
  assert.equal(hood.proposal(h1.id).status, 'void');
  assert.match((await approve(h1)).error, /is void/);
  assert.match((await tool('hood_buy_lot', { lot: 'A2' }, seats.marrow)).content[0].text, /stopped the hood/);
  assert.match((await tool('hood_look', {}, seats.marrow)).content[0].text, /^THE HOOD IS STOPPED/);
  assert.deepEqual(await hood.settle(), { ok: false, halted: true });
  assert.equal(chain.count, txs0 + 2, 'nothing moved while stopped');
  await core.act('resume', '{}', 'owner (test)');
  const h2 = (await tool('hood_buy_lot', { lot: 'A2' }, seats.marrow)).structuredContent.proposal;
  assert.equal(h2.status, 'pending');

  // a restart voids what was pending (the server calls voidPending on start)
  await hood.run(() => hood.save());
  const again = new Hood(opts);
  assert.equal(again.proposal(h2.id).status, 'pending');
  assert.equal(again.voidPending('the server restarted', 'office'), 1);
  assert.equal(again.proposal(h2.id).status, 'void');

  // where the owner executes every move, the autopilot never spends a quiet seat's wallet
  const quiet = new Hood({ ...opts, stateFile: null, logFile: null, autopilot: false });
  await quiet.run(() => quiet.refresh());
  const c0 = chain.count;
  for (let i = 0; i < 10; i++) assert.equal(await quiet.autopilotStep(), null);
  assert.equal(chain.count, c0);
});

await test('runner door (dothood-proposal-v1): seat-bound, inert staging, idempotent, revocable; the owner executes', async () => {
  const { createRunnerApi } = await import('../runner-api.mjs');
  const { createOwnerCore } = await import('../owner.mjs');
  const { proposalImmutable } = await import('../hood.mjs');
  const { hood, chain } = makeHood();
  await hood.run(() => hood.refresh());
  const seats = makeSeats();
  const api = createRunnerApi({ hood, seats });
  const core = createOwnerCore({ hood });
  const call = async (method, pathname, body, key) => {
    let status = 0, out = '';
    await api({ method, headers: key ? { authorization: `Bearer ${key}` } : {} }, { writeHead(c) { status = c; }, end(b) { out = b; } }, new URL(`http://x${pathname}`), body === undefined ? '' : JSON.stringify(body));
    return { status, body: out ? JSON.parse(out) : null };
  };
  const sha = o => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
  const board = (await call('GET', '/runner/v1/board', undefined, seats.pip)).body;
  const req = (over = {}) => ({ protocol: 'dothood-proposal-v1', seat: 'pip', runId: 'run-1', requestId: 'r1', boardVersion: board.version, action: { type: 'buy_lot', parameters: { lot: 'C4' } }, reason: 'land is cheap', ...over });
  const txs0 = chain.count;

  // the board: five unique rows with integer lamports, the office, a version
  assert.deepEqual(board.players.map(p => p.id), ['marrow', 'pip', 'soot', 'brine', 'lark']);
  assert.ok(board.players.every(p => ['balance', 'spendable', 'upkeep', 'estate', 'net', 'lots'].every(k => Number.isSafeInteger(p[k]) && p[k] >= 0) && p.spendable <= p.balance));
  assert.equal(board.office, hood.s.office.address); assert.equal(board.network, 'sim'); assert.match(board.version, /^b[0-9a-f]{24}$/);

  // authentication and seat binding
  assert.equal((await call('GET', '/runner/v1/board')).status, 401);
  assert.equal((await call('POST', '/runner/v1/proposals', req(), 'dh_notakey')).status, 401);
  assert.equal((await call('POST', '/runner/v1/proposals', req(), seats.house)).body.error, 'keeper_cannot_propose');
  assert.equal((await call('POST', '/runner/v1/proposals', req(), seats.soot)).body.error, 'wrong_seat');
  // strict schemas
  assert.equal((await call('POST', '/runner/v1/proposals', { ...req(), recipient: 'x' }, seats.pip)).body.error, 'unknown_fields');
  assert.equal((await call('POST', '/runner/v1/proposals', req({ action: { type: 'transfer', parameters: {} } }), seats.pip)).body.error, 'unknown_proposal_action');
  assert.equal((await call('POST', '/runner/v1/proposals', req({ action: { type: 'buy_lot', parameters: { lot: 'C4', to: 'x' } } }), seats.pip)).body.error, 'unknown_argument');
  assert.equal((await call('POST', '/runner/v1/proposals', req({ action: { type: 'buy_lot', parameters: { lot: 'D4' } } }), seats.pip)).body.error, 'bad_argument');
  assert.equal((await call('POST', '/runner/v1/proposals', req({ boardVersion: 'b0' }), seats.pip)).body.error, 'stale_board');
  assert.equal(chain.count, txs0);

  // staging: an inert pending record committing to the exact transaction
  const a = await call('POST', '/runner/v1/proposals', req(), seats.pip);
  assert.equal(a.status, 201);
  const x = a.body;
  assert.equal(x.state, 'pending'); assert.equal(typeof x.id, 'string'); assert.equal(x.seat, 'pip'); assert.equal(x.runId, 'run-1'); assert.equal(x.requestId, 'r1');
  assert.deepEqual(x.action, req().action);
  assert.equal(x.payer, E.agentOf(hood.s, 'pip').address);
  assert.equal(x.amount, x.transfers.reduce((t, y) => t + y.lamports, 0));
  assert.ok(x.expiresAt > Date.now() && x.expiresAt <= Date.now() + 120_000, 'inside the runner\'s two-minute window');
  const rec = hood.proposal(x.id);
  assert.equal(x.transactionHash, S.templateHash({ payer: rec.payer, transfers: rec.transfers, memo: rec.memo }));
  const { proposalHash: ph, state: _st, ...imm } = x;
  assert.deepEqual(Object.keys(imm), ['id', 'requestId', 'runId', 'seat', 'boardVersion', 'action', 'network', 'payer', 'transfers', 'amount', 'fee', 'expiresAt', 'transactionHash']);
  assert.equal(ph, sha(imm), 'proposalHash = SHA-256 of the immutable fields in contract order');
  assert.deepEqual(proposalImmutable(rec), imm);
  assert.equal(chain.count, txs0, 'staging signs nothing');
  assert.equal(hood.s.lots[E.parseLot('C4')].owner, null, 'and changes nothing');
  // idempotency: the same request returns the same record; a different payload under the same key is refused
  const again = await call('POST', '/runner/v1/proposals', req(), seats.pip);
  assert.equal(again.status, 200); assert.equal(again.body.id, x.id);
  assert.equal((await call('POST', '/runner/v1/proposals', req({ action: { type: 'buy_lot', parameters: { lot: 'C5' } } }), seats.pip)).body.error, 'idempotency_conflict');
  // reads are role-bound
  assert.equal((await call('GET', `/runner/v1/proposals/${x.id}`, undefined, seats.pip)).body.state, 'pending');
  assert.equal((await call('GET', `/runner/v1/proposals/${x.id}`, undefined, seats.soot)).status, 404);
  // no route here can execute
  for (const path of [`/runner/v1/proposals/${x.id}/execute`, `/runner/v1/proposals/${x.id}/approve`, '/runner/v1/execute']) {
    assert.equal((await call('POST', path, { id: x.id, proposalHash: x.proposalHash, transactionHash: x.transactionHash }, seats.pip)).status, 404);
  }
  assert.equal(chain.count, txs0);

  // the owner executes exactly that record; the seat reads the confirmed receipt
  const done = (await core.act('approve', JSON.stringify({ id: Number(x.id), proposalHash: x.proposalHash, transactionHash: x.transactionHash }), 'owner (test)'))[1];
  assert.equal(done.ok, true);
  assert.equal(chain.count, txs0 + 1);
  const conf = (await call('GET', `/runner/v1/proposals/${x.id}`, undefined, seats.pip)).body;
  assert.equal(conf.state, 'confirmed'); assert.ok(conf.signature); assert.equal(conf.receipt, `https://solscan.io/tx/${conf.signature}?cluster=sim`);
  assert.equal(conf.proposalHash, x.proposalHash, 'the commitment never changes');

  // a board change sends older proposals to fresh review
  const b2 = (await call('GET', '/runner/v1/board', undefined, seats.lark)).body;
  assert.notEqual(b2.version, board.version);
  const l1 = (await call('POST', '/runner/v1/proposals', { ...req({ seat: 'lark', requestId: 'l1', boardVersion: b2.version, action: { type: 'buy_lot', parameters: { lot: 'F2' } } }) }, seats.lark)).body;
  const m1 = (await call('POST', '/runner/v1/proposals', { ...req({ seat: 'marrow', requestId: 'm1', boardVersion: b2.version, action: { type: 'buy_lot', parameters: { lot: 'A1' } } }) }, seats.marrow)).body;
  assert.equal((await core.act('approve', JSON.stringify({ id: Number(l1.id), proposalHash: l1.proposalHash, transactionHash: l1.transactionHash }), 'o'))[1].ok, true);
  const m1r = (await core.act('approve', JSON.stringify({ id: Number(m1.id), proposalHash: m1.proposalHash, transactionHash: m1.transactionHash }), 'o'))[1];
  assert.equal(m1r.code, 'reapproval_required');
  assert.equal((await call('GET', `/runner/v1/proposals/${m1.id}`, undefined, seats.marrow)).body.state, 'reapproval_required');

  // an off-chain listing is a proposal too: no transfers, applied only by the owner
  hood.s.agents.find(y => y.id === 'soot').crates = 3;
  const b3 = (await call('GET', '/runner/v1/board', undefined, seats.soot)).body;
  const li = (await call('POST', '/runner/v1/proposals', req({ seat: 'soot', requestId: 's1', boardVersion: b3.version, action: { type: 'list', parameters: { crates: 2, price_sol: 0.05 } } }), seats.soot)).body;
  assert.equal(li.state, 'pending'); assert.deepEqual(li.transfers, []); assert.equal(li.amount, 0); assert.equal(li.fee, 0);
  assert.equal(hood.s.listings.length, 0, 'not listed yet');
  assert.equal((await core.act('approve', JSON.stringify({ id: Number(li.id), proposalHash: li.proposalHash, transactionHash: li.transactionHash }), 'o'))[1].ok, true);
  assert.equal(hood.s.listings.length, 1);
  assert.equal((await call('GET', `/runner/v1/proposals/${li.id}`, undefined, seats.soot)).body.state, 'applied');

  // revocation: a seat revokes its own run; late submissions under it are refused, durably
  const b4 = (await call('GET', '/runner/v1/board', undefined, seats.brine)).body;
  const br = (await call('POST', '/runner/v1/proposals', req({ seat: 'brine', runId: 'run-2', requestId: 'b1', boardVersion: b4.version, action: { type: 'buy_lot', parameters: { lot: 'G7' } } }), seats.brine)).body;
  assert.equal((await call('POST', '/runner/v1/runs/run-2/revoke', {}, seats.brine)).body.revoked, 1);
  assert.equal((await call('GET', `/runner/v1/proposals/${br.id}`, undefined, seats.brine)).body.state, 'revoked');
  assert.equal((await call('POST', '/runner/v1/proposals', req({ seat: 'brine', runId: 'run-2', requestId: 'b2', boardVersion: b4.version, action: { type: 'buy_lot', parameters: { lot: 'G6' } } }), seats.brine)).body.error, 'run_revoked');
  assert.match((await core.act('approve', JSON.stringify({ id: Number(br.id), proposalHash: br.proposalHash, transactionHash: br.transactionHash }), 'o'))[1].error, /is void/);
  // the keeper revokes a run for all five
  assert.equal((await call('POST', '/runner/v1/runs/run-3/revoke', {}, seats.house)).body.scope, 'all');
  assert.equal((await call('POST', '/runner/v1/proposals', req({ runId: 'run-3', requestId: 'p9', boardVersion: b4.version, action: { type: 'buy_lot', parameters: { lot: 'G5' } } }), seats.pip)).body.error, 'run_revoked');
});

await test('every signing path waits for the owner: house proposals, no signing outside an approval, signer-bound template, reconciliation', async () => {
  const { createOwnerCore } = await import('../owner.mjs');
  const { guardChain } = await import('../guard.mjs');
  const approveX = (core, x) => core.act('approve', JSON.stringify({ id: x.id, proposalHash: x.proposalHash, transactionHash: x.transactionHash }), 'owner (test)').then(([, b]) => b);

  // a board with builds, then the owner-executes mode switched on
  const { hood, chain } = makeHood();
  await hood.run(() => hood.refresh());
  assert.ok((await hood.act('pip', { type: 'buy_lot', lot: 'A1' })).ok);
  assert.ok((await hood.act('pip', { type: 'build', lot: 'A1', kind: 'house' })).ok);
  hood.ownerExecutes = true;
  hood.autopilot = false;
  const core = createOwnerCore({ hood });
  const c0 = chain.count;
  // legacy paths cannot sign
  assert.match((await hood.act('lark', { type: 'buy_lot', lot: 'B1' })).error, /owner's click/);
  await assert.rejects(hood.sendPlan({ payer: hood.s.office.address, transfers: [{ from: hood.s.office.address, to: E.agentOf(hood.s, 'pip').address, lamports: 1_000_000 }], memo: 'swigglies: sneaky' }), /only the owner's Accept signs/);
  assert.equal(chain.count, c0);
  // the epoch's rent roll becomes a house proposal, and waits
  hood.s.epochAt = 0;
  const r = await hood.settle();
  assert.ok(r.proposed, 'proposed, not sent');
  assert.equal(chain.count, c0);
  const epoch0 = hood.s.epoch;
  assert.deepEqual(await hood.settle(), { ok: false, waiting: true }, 'one at a time');
  const ep = hood.proposal(r.proposed);
  assert.equal(ep.kind, 'house'); assert.equal(ep.seat, 'office'); assert.match(ep.memo, /\[p\d+\]$/);
  assert.equal((await approveX(core, ep)).ok, true);
  assert.equal(chain.count, c0 + 1);
  assert.equal(hood.s.epoch, epoch0 + 1, 'the epoch turned when the owner executed it');

  // the opening stake is a house proposal too
  const fresh = makeHood();
  fresh.agents.forEach(w => { fresh.chain.bal.set(w.kp.address, 0); });
  fresh.chain.fund(fresh.office.kp.address, 3 * S.LAMPORTS);
  fresh.hood.ownerExecutes = true;
  await fresh.hood.run(() => fresh.hood.refresh());
  assert.equal(await fresh.hood.run(() => fresh.hood.stakeIfReady()), false);
  const stake = fresh.hood.s.proposals.find(x => x.kind === 'house' && x.action.type === 'stake');
  assert.ok(stake && stake.status === 'pending' && fresh.chain.count === 0);
  assert.equal((await approveX(createOwnerCore({ hood: fresh.hood }), stake)).ok, true);
  assert.equal(fresh.hood.s.staked, true);

  // the signer's guard binds the reviewed template: any other transaction is refused before signing
  const g = guardChain(chain, { wallets: [hood.s.office.address, ...hood.s.agents.map(a => a.address)], cluster: 'sim' });
  const plan = { payer: E.agentOf(hood.s, 'lark').address, transfers: [{ from: E.agentOf(hood.s, 'lark').address, to: hood.s.office.address, lamports: 1_000_000 }], memo: 'swigglies: test [p900]', keyFor: a => hood.keyByAddress.get(a) };
  await assert.rejects(g.send({ ...plan, templateHash: 'f'.repeat(64) }), /not the one the owner reviewed/);
  assert.ok((await g.send({ ...plan, templateHash: S.templateHash(plan) })).signature);

  // an interrupted execution stays EXECUTING, is never re-sent, and is reconciled from its memo tag
  const seats = makeSeats();
  const mcp = createMcp({ hood, seats });
  const tool = async (name, args, key) => { let out = ''; await mcp({ method: 'POST', headers: { authorization: `Bearer ${key}` } }, { setHeader() {}, writeHead() {}, end(b) { out = b; } }, new URL('http://x/mcp'), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })); return JSON.parse(out).result; };
  const landed = hood.proposal((await tool('hood_buy_lot', { lot: 'B3' }, seats.soot)).structuredContent.proposal.id);
  const realSend = chain.send.bind(chain);
  chain.send = async plan2 => { await realSend(plan2); throw new Error('confirmation timed out'); };
  const u = await approveX(core, landed);
  assert.equal(u.code, 'executing');
  assert.equal(landed.status, 'executing');
  const sent = chain.count;
  assert.match((await approveX(core, landed)).error, /is executing; it cannot execute \(again\)/);
  chain.send = realSend;
  await hood.run(() => hood.reconcile(Date.now() + 200_000));
  assert.equal(landed.status, 'executed'); assert.equal(landed.reconciled, true); assert.ok(landed.sig);
  assert.equal(hood.s.lots[E.parseLot('B3')].owner, 'soot', 'its effect was applied once it was found');
  assert.equal(chain.count, sent, 'never sent twice');
  // one that never landed fails, and nothing moved
  const lost = hood.proposal((await tool('hood_buy_lot', { lot: 'B4' }, seats.brine)).structuredContent.proposal.id);
  chain.send = async () => { throw new Error('connection reset'); };
  assert.equal((await approveX(core, lost)).code, 'executing');
  chain.send = realSend;
  await hood.run(() => hood.reconcile(Date.now() + 200_000));
  assert.equal(lost.status, 'failed'); assert.match(lost.reason, /never landed/);
  assert.equal(hood.s.lots[E.parseLot('B4')].owner, null);
});

await test('X posts: OAuth 1.0a signs like the published example; every executed transaction posts once, with its Solscan link', async () => {
  const { oauthHeader, postText, createXPoster } = await import('../xpost.mjs');
  const { createOwnerCore } = await import('../owner.mjs');
  // the signing example from X's developer documentation ("Creating a signature")
  const v = oauthHeader({
    method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json',
    params: { include_entities: 'true', status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958,
  });
  assert.equal(v.signature, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  // the post: fits 280 with the link counted as 23, ends with the receipt
  const long = postText({ id: 7, result: `${'Pip bought a very long lot name '.repeat(20)} (proposal #7, executed by the owner)` }, 'https://solscan.io/tx/abc');
  assert.ok(long.length - 'https://solscan.io/tx/abc'.length + 23 <= 280);
  assert.ok(long.endsWith('\nhttps://solscan.io/tx/abc'));
  assert.equal(postText({ id: 1, result: 'Pip bought C4 from the office for 0.0038 SOL. (proposal #1, executed by the owner)' }, 'https://solscan.io/tx/s'), 'Swigglies log #1: Pip bought C4 from the office for 0.0038 SOL.\nhttps://solscan.io/tx/s', 'a log line and its receipt, nothing else');

  // off without keys: nothing is sent
  const { hood } = makeHood();
  await hood.run(() => hood.refresh());
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url, init }); return { status: 201, json: async () => ({ data: { id: String(1000 + calls.length) } }), headers: { get: () => null } }; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dh-x-'));
  const off = createXPoster({ hood, env: {}, stateDir: dir, fetchImpl: fakeFetch, gapMs: 0 });
  assert.equal(off.status().enabled, false);
  off.stop();

  // on: an executed proposal becomes exactly one post with its receipt; nothing is posted for proposals that did not execute
  let t = 1_000_000;
  const env = { X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'a' };
  const on = createXPoster({ hood, env, stateDir: dir, fetchImpl: fakeFetch, gapMs: 0, now: () => t });
  const seats = makeSeats();
  const mcp = createMcp({ hood, seats });
  const tool = async (name, args, key) => { let out = ''; await mcp({ method: 'POST', headers: { authorization: `Bearer ${key}` } }, { setHeader() {}, writeHead() {}, end(b) { out = b; } }, new URL('http://x/mcp'), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })); return JSON.parse(out).result; };
  const core = createOwnerCore({ hood });
  const p1 = (await tool('hood_buy_lot', { lot: 'C4' }, seats.pip)).structuredContent.proposal;
  const p2 = (await tool('hood_buy_lot', { lot: 'A1' }, seats.marrow)).structuredContent.proposal;
  await core.act('reject', JSON.stringify({ id: p2.id }), 'owner (test)');
  assert.equal(on.status().queued, 0, 'proposing or rejecting posts nothing');
  assert.equal((await core.act('approve', JSON.stringify({ id: p1.id, proposalHash: p1.proposal_hash, transactionHash: p1.transaction_hash }), 'owner (test)'))[1].ok, true);
  assert.equal(on.status().queued, 1);
  await on.tick();
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, 'https://api.x.com/2/tweets');
  assert.match(calls[0].init.headers.authorization, /^OAuth oauth_consumer_key="k", .*oauth_signature="[^"]+"/);
  assert.match(body.text, /^Swigglies log #\d+: Pip bought C4/);
  assert.match(body.text, /\nhttps:\/\/solscan\.io\/tx\/[1-9A-HJ-NP-Za-km-z]+\?cluster=sim$/);
  assert.equal(on.status().posted, 1);
  // the same proposal never posts twice, even after a restart of the poster
  on.enqueue(hood.proposal(p1.id), 'https://solscan.io/tx/again');
  on.stop();
  const again = createXPoster({ hood, env, stateDir: dir, fetchImpl: fakeFetch, gapMs: 0, now: () => t });
  again.enqueue(hood.proposal(p1.id), 'https://solscan.io/tx/again');
  await again.tick();
  assert.equal(calls.length, 1, 'posted once');
  // a rate limit keeps the post queued and waits for the reset
  const limited = async () => ({ status: 429, json: async () => ({ title: 'Too Many Requests' }), headers: { get: h => (h === 'x-rate-limit-reset' ? String(Math.floor(t / 1000) + 900) : null) } });
  const rl = createXPoster({ hood, env, stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dh-x2-')), fetchImpl: limited, gapMs: 0, now: () => t });
  rl.enqueue({ id: 99, result: 'Soot sold 2 crates.' }, 'https://solscan.io/tx/q');
  await rl.tick();
  assert.equal(rl.status().queued, 1); assert.equal(rl.status().error.status, 429);
  assert.equal(await rl.tick(), null, 'waits for the reset');
  again.stop(); rl.stop();
});

console.log(`\n${passed} passed`);

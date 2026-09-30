// The in-house Solana wallet. ed25519 keys come from node:crypto, addresses are base58, and
// transactions (System transfers + a Memo) are serialized here byte by byte in the legacy
// format, signed, and sent over plain JSON-RPC. No @solana/web3.js anywhere.
import crypto from 'node:crypto';

export const LAMPORTS = 1_000_000_000;
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const RENT_MIN = 890_880; // rent-exempt minimum of a 0-byte system account
export const SIG_FEE = 5_000;    // base fee per signature
export const TX_MAX = 1232;      // packet limit for one transaction

// Each cluster keeps its own game file and event log, so the devnet rehearsal is never mixed into a
// mainnet run (the six wallets are the same keys on every cluster).
export const clusterFiles = cluster => (cluster === 'mainnet-beta'
  ? { state: 'state-mainnet.json', log: 'events-mainnet.jsonl' }
  : { state: 'state.json', log: 'events.jsonl' });

const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function b58encode(buf) {
  const bytes = [...buf];
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map(d => ALPHA[d]).join('');
}

export function b58decode(str) {
  const bytes = [];
  for (const ch of str) {
    let carry = ALPHA.indexOf(ch);
    if (carry < 0) throw new Error(`not base58: ${str}`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes.reverse()]);
}

export function pubkeyBytes(address) {
  const b = b58decode(address);
  if (b.length !== 32) throw new Error(`not a 32-byte address: ${address}`);
  return b;
}

export const isAddress = a => { try { return typeof a === 'string' && pubkeyBytes(a).length === 32; } catch { return false; } };

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

export function keypairFromSeed(seed) {
  if (seed.length !== 32) throw new Error('seed must be 32 bytes');
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = Buffer.from(crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32));
  return { seed: Buffer.from(seed), publicKey, address: b58encode(publicKey), privateKey };
}

export const newKeypair = () => keypairFromSeed(crypto.randomBytes(32));

// Solana CLI / Phantom "secret key" layout: seed ‖ public key, 64 bytes.
export const secretKey64 = kp => Buffer.concat([kp.seed, kp.publicKey]);

export function verify(address, message, signature) {
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, pubkeyBytes(address)]), format: 'der', type: 'spki' });
  return crypto.verify(null, message, key, signature);
}

function shortvec(n) {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (n) out.push(b | 0x80); else { out.push(b); return Buffer.from(out); }
  }
}

// Legacy message: header, account keys (payer first, then writable signers, readonly signers,
// writable non-signers, readonly non-signers), recent blockhash, instructions.
// priority = { units, microLamports }: on mainnet a ComputeBudget limit + price go first, so a move
// still lands when the network is busy (priority fee = units × microLamports / 1e6 lamports).
export function compileMessage({ payer, transfers, memo, blockhash, priority = null }) {
  const meta = new Map();
  const touch = (addr, signer, writable) => {
    const m = meta.get(addr) || { signer: false, writable: false, order: meta.size };
    m.signer ||= signer; m.writable ||= writable;
    meta.set(addr, m);
  };
  touch(payer, true, true);
  for (const t of transfers) {
    if (t.from === t.to) throw new Error('a wallet cannot pay itself');
    if (!Number.isSafeInteger(t.lamports) || t.lamports <= 0) throw new Error(`bad amount ${t.lamports}`);
    touch(t.from, true, true);
    touch(t.to, false, true);
  }
  touch(SYSTEM_PROGRAM, false, false);
  if (memo) touch(MEMO_PROGRAM, false, false);
  if (priority) touch(COMPUTE_BUDGET_PROGRAM, false, false);
  const rank = (addr, m) => addr === payer ? 0 : m.signer ? (m.writable ? 1 : 2) : (m.writable ? 3 : 4);
  const keys = [...meta.entries()].sort((a, b) => rank(...a) - rank(...b) || a[1].order - b[1].order);
  const index = new Map(keys.map(([addr], i) => [addr, i]));
  const signers = keys.filter(([, m]) => m.signer).map(([addr]) => addr);
  const roSigned = keys.filter(([, m]) => m.signer && !m.writable).length;
  const roUnsigned = keys.filter(([, m]) => !m.signer && !m.writable).length;
  const ixs = [];
  if (priority) {
    const cb = index.get(COMPUTE_BUDGET_PROGRAM);
    const limit = Buffer.alloc(5); limit.writeUInt8(2, 0); limit.writeUInt32LE(priority.units, 1);                 // SetComputeUnitLimit
    const price = Buffer.alloc(9); price.writeUInt8(3, 0); price.writeBigUInt64LE(BigInt(priority.microLamports), 1); // SetComputeUnitPrice
    ixs.push(Buffer.concat([Buffer.from([cb]), shortvec(0), shortvec(5), limit]), Buffer.concat([Buffer.from([cb]), shortvec(0), shortvec(9), price]));
  }
  ixs.push(...transfers.map(t => {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(BigInt(t.lamports), 4);
    return Buffer.concat([Buffer.from([index.get(SYSTEM_PROGRAM)]), shortvec(2), Buffer.from([index.get(t.from), index.get(t.to)]), shortvec(12), data]);
  }));
  if (memo) {
    const data = Buffer.from(memo, 'utf8');
    ixs.push(Buffer.concat([Buffer.from([index.get(MEMO_PROGRAM)]), shortvec(0), shortvec(data.length), data]));
  }
  const message = Buffer.concat([
    Buffer.from([signers.length, roSigned, roUnsigned]),
    shortvec(keys.length), ...keys.map(([addr]) => pubkeyBytes(addr)),
    pubkeyBytes(blockhash),
    shortvec(ixs.length), ...ixs,
  ]);
  return { message, signers, accounts: keys.map(([addr]) => addr) };
}

// The exact unsigned transaction a proposal commits to: every byte of the message (compute-budget
// instructions, account metas, fee payer, ordered transfers, memo) compiled with an all-zero blockhash
// in place of the recent one. Solana needs a fresh blockhash at signing (one lives about a minute), so
// that field alone is filled in at the owner's click; the signer refuses unless the rest hashes the same.
export const TEMPLATE_BLOCKHASH = SYSTEM_PROGRAM; // 32 zero bytes
export function templateHash({ payer, transfers, memo, priority = null }) {
  const { message } = compileMessage({ payer, transfers, memo, blockhash: TEMPLATE_BLOCKHASH, priority });
  return crypto.createHash('sha256').update(message).digest('hex');
}

export function signTransaction(message, signers, keyFor) {
  const sigs = signers.map(addr => {
    const kp = keyFor(addr);
    if (!kp) throw new Error(`no key held for ${addr}`);
    return crypto.sign(null, message, kp.privateKey);
  });
  const tx = Buffer.concat([shortvec(sigs.length), ...sigs, message]);
  if (tx.length > TX_MAX) throw new Error(`transaction is ${tx.length} bytes, over ${TX_MAX}`);
  return { tx, signature: b58encode(sigs[0]), sigs };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class SolanaChain {
  constructor({ rpcUrl, cluster, priority = null }) { this.url = rpcUrl; this.cluster = cluster; this.priority = priority; this.id = 0; }

  async rpc(method, params = []) {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => null);
    if (!j) throw new Error(`${method}: HTTP ${res.status}`);
    if (j.error) {
      const e = new Error(`${method}: ${j.error.message}`);
      e.data = j.error.data;
      throw e;
    }
    return j.result;
  }

  async balances(addresses) {
    const r = await this.rpc('getMultipleAccounts', [addresses, { commitment: 'confirmed', encoding: 'base64', dataSlice: { offset: 0, length: 0 } }]);
    return r.value.map(v => (v ? v.lamports : 0));
  }

  airdrop(address, lamports) { return this.rpc('requestAirdrop', [address, lamports, { commitment: 'confirmed' }]); }

  // A confirmed transaction from `payer` whose memo contains `tag` (e.g. "[p12]"), or null.
  async findMemo(payer, tag) {
    const rows = await this.rpc('getSignaturesForAddress', [payer, { limit: 50, commitment: 'confirmed' }]);
    const r = rows.find(x => typeof x.memo === 'string' && x.memo.includes(tag));
    return r ? { signature: r.signature, ok: r.err == null } : null;
  }

  async send({ payer, transfers, memo, keyFor }) {
    const { value: { blockhash, lastValidBlockHeight } } = await this.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const { message, signers } = compileMessage({ payer, transfers, memo, blockhash, priority: this.priority });
    const { tx, signature } = signTransaction(message, signers, keyFor);
    try {
      await this.rpc('sendTransaction', [tx.toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
    } catch (e) {
      const logs = (e.data?.logs || []).filter(l => !/invoke|success|consumed/.test(l)).slice(-2).join(' | ');
      throw new Error(logs ? `${e.message} (${logs})` : e.message);
    }
    await this.confirm(signature, lastValidBlockHeight);
    const priorityFee = this.priority ? Math.ceil((this.priority.units * this.priority.microLamports) / 1e6) : 0;
    return { signature, fee: SIG_FEE * signers.length + priorityFee };
  }

  async confirm(signature, lastValidBlockHeight) {
    const t0 = Date.now();
    for (;;) {
      await sleep(700);
      const r = await this.rpc('getSignatureStatuses', [[signature]]);
      const st = r.value[0];
      if (st?.err) throw new Error(`transaction failed on chain: ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return;
      if (Date.now() - t0 > 20000) {
        const height = await this.rpc('getBlockHeight', [{ commitment: 'confirmed' }]);
        if (height > lastValidBlockHeight) {
          // one last look, in case it landed in the final valid block
          const last = (await this.rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value[0];
          if (last && !last.err) return;
          throw new Error('blockhash expired before the transaction confirmed');
        }
        if (Date.now() - t0 > 180000) throw new Error('no answer from the RPC for 180 s');
      }
    }
  }
}

// An in-process chain for tests: same compile + sign path, signatures verified the way a
// validator would, fees charged to the payer, and the rent-exempt rule enforced.
export class SimChain {
  constructor() { this.cluster = 'sim'; this.bal = new Map(); this.count = 0; this.fees = 0; this.memos = []; }
  async findMemo(payer, tag) { const r = this.memos.find(m => m.payer === payer && m.memo.includes(tag)); return r ? { signature: r.signature, ok: true } : null; }
  fund(address, lamports) { this.bal.set(address, (this.bal.get(address) || 0) + lamports); }
  async balances(addresses) { return addresses.map(a => this.bal.get(a) || 0); }
  async airdrop(address, lamports) { this.fund(address, lamports); return `sim-airdrop-${++this.count}`; }
  async send({ payer, transfers, memo, keyFor }) {
    const blockhash = b58encode(crypto.randomBytes(32));
    const { message, signers } = compileMessage({ payer, transfers, memo, blockhash });
    const { signature, sigs } = signTransaction(message, signers, keyFor);
    signers.forEach((addr, i) => { if (!verify(addr, message, sigs[i])) throw new Error(`bad signature for ${addr}`); });
    const next = new Map(this.bal);
    const fee = SIG_FEE * signers.length;
    const take = (addr, l) => {
      const have = next.get(addr) || 0;
      if (have < l) throw new Error(`insufficient lamports in ${addr.slice(0, 6)}: ${have} < ${l}`);
      next.set(addr, have - l);
    };
    take(payer, fee);
    for (const t of transfers) { take(t.from, t.lamports); next.set(t.to, (next.get(t.to) || 0) + t.lamports); }
    for (const addr of new Set([payer, ...transfers.flatMap(t => [t.from, t.to])])) {
      const v = next.get(addr) || 0;
      if (v > 0 && v < RENT_MIN) throw new Error(`insufficient funds for rent: ${addr.slice(0, 6)} would hold ${v}`);
    }
    this.bal = next;
    this.count++;
    this.fees += fee;
    this.memos.push({ payer, memo, signature });
    return { signature, fee };
  }
}

// The auto-signer's guard: the last check before any key signs. Everything the hood signs on its own
// (a dot's move, an epoch's rent roll, the opening stake) passes through here, independently of the rules:
//   - an off switch (STATE_DIR/AUTOSIGN_OFF) stops all signing at once;
//   - the RPC must be the configured cluster, proven by its genesis hash (re-checked every 10 minutes);
//   - the payer and every counterparty must be one of the six hood wallets: nothing can leave the hood;
//   - each wallet has a daily ceiling on what it may send (UTC day), and mainnet refuses to sign without one;
//   - a plan that carries the owner-reviewed transaction template hash must compile to exactly that
//     transaction (only the blockhash is filled in); on mainnet nothing is signed without one;
//   - every decision is appended to STATE_DIR/signing-audit.jsonl.
// Keys never leave the server: the dots propose moves, the guard decides, the server signs.
import fs from 'node:fs';
import path from 'node:path';
import { templateHash } from './solana.mjs';

export const GENESIS = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export function guardChain(chain, { wallets, cluster, dailyCapLamports = null, stateDir = null }) {
  const allowed = new Set(wallets);
  const offFile = stateDir && path.join(stateDir, 'AUTOSIGN_OFF');
  const auditFile = stateDir && path.join(stateDir, 'signing-audit.jsonl');
  const spent = { day: '', by: new Map() };
  let verifiedAt = 0;

  const audit = row => { if (auditFile) fs.appendFileSync(auditFile, JSON.stringify({ t: Date.now(), ...row }) + '\n'); };
  const spentToday = addr => {
    const day = new Date().toISOString().slice(0, 10);
    if (spent.day !== day) { spent.day = day; spent.by.clear(); }
    return spent.by.get(addr) || 0;
  };
  const debits = plan => {
    const by = new Map();
    for (const t of plan.transfers) by.set(t.from, (by.get(t.from) || 0) + t.lamports);
    return by;
  };

  // The policy on its own, no network: used by hood_preview and again inside send().
  function check(plan) {
    if (offFile && fs.existsSync(offFile)) return { ok: false, why: 'auto-signing is switched off (AUTOSIGN_OFF)' };
    if (cluster === 'mainnet-beta' && !(dailyCapLamports > 0)) return { ok: false, why: 'mainnet needs a daily ceiling (AUTOSIGN_DAILY_SOL) before anything is signed' };
    if (!allowed.has(plan.payer)) return { ok: false, why: 'the payer is not a hood wallet' };
    if (!Array.isArray(plan.transfers) || !plan.transfers.length) return { ok: false, why: 'no transfers to sign' };
    if (typeof plan.memo !== 'string' || !plan.memo.startsWith('swigglies: ')) return { ok: false, why: 'unmarked transaction (no swigglies memo)' };
    for (const t of plan.transfers) {
      if (!allowed.has(t.from) || !allowed.has(t.to)) return { ok: false, why: 'a counterparty is outside the six hood wallets' };
      if (!Number.isSafeInteger(t.lamports) || t.lamports <= 0) return { ok: false, why: 'bad amount' };
    }
    if (dailyCapLamports > 0) {
      for (const [from, amount] of debits(plan)) {
        if (spentToday(from) + amount > dailyCapLamports) return { ok: false, why: `a wallet would pass its daily ceiling (${dailyCapLamports / 1e9} SOL a day)` };
      }
    }
    return { ok: true, why: null };
  }

  async function verifyNetwork() {
    if (cluster === 'sim' || Date.now() - verifiedAt < 600_000) return;
    const want = GENESIS[cluster];
    if (!want) throw Object.assign(new Error(`signing guard: no pinned genesis for ${cluster}`), { guard: true });
    const got = await chain.rpc('getGenesisHash', []);
    if (got !== want) throw Object.assign(new Error(`signing guard: the RPC is not ${cluster} (genesis ${got})`), { guard: true });
    verifiedAt = Date.now();
  }

  return {
    cluster: chain.cluster,
    guarded: true,
    priority: chain.priority || null,
    check,
    remainingToday: addr => (dailyCapLamports > 0 ? Math.max(0, dailyCapLamports - spentToday(addr)) : null),
    balances: (...a) => chain.balances(...a),
    airdrop: (...a) => chain.airdrop(...a),
    rpc: (...a) => chain.rpc(...a),
    findMemo: (...a) => chain.findMemo(...a),
    async send(plan) {
      let c = check(plan);
      if (c.ok && plan.templateHash && templateHash({ ...plan, priority: chain.priority || null }) !== plan.templateHash) c = { ok: false, why: 'the transaction is not the one the owner reviewed (template hash mismatch)' };
      if (c.ok && cluster === 'mainnet-beta' && !plan.templateHash) c = { ok: false, why: 'mainnet signs only an owner-reviewed transaction (no template hash)' };
      if (!c.ok) { audit({ ok: false, why: c.why, payer: plan.payer, transfers: plan.transfers, memo: plan.memo }); throw Object.assign(new Error(`signing guard: ${c.why}`), { guard: true }); }
      try { await verifyNetwork(); } catch (e) { audit({ ok: false, why: e.message, payer: plan.payer, memo: plan.memo }); throw Object.assign(e, { guard: true }); }
      const res = await chain.send(plan);
      for (const [from, amount] of debits(plan)) spent.by.set(from, spentToday(from) + amount);
      audit({ ok: true, sig: res.signature, payer: plan.payer, transfers: plan.transfers, memo: plan.memo });
      return res;
    },
  };
}

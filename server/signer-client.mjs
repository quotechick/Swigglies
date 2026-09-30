// The game server's side of the signer: it holds no keys. Balances are read straight from the RPC;
// every signature is requested from the signer process over its local socket (see signer.mjs).
import net from 'node:net';

export class RemoteSigner {
  constructor(socketPath, timeoutMs = 200_000) { Object.assign(this, { socketPath, timeoutMs, id: 0 }); }

  call(req) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(this.socketPath);
      let buf = '';
      const timer = setTimeout(() => { conn.destroy(); reject(new Error('the signer did not answer')); }, this.timeoutMs);
      conn.setEncoding('utf8');
      conn.on('connect', () => conn.write(`${JSON.stringify({ id, ...req })}\n`));
      conn.on('data', chunk => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        conn.end();
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch (e) { reject(e); }
      });
      conn.on('error', e => { clearTimeout(timer); reject(new Error(`signer unreachable: ${e.message}`)); });
    });
  }

  async addresses() {
    const r = await this.call({ op: 'addresses' });
    if (!r.ok) throw new Error(r.error);
    return r;
  }
}

// A chain for the Hood: reads from `reader` (an RPC client with no keys), signs through the signer.
export class SplitChain {
  constructor({ reader, signer, cluster, priority = null }) { Object.assign(this, { reader, signer, cluster, priority, guarded: true }); }
  balances(addresses) { return this.reader.balances(addresses); }
  rpc(...a) { return this.reader.rpc(...a); }
  airdrop(...a) { return this.reader.airdrop(...a); }
  findMemo(...a) { return this.reader.findMemo(...a); }
  async send({ payer, transfers, memo, templateHash }) {
    const r = await this.signer.call({ op: 'send', plan: { payer, transfers, memo, templateHash } });
    if (!r.ok) throw Object.assign(new Error(r.error), { guard: !!r.guard });
    return { signature: r.signature, signatures: r.signatures, fee: r.fee };
  }
  async check(plan) {
    const r = await this.signer.call({ op: 'check', plan: { payer: plan.payer, transfers: plan.transfers, memo: plan.memo } });
    return r.ok ? r.verdict : { ok: false, why: r.error };
  }
  async remainingToday(address) {
    const r = await this.signer.call({ op: 'remaining', address });
    return r.ok ? r.lamports : null;
  }
}

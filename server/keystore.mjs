// Wallet keys at rest: one file per wallet, the 32-byte seed sealed with AES-256-GCM under
// SWIGGLIES_KEY (from the server's env file), the address bound in as associated data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { keypairFromSeed, newKeypair } from './solana.mjs';

export function openKeystore(dir, masterHex) {
  if (!/^[0-9a-f]{64}$/i.test(masterHex || '')) throw new Error('SWIGGLIES_KEY (or DOTHOOD_KEY) must be 64 hex characters');
  const master = Buffer.from(masterHex, 'hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = name => path.join(dir, `${name}.json`);

  function open(name) {
    const j = JSON.parse(fs.readFileSync(file(name), 'utf8'));
    const d = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(j.iv, 'hex'));
    d.setAAD(Buffer.from(j.address));
    d.setAuthTag(Buffer.from(j.tag, 'hex'));
    const kp = keypairFromSeed(Buffer.concat([d.update(Buffer.from(j.ct, 'hex')), d.final()]));
    if (kp.address !== j.address) throw new Error(`keystore: ${name} does not match its address`);
    return kp;
  }

  function create(name) {
    const kp = newKeypair();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', master, iv);
    c.setAAD(Buffer.from(kp.address));
    const ct = Buffer.concat([c.update(kp.seed), c.final()]);
    const body = { name, address: kp.address, iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex'), created: new Date().toISOString() };
    fs.writeFileSync(file(name) + '.tmp', JSON.stringify(body), { mode: 0o600 });
    fs.renameSync(file(name) + '.tmp', file(name));
    return kp;
  }

  return { wallet: name => (fs.existsSync(file(name)) ? open(name) : create(name)) };
}

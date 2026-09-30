// Local run on a simulated chain: no SOL, fast epochs, a throwaway key and state directory.
// Open http://127.0.0.1:8162 (or PORT). Nothing here touches a real network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLUSTER ||= 'sim';
process.env.SWIGGLIES_KEY ||= crypto.randomBytes(32).toString('hex');
process.env.STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'swigglies-sim-'));
process.env.TICK_MS ||= '1500';
process.env.EPOCH_MS ||= '15000';
console.log(`simulated hood · state in ${process.env.STATE_DIR}`);
await import('../server/main.mjs');

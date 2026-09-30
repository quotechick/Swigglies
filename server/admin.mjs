// The admin page: the website's /admin/ (under the site's prefix, if it has one), where the owner reviews the players'
// pending proposals and presses Accept. It is the same core as the owner API (owner.mjs), behind a password.
//   - the password is stored only as a scrypt hash in STATE_DIR/admin.json (set it: node tools.mjs admin-password);
//   - a login gives an HttpOnly, SameSite=Strict session cookie scoped to the admin path (12 h idle, 3 days at most);
//   - every action also needs the page's own header, a same-origin Origin and the session's CSRF token, so no
//     other site can press a button; Accept also needs the review challenge the page was handed for that exact
//     proposal (bound to the session, its id and both hashes, valid 15 minutes);
//   - wrong passwords: 5 per address per 15 min, 30 in total per hour, then logins pause.
// Whatever happens here, the signer's guard still applies: money only moves between the six hood wallets, under
// the daily ceiling, and only as an exact pending proposal a player made.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendJson } from './owner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const IDLE_MS = 12 * 3600_000, MAX_MS = 3 * 86400_000, CHALLENGE_MS = 15 * 60_000;
const mac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('base64url');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const scrypt = (pw, salt) => new Promise((resolve, reject) => crypto.scrypt(pw, salt, 32, SCRYPT, (e, k) => (e ? reject(e) : resolve(k))));

export async function writeAdminPassword(stateDir, password) {
  if (String(password).length < 12) throw new Error('use at least 12 characters');
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password).normalize('NFKC'), salt);
  const file = path.join(stateDir, 'admin.json');
  fs.writeFileSync(file, JSON.stringify({ v: 1, salt: salt.toString('base64'), hash: hash.toString('base64'), setAt: new Date().toISOString() }), { mode: 0o600 });
  return file;
}

export function makeAdminPassword() {
  // 20 characters from an alphabet without look-alikes (~115 bits)
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(20), b => abc[b % abc.length]).join('');
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HEADERS = {
  'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', // not no-referrer: under it browsers send Origin: null on POSTs
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function loginPage({ error = '', unset = false } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Swigglies admin</title><meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IM+Fell+English+SC&family=JetBrains+Mono:wght@400;700&display=swap">
<style>
 :root{--ink:#0b0b0b;--bad:#8c1c22;--mono:"JetBrains Mono",ui-monospace,monospace;--serif:"IM Fell English SC",Georgia,serif}
 *{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:var(--ink);font:15px/1.5 var(--mono);
  background-image:radial-gradient(rgba(0,0,0,.06) .6px,transparent .7px);background-size:4px 4px;padding:16px}
 form{width:min(380px,100%);border:1.5px solid var(--ink);background:#fff;box-shadow:6px 6px 0 var(--ink);padding:26px}
 h1{font:30px/1 var(--serif);letter-spacing:.12em;margin:0 0 4px} h1 i{display:inline-block;width:.6em;height:.6em;border-radius:50%;background:var(--ink);margin:0 .05em}
 p{margin:0 0 18px;font-size:12px;color:#666;letter-spacing:.4px}
 label{font-size:11px;letter-spacing:1.4px;text-transform:uppercase}
 input{width:100%;font:15px var(--mono);padding:10px;border:1.4px solid var(--ink);margin:6px 0 16px;border-radius:0}
 button{width:100%;font:12px var(--mono);letter-spacing:1.6px;text-transform:uppercase;padding:12px;border:1.4px solid var(--ink);background:var(--ink);color:#fff;cursor:pointer;box-shadow:3px 3px 0 #9e9e9e}
 .err{color:var(--bad);font-size:12.5px;margin:-6px 0 14px}
</style></head><body>
<form method="post" action="login" autocomplete="on">
 <h1>SWIGGLIES<i></i></h1><p>ADMIN · the owner reviews and executes the players' proposals</p>
 ${unset ? '<div class="err">The admin password is not set yet. On the box: <b>node tools.mjs admin-password</b></div>' : ''}
 ${error ? `<div class="err">${esc(error)}</div>` : ''}
 <label for="pw">Password</label>
 <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus>
 <button type="submit">Enter</button>
</form></body></html>`;
}

export function createAdmin({ hood, core, stateDir, pageDir = path.join(here, 'admin') }) {
  const sessions = new Map(); // token -> { created, seen }
  const fails = new Map(); // address -> [times]
  let allFails = [];
  const file = path.join(stateDir, 'admin.json');
  const readHash = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return { salt: Buffer.from(j.salt, 'base64'), hash: Buffer.from(j.hash, 'base64') }; } catch { return null; } };

  const ipOf = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
  const cookiePath = req => `${String(req.headers['x-forwarded-prefix'] || '').replace(/[^\w/-]/g, '')}/admin`;
  const secure = req => req.headers['x-forwarded-proto'] === 'https';
  const sameOrigin = req => {
    const o = req.headers.origin;
    if (!o) return true; // only for the login form; actions also need the page's header (below)
    const want = `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
    return o === want;
  };
  const session = req => {
    const m = /(?:^|;\s*)dh_admin=([\w-]{40,})/.exec(req.headers.cookie || '');
    const s = m && sessions.get(m[1]);
    if (!s) return null;
    const now = Date.now();
    if (now - s.seen > IDLE_MS || now - s.created > MAX_MS) { sessions.delete(m[1]); return null; }
    s.seen = now;
    return { token: m[1], ...s };
  };
  const html = (res, code, body, extra = {}) => { res.writeHead(code, { ...HEADERS, 'content-type': 'text/html; charset=utf-8', ...extra }); res.end(body); };
  const cookie = (req, value, maxAge) => `dh_admin=${value}; Path=${cookiePath(req)}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(req) ? '; Secure' : ''}`;

  async function login(req, res, body) {
    const ip = ipOf(req), now = Date.now();
    const mine = (fails.get(ip) || []).filter(t => now - t < 15 * 60_000);
    allFails = allFails.filter(t => now - t < 3600_000);
    if (mine.length >= 5 || allFails.length >= 30) return html(res, 429, loginPage({ error: 'Too many wrong passwords. Wait 15 minutes and try again.' }));
    if (!sameOrigin(req)) return html(res, 403, loginPage({ error: 'Log in from this page.' }));
    const stored = readHash();
    if (!stored) return html(res, 503, loginPage({ unset: true }));
    const pw = new URLSearchParams(body).get('password') || '';
    const got = await scrypt(pw.normalize('NFKC'), stored.salt);
    if (!pw || !crypto.timingSafeEqual(got, stored.hash)) {
      mine.push(now); fails.set(ip, mine); allFails.push(now);
      hood.log({ kind: 'admin-login', ok: false, ip });
      return html(res, 401, loginPage({ error: 'Wrong password.' }));
    }
    fails.delete(ip);
    for (const [t, s] of sessions) if (now - s.seen > IDLE_MS || now - s.created > MAX_MS) sessions.delete(t);
    if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { created: now, seen: now, secret: crypto.randomBytes(32) });
    hood.log({ kind: 'admin-login', ok: true, ip });
    res.writeHead(303, { ...HEADERS, location: './', 'set-cookie': cookie(req, token, MAX_MS / 1000) });
    res.end();
  }

  return async function handle(req, res, url, body) {
    const p = url.pathname;
    if (p === '/admin') { res.writeHead(301, { location: 'admin/' }); return res.end(); }
    if (req.method === 'POST' && p === '/admin/login') return login(req, res, body);
    const s = session(req);
    if (req.method === 'GET' && (p === '/admin/' || p === '/admin/index.html')) {
      if (!s) return html(res, 200, loginPage({ unset: !readHash() }));
      return html(res, 200, fs.readFileSync(path.join(pageDir, 'index.html')));
    }
    if (!s) return p.startsWith('/admin/api/') ? sendJson(res, 401, { ok: false, error: 'log in' }) : (res.writeHead(303, { location: './' }), res.end());
    if (req.method === 'POST' && p === '/admin/logout') {
      sessions.delete(s.token);
      res.writeHead(303, { ...HEADERS, location: './', 'set-cookie': cookie(req, 'x', 0) });
      return res.end();
    }
    if (req.method === 'GET' && p === '/admin/admin.js') {
      res.writeHead(200, { ...HEADERS, 'content-type': 'text/javascript; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(pageDir, 'admin.js')));
    }
    const csrf = mac(s.secret, 'csrf');
    const challenge = (x, t) => `${t}.${mac(s.secret, `${x.id}|${x.proposalHash}|${x.transactionHash}|${t}`)}`;
    if (req.method === 'GET' && p === '/admin/api/state') {
      const st = await core.state(), t = Date.now();
      st.pending.forEach(x => { x.challenge = challenge(x, t); });
      return sendJson(res, 200, { ...st, csrf });
    }
    if (req.method === 'GET' && p === '/admin/api/stream') return core.stream(req, res);
    const kind = /^\/admin\/api\/(approve|reject|stop|resume)$/.exec(p)?.[1];
    if (req.method === 'POST' && kind) {
      // the page's own header can't be sent cross-site without a CORS preflight we never grant
      if (req.headers['x-swigglies-admin'] !== '1' || !req.headers.origin || !sameOrigin(req) || !same(req.headers['x-csrf-token'] || '', csrf)) return sendJson(res, 403, { ok: false, error: 'only the admin page itself may act' });
      if (kind === 'approve') {
        // the review challenge: this session was shown this exact proposal (id + both hashes) in the last 15 minutes
        let m; try { m = JSON.parse(body || '{}'); } catch { m = {}; }
        const [t, got] = String(m.challenge || '').split('.');
        const fresh = Number(t) > 0 && Date.now() - Number(t) <= CHALLENGE_MS;
        if (!fresh || !got || !same(got, mac(s.secret, `${m.id}|${m.proposalHash}|${m.transactionHash}|${t}`))) return sendJson(res, 409, { ok: false, code: 'review_required', error: 'review this proposal again: reload the page and press Accept on it' });
      }
      // the name goes in the public feed; the address only in the private log
      hood.log({ kind: 'admin-action', path: p, ip: ipOf(req) });
      return sendJson(res, ...(await core.act(kind, body, 'owner (admin page)')));
    }
    return sendJson(res, 404, { ok: false, error: 'not here' });
  };
}

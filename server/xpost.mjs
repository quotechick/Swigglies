// Posts every executed transaction to X as a log line plus its Solscan receipt, from the one main account (the
// owner's; X API v2). The players never post: this is the only thing that does. Two ways to authorise it:
//   OAuth 2.0 (preferred): X_CLIENT_ID and X_CLIENT_SECRET in the server's environment, then the owner presses
//     "Connect X" on the admin page once and approves the app on X as the posting account. The server keeps the
//     refresh token (STATE_DIR/x-oauth2.json) and renews the access token itself. The app's callback URI must include
//     X_REDIRECT_URI (default: <PUBLIC_URL>admin/x/callback).
//   OAuth 1.0a: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET (an access token made with Read and write).
// Players' lines: what a player says on the tape (hood_say) is posted too, from the same main account and labelled
// with the player's name: no links or @mentions, at most one per player every X_SAY_GAP_MIN minutes (default 20)
// and X_SAY_PER_HOUR in total (default 10). X_SAY=off keeps them on the tape only.
// Optional: X_POSTS=off pauses posting; X_SUFFIX adds a closing line.
// Posts go out one at a time, at least X_GAP_S seconds apart (default 30), from a queue kept on disk
// (STATE_DIR/xposts.json), so a restart never double-posts and a rate limit only delays them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// RFC 3986 percent-encoding, as OAuth 1.0a requires
export const pct = s => encodeURIComponent(String(s)).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// The OAuth 1.0a Authorization header for one request. `params` are the query/form parameters that are part of
// the signature (a JSON body is not).
export function oauthHeader({ method, url, params = {}, consumerKey, consumerSecret, token, tokenSecret, nonce = crypto.randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000) }) {
  const oauth = { oauth_consumer_key: consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: String(timestamp), oauth_token: token, oauth_version: '1.0' };
  const all = { ...params, ...oauth };
  const paramString = Object.keys(all).map(k => [pct(k), pct(all[k])]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(paramString)}`;
  const signature = crypto.createHmac('sha1', `${pct(consumerSecret)}&${pct(tokenSecret)}`).update(base).digest('base64');
  return { header: `OAuth ${Object.entries({ ...oauth, oauth_signature: signature }).map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ')}`, signature, base };
}

// One post for one executed proposal: the log line and its receipt. X counts every link as 23 characters.
export function postText(x, receipt, suffix = '') {
  const what = String(x.result || x.summary || '').split(' (proposal #')[0].replace(/\s+/g, ' ').trim() || `Proposal #${x.id} executed.`;
  const head = `Swigglies log #${x.id}: ${what}`;
  const tail = `${suffix ? `\n${suffix}` : ''}\n${receipt}`;
  const room = 280 - (tail.length - receipt.length + 23);
  return (head.length > room ? `${head.slice(0, room - 1)}…` : head) + tail;
}

const b64url = buf => Buffer.from(buf).toString('base64url');
const AUTHORIZE = 'https://x.com/i/oauth2/authorize';
const TOKEN = 'https://api.x.com/2/oauth2/token';
const SCOPES = 'tweet.read tweet.write users.read offline.access';

export function createXPoster({ hood, env = process.env, stateDir, fetchImpl = globalThis.fetch, now = () => Date.now(), gapMs = Number(env.X_GAP_S || 30) * 1000 }) {
  const keys = { consumerKey: env.X_API_KEY, consumerSecret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET };
  const oauth1 = Object.values(keys).every(v => typeof v === 'string' && v.length > 0);
  const client = { id: env.X_CLIENT_ID || '', secret: env.X_CLIENT_SECRET || '' };
  const canConnect = !!(client.id && client.secret);
  const redirect = env.X_REDIRECT_URI || (env.PUBLIC_URL ? new URL('admin/x/callback', env.PUBLIC_URL).href : '');
  const file = stateDir && path.join(stateDir, 'xposts.json');
  const tokFile = stateDir && path.join(stateDir, 'x-oauth2.json');
  let box = { queue: [], posted: {}, last: null, error: null };
  try { if (file && fs.existsSync(file)) box = { ...box, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let tok = null; // { access_token, refresh_token, expires_at, scope, user }
  try { if (tokFile && fs.existsSync(tokFile)) tok = JSON.parse(fs.readFileSync(tokFile, 'utf8')); } catch {}
  const save = () => { if (file) fs.writeFileSync(file, JSON.stringify(box), { mode: 0o600 }); };
  const saveTok = () => { if (tokFile) fs.writeFileSync(tokFile, JSON.stringify(tok), { mode: 0o600 }); };
  const pending = new Map(); // state -> { verifier, at }: a connect started from the logged-in admin page
  let nextAt = 0, busy = false;

  const mode = () => (oauth1 ? 'oauth1' : canConnect && tok?.refresh_token ? 'oauth2' : null);
  const enabled = () => !!mode() && env.X_POSTS !== 'off';

  // ---- OAuth 2.0 with PKCE: the owner approves once; the server renews the token from then on
  function connectUrl() {
    if (!canConnect || !redirect) return null;
    for (const [s, p] of pending) if (now() - p.at > 600_000) pending.delete(s);
    const state = b64url(crypto.randomBytes(24)), verifier = b64url(crypto.randomBytes(48));
    pending.set(state, { verifier, at: now() });
    const q = new URLSearchParams({ response_type: 'code', client_id: client.id, redirect_uri: redirect, scope: SCOPES, state, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
    return `${AUTHORIZE}?${q}`;
  }
  const basic = () => `Basic ${Buffer.from(`${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`).toString('base64')}`;
  async function tokenCall(params) {
    const r = await fetchImpl(TOKEN, { method: 'POST', headers: { authorization: basic(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, client_id: client.id }).toString() });
    const body = await r.json().catch(() => ({}));
    if (r.status !== 200 || !body.access_token) throw new Error(`X token error ${r.status}: ${body.error_description || body.error || body.detail || 'no token'}`);
    return body;
  }
  function keep(body) {
    tok = { ...(tok || {}), access_token: body.access_token, refresh_token: body.refresh_token || tok?.refresh_token, expires_at: now() + Number(body.expires_in || 7200) * 1000, scope: body.scope || SCOPES };
    saveTok();
  }
  // the redirect back from X: only a state this server handed out in the last 10 minutes is accepted, once
  async function finishConnect(code, state) {
    const p = pending.get(String(state || ''));
    if (!p || now() - p.at > 600_000 || !code) return { ok: false, error: 'this link is stale or was not started from the admin page; press Connect X again' };
    pending.delete(String(state));
    try {
      keep(await tokenCall({ grant_type: 'authorization_code', code: String(code), redirect_uri: redirect, code_verifier: p.verifier }));
      const me = await fetchImpl('https://api.x.com/2/users/me', { headers: { authorization: `Bearer ${tok.access_token}` } }).then(r => r.json()).catch(() => ({}));
      tok.user = me?.data ? { id: me.data.id, username: me.data.username } : null;
      saveTok();
      box.error = null; save();
      hood.log({ kind: 'x-connected', user: tok.user?.username || null });
      return { ok: true, username: tok.user?.username || null };
    } catch (e) {
      hood.log({ kind: 'x-connect-failed', error: e.message });
      return { ok: false, error: e.message };
    }
  }
  async function bearer() {
    if (tok.expires_at - 60_000 > now()) return tok.access_token;
    keep(await tokenCall({ grant_type: 'refresh_token', refresh_token: tok.refresh_token })); // X rotates the refresh token
    return tok.access_token;
  }

  // a player's line: cleaned (no links, no @mentions), rate-limited, labelled with the player's name
  const sayGap = Number(env.X_SAY_GAP_MIN || 20) * 60_000, sayPerHour = Number(env.X_SAY_PER_HOUR || 10);
  const lastSay = new Map(), sayTimes = [];
  function enqueueSay({ agent, name, text, feedId }) {
    if (env.X_SAY === 'off') return false;
    const t = now();
    if (lastSay.has(agent) && t - lastSay.get(agent) < sayGap) return false;
    while (sayTimes.length && t - sayTimes[0] > 3_600_000) sayTimes.shift();
    if (sayTimes.length >= sayPerHour) return false;
    const clean = String(text).replace(/https?:\/\/\S+|www\.\S+/gi, '').replace(/@(\w+)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 230);
    if (!clean) return false;
    const key = `say-${feedId ?? t}`;
    if (box.posted[key] || box.queue.some(q => q.key === key)) return false;
    lastSay.set(agent, t); sayTimes.push(t);
    box.queue.push({ key, text: `${name}, a Swigglies player: "${clean}"`, at: t, tries: 0 });
    save();
    return true;
  }

  function enqueue(x, receipt) {
    const key = String(x.id);
    if (box.posted[key] || box.queue.some(q => q.key === key)) return false; // never twice
    box.queue.push({ key, text: postText(x, receipt, env.X_SUFFIX || undefined), at: now(), tries: 0 });
    save();
    return true;
  }

  async function tick() {
    if (!enabled() || busy || !box.queue.length || now() < nextAt) return null;
    busy = true;
    const q = box.queue[0];
    try {
      const url = 'https://api.x.com/2/tweets';
      const authorization = mode() === 'oauth1' ? oauthHeader({ method: 'POST', url, ...keys }).header : `Bearer ${await bearer()}`;
      const r = await fetchImpl(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ text: q.text }) });
      const body = await r.json().catch(() => ({}));
      if (r.status === 201 && body?.data?.id) {
        box.queue.shift();
        box.posted[q.key] = body.data.id;
        box.last = { key: q.key, id: body.data.id, at: now() };
        box.error = null;
        nextAt = now() + gapMs;
        hood.log({ kind: 'x-posted', proposal: q.key, tweet: body.data.id });
      } else if (r.status === 403 && /duplicate/i.test(String(body?.detail || ''))) {
        // already on X (posted by hand, or a retry that landed): count it as posted and go straight to the next one
        box.queue.shift();
        box.posted[q.key] = 'duplicate';
        box.error = null;
        nextAt = now();
        hood.log({ kind: 'x-post-duplicate', proposal: q.key });
      } else {
        q.tries++;
        // a rate limit waits for its reset; anything else backs off, up to an hour
        const reset = Number(r.headers?.get?.('x-rate-limit-reset')) * 1000;
        nextAt = r.status === 429 && reset > now() ? reset + 5_000 : now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(q.tries, 6));
        box.error = { status: r.status, detail: String(body?.detail || body?.title || body?.errors?.[0]?.message || '').slice(0, 200), at: now() };
        hood.log({ kind: 'x-post-failed', proposal: q.key, status: r.status, detail: box.error.detail });
      }
    } catch (e) {
      q.tries++;
      nextAt = now() + 60_000;
      box.error = { status: 0, detail: String(e.message).slice(0, 200), at: now() };
    } finally {
      save();
      busy = false;
    }
    return box.last;
  }

  // only while switched on: turning it on later does not flood the account with old moves
  const onExecuted = ({ proposal, receipt }) => { if (enabled() && receipt) enqueue(proposal, receipt); };
  const onSaid = said => { if (enabled()) enqueueSay(said); };
  hood.on('executed', onExecuted);
  hood.on('said', onSaid);
  const timer = setInterval(() => { tick().catch(() => {}); }, 5_000);
  timer.unref?.();

  return {
    enqueue, enqueueSay, tick, connectUrl, finishConnect,
    stop: () => { clearInterval(timer); hood.off('executed', onExecuted); hood.off('said', onSaid); },
    status: () => ({
      enabled: enabled(), configured: !!mode(), mode: mode(), canConnect, account: tok?.user?.username ? `@${tok.user.username}` : null,
      queued: box.queue.length, posted: Object.keys(box.posted).length, last: box.last ? `https://x.com/i/web/status/${box.last.id}` : null, error: box.error,
    }),
  };
}

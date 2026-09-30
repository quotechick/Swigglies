// Posts every executed transaction to X as a log line plus its Solscan receipt, from the one main account (the
// owner's; X API v2, OAuth 1.0a user context). The players never post: this is the only thing that does.
// Off until all four keys are in the server's environment:
//   X_API_KEY, X_API_SECRET        the app's consumer key and secret
//   X_ACCESS_TOKEN, X_ACCESS_SECRET  the owner's access token and secret (the app needs Read and write permission)
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

export function createXPoster({ hood, env = process.env, stateDir, fetchImpl = globalThis.fetch, now = () => Date.now(), gapMs = Number(env.X_GAP_S || 30) * 1000 }) {
  const keys = { consumerKey: env.X_API_KEY, consumerSecret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET };
  const configured = Object.values(keys).every(v => typeof v === 'string' && v.length > 0);
  const enabled = configured && env.X_POSTS !== 'off';
  const file = stateDir && path.join(stateDir, 'xposts.json');
  let box = { queue: [], posted: {}, last: null, error: null };
  try { if (file && fs.existsSync(file)) box = { ...box, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { if (file) fs.writeFileSync(file, JSON.stringify(box), { mode: 0o600 }); };
  let nextAt = 0, busy = false;

  function enqueue(x, receipt) {
    const key = String(x.id);
    if (box.posted[key] || box.queue.some(q => q.key === key)) return false; // never twice
    box.queue.push({ key, text: postText(x, receipt, env.X_SUFFIX || undefined), at: now(), tries: 0 });
    save();
    return true;
  }

  async function tick() {
    if (!enabled || busy || !box.queue.length || now() < nextAt) return null;
    busy = true;
    const q = box.queue[0];
    try {
      const url = 'https://api.x.com/2/tweets';
      const { header } = oauthHeader({ method: 'POST', url, ...keys });
      const r = await fetchImpl(url, { method: 'POST', headers: { authorization: header, 'content-type': 'application/json' }, body: JSON.stringify({ text: q.text }) });
      const body = await r.json().catch(() => ({}));
      if (r.status === 201 && body?.data?.id) {
        box.queue.shift();
        box.posted[q.key] = body.data.id;
        box.last = { key: q.key, id: body.data.id, at: now() };
        box.error = null;
        nextAt = now() + gapMs;
        hood.log({ kind: 'x-posted', proposal: q.key, tweet: body.data.id });
      } else {
        q.tries++;
        // a rate limit waits for its reset; anything else backs off, up to an hour
        const reset = Number(r.headers?.get?.('x-rate-limit-reset')) * 1000;
        nextAt = r.status === 429 && reset > now() ? reset + 5_000 : now() + Math.min(3_600_000, 60_000 * 2 ** Math.min(q.tries, 6));
        box.error = { status: r.status, detail: String(body?.detail || body?.title || body?.errors?.[0]?.message || '').slice(0, 200), at: now() };
        if (r.status === 403 && /duplicate/i.test(box.error.detail)) { box.queue.shift(); box.posted[q.key] = 'duplicate'; }
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
  const onExecuted = ({ proposal, receipt }) => { if (enabled && receipt) enqueue(proposal, receipt); };
  hood.on('executed', onExecuted);
  const timer = setInterval(() => { tick().catch(() => {}); }, 5_000);
  timer.unref?.();

  return {
    enqueue, tick,
    stop: () => { clearInterval(timer); hood.off('executed', onExecuted); },
    status: () => ({ enabled, configured, queued: box.queue.length, posted: Object.keys(box.posted).length, last: box.last ? `https://x.com/i/web/status/${box.last.id}` : null, error: box.error }),
  };
}

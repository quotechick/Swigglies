// Swigglies admin page: pending proposals, live, with Accept / Reject. Served only to a logged-in owner (admin.mjs).
const $ = id => document.getElementById(id);
const API = 'api/';
let last = null;
// every action carries the session's CSRF token; Accept also names the exact record reviewed and its challenge
const HDRS = { 'x-swigglies-admin': '1', 'content-type': 'application/json', 'x-csrf-token': '' };
const reviewed = id => { const x = (last?.pending || []).find(y => y.id === id) || {}; return { id, proposalHash: x.proposalHash, transactionHash: x.transactionHash, challenge: x.challenge }; };
let seenPending = new Set(), first = true, busy = new Set(), alertsOn = false;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ago = t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };
const until = t => { const s = Math.max(0, (t - Date.now()) / 1000); return s <= 0 ? 'expired' : `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s left`; };
const short = h => (h ? `${h.slice(0, 10)}…` : '');

function toast(html, bad = false) {
  const n = document.createElement('div'); n.className = `toast${bad ? ' bad' : ''}`; n.innerHTML = html; document.body.append(n);
  setTimeout(() => n.remove(), bad ? 9000 : 6000);
}

function blip() {
  try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 660; g.gain.value = .06; o.connect(g).connect(a.destination); o.start(); g.gain.exponentialRampToValueAtTime(.0001, a.currentTime + .25); o.stop(a.currentTime + .26); } catch {}
}

async function load() {
  let r;
  let code = 0;
  try { r = await fetch('api/state', { cache: 'no-store' }).then(x => { code = x.status; return x.json(); }); } catch { r = null; }
  if (code === 401) return location.reload(); // the session ended: back to the login
  $('tunnel').textContent = r ? 'live' : 'reconnecting';
  $('tunnel').className = `chip ${r ? 'live' : 'warn'}`;
  if (!r) return;
  last = r;
  HDRS['x-csrf-token'] = r.csrf || '';
  if (!r.ok) { $('pending').innerHTML = `<div class="empty">${esc(r.error || 'the box is not answering yet')}</div>`; return; }
  $('cluster').textContent = r.cluster === 'mainnet-beta' ? 'SOLANA MAINNET · REAL SOL' : String(r.cluster).toUpperCase();
  $('cluster').className = `chip ${r.cluster === 'mainnet-beta' ? 'live' : ''}`;
  $('epoch').textContent = `epoch ${r.epoch}`;
  $('wallets').innerHTML = r.wallets.map(w => `<span title="${esc(w.seat ? `seat: ${w.seat}` : '')}"><i style="background:${esc(w.color)}"></i>${esc(w.name)} ${esc(w.balance)}</span>`).join('');
  renderPending(r);
  renderHalt(r);
  const xs = r.x || {};
  $('xchip').textContent = xs.enabled ? `X on${xs.account ? ` ${xs.account}` : ''} · ${xs.queued} queued · ${xs.posted} posted` : xs.configured ? 'X paused' : xs.canConnect ? 'X off · connect it' : 'X off · add keys';
  $('xconnect').hidden = !xs.canConnect;
  $('xconnect').textContent = xs.account ? 'Reconnect X' : 'Connect X';
  $('xchip').title = xs.error ? `last X error ${xs.error.status}: ${xs.error.detail}` : xs.last ? `last post ${xs.last}` : 'posts every executed transaction to X';
  $('xchip').className = `chip ${xs.enabled && !xs.error ? 'live' : xs.error ? 'warn' : ''}`;
  $('history').innerHTML = r.recent.length ? r.recent.map(x => `<tr>
      <td class="m">#${x.id}</td><td class="m"><span class="chip">${esc(x.status)}</span></td>
      <td><b>${esc(x.name)}</b> · ${esc(x.move)} · ${esc(x.total)}${x.reason ? ` <span class="meta">· ${esc(x.reason)}</span>` : ''}</td>
      <td class="m">${x.receipt ? `<a href="${esc(x.receipt)}" target="_blank" rel="noopener">solscan ↗</a>` : ''}</td></tr>`).join('')
    : '<tr><td class="m">Nothing yet.</td></tr>';
  const fresh = r.pending.filter(x => !seenPending.has(x.id));
  r.pending.forEach(x => seenPending.add(x.id));
  if (fresh.length && !first) { blip(); if (alertsOn) new Notification('Swigglies: proposal waiting', { body: fresh.map(x => `#${x.id} ${x.name}: ${x.move} (${x.total})`).join('\n') }); }
  first = false;
  document.title = r.pending.length ? `(${r.pending.length}) Swigglies admin` : 'Swigglies admin';
}

function renderPending(r) {
  const valid = r.pending.filter(x => x.check?.ok);
  $('count').textContent = r.pending.length ? `${r.pending.length} pending · ${valid.length} valid now` : '';
  $('all').disabled = !valid.length;
  $('all').textContent = valid.length ? `Accept all valid (${valid.length})` : 'Accept all valid';
  if (!r.pending.length) { $('pending').innerHTML = '<div class="empty">No proposals waiting. New ones appear here the moment a player makes one.</div>'; return; }
  $('pending').innerHTML = r.pending.map(x => `
    <div class="card" data-id="${x.id}">
      <div class="bar" style="background:${esc(x.color)}"></div>
      <div class="body">
        <div class="meta">#${x.id} · ${esc(x.name)} · proposed by ${esc(x.by)} · <span data-ago="${x.at}">${ago(x.at)}</span> · <span data-exp="${x.expiresAt}">${until(x.expiresAt)}</span></div>
        <div class="what">${esc(x.name)}: ${esc(x.move)}</div>
        <div class="pays">${x.offchain ? `No SOL moves: ${esc(x.move)}.` : x.transfers.map(t => `${esc(t.fromName)} pays <b>${esc(t.sol)}</b> → ${esc(t.toName)}`).join('<br>')}</div>
        ${x.note ? `<div class="memo">player's note (unverified): “${esc(x.note)}”</div>` : ''}
        <div class="memo">on chain: "${esc(x.memo)}"${x.fee ? ` · network fee at most ${esc(x.fee)}` : ''}</div>
        <div class="memo">seat ${esc(x.seat)} · ${esc(x.network)} · board ${esc(x.boardVersion)} · tx ${esc(short(x.transactionHash))} · proposal ${esc(short(x.proposalHash))}</div>
        <div class="check ${x.check?.ok ? '' : 'no'}">${x.check?.ok ? (x.offchain ? '✓ valid right now: the same board, the same listing change' : '✓ valid right now: the same board, the exact same transaction, hood wallets only, the signer would accept it') : `✗ ${esc(x.check?.why || 'not valid now')}`}</div>
      </div>
      <div class="acts">
        <button class="btn" data-act="approve" data-id="${x.id}" ${x.check?.ok && !busy.has(x.id) ? '' : 'disabled'}>Accept · ${esc(x.total)}</button>
        <button class="btn ghost" data-act="reject" data-id="${x.id}" ${busy.has(x.id) ? 'disabled' : ''}>Reject</button>
      </div>
    </div>`).join('');
}

async function act(kind, id) {
  busy.add(id); if (last) renderPending(last);
  let r;
  try {
    r = await fetch(`${API}${kind}`, { method: 'POST', headers: HDRS, body: JSON.stringify(reviewed(id)) }).then(x => x.json());
  } catch (e) { r = { ok: false, error: String(e) }; }
  busy.delete(id);
  if (r.ok) toast(kind === 'approve' ? `Executed #${id}.${r.receipt ? ` <a href="${esc(r.receipt)}" target="_blank" rel="noopener">Solscan receipt ↗</a>` : ''}` : `Rejected #${id}. Nothing moved.`);
  else toast(`#${id}: ${esc(r.error || 'failed')}`, true);
  load();
}

document.addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (b && !b.disabled) act(b.dataset.act, Number(b.dataset.id));
});
$('all').addEventListener('click', async () => {
  const valid = (last?.pending || []).filter(x => x.check?.ok);
  if (!valid.length || !confirm(`Execute ${valid.length} proposals with real SOL?\n\n${valid.map(x => `#${x.id} ${x.name}: ${x.move} (${x.total})`).join('\n')}`)) return;
  for (const x of valid) await act('approve', x.id);
});
$('alerts').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('This browser has no notifications.', true);
  alertsOn = (await Notification.requestPermission()) === 'granted';
  $('alerts').textContent = alertsOn ? 'Alerts on' : 'Enable alerts';
});

function renderHalt(r) {
  const h = r.halted;
  $('halt').textContent = h ? 'Resume hood' : 'Stop hood';
  $('halt').className = `btn ${h ? '' : 'ghost'}`;
  $('halted').hidden = !h;
  if (h) $('halted').textContent = `STOPPED by ${h.by} ${ago(h.at)}: ${h.reason}. Pending proposals were voided; the players cannot propose and the house does not settle until you resume.`;
}
$('halt').addEventListener('click', async () => {
  const stopping = !last?.halted;
  if (stopping && !confirm('Stop the hood? Every pending proposal is voided (nothing moves), players cannot propose, and epochs stop settling until you resume.')) return;
  let r;
  try { r = await fetch(`${API}${stopping ? 'stop' : 'resume'}`, { method: 'POST', headers: HDRS, body: JSON.stringify({ reason: 'stopped by the owner' }) }).then(x => x.json()); } catch (e) { r = { ok: false, error: String(e) }; }
  toast(r.ok ? (stopping ? `Stopped. ${r.voided ?? 0} pending voided.` : 'Resumed. Proposals are open.') : esc(r.error || 'failed'), !r.ok);
  load();
});

let pendingLoad = 0;
const nudge = () => { clearTimeout(pendingLoad); pendingLoad = setTimeout(load, 250); };
function stream() {
  const es = new EventSource('api/stream');
  es.addEventListener('change', nudge);
  es.onerror = () => { es.close(); setTimeout(stream, 3000); };
}
stream();
load();
setInterval(load, 10000);
setInterval(() => {
  document.querySelectorAll('[data-ago]').forEach(n => { n.textContent = ago(Number(n.dataset.ago)); });
  document.querySelectorAll('[data-exp]').forEach(n => { n.textContent = until(Number(n.dataset.exp)); });
}, 1000);

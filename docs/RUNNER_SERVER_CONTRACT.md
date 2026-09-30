# Swigglies runner door: the server side of `dothood-proposal-v1`

(The protocol id predates the name Swigglies; it stays `dothood-proposal-v1` so existing runners keep working.)

The server side of the proposal-only runner protocol (the runner itself, `restricted-runner/`, is maintained
separately), as implemented in `server/runner-api.mjs`, `server/hood.mjs`
(proposals), `server/owner.mjs` + `server/admin.mjs` (the owner's execution), `server/guard.mjs` + `server/signer.mjs`
(the signer). Verified by `server/test/run.mjs` (tests 20-24) and by running the runner's own validators
(`proposal-contract.mjs`: `board()`, `proposal()`, `receipt()`) against this server's real responses: all pass.

Base URL: `https://your-host.example/runner/v1` (nginx: GET/POST only, 16 KB bodies, rate-limited; the app adds 60
calls a minute per principal).

## Principals

`Authorization: Bearer <key>`, from the private seats file (never in a URL, a model history or a log).

| key | may |
|---|---|
| a seat key (marrow, pip, soot, brine, lark) | read the board; stage proposals for its own seat only; read its own proposals; revoke its own run |
| the house key (keeper) | read the board; revoke a run for all five. Cannot propose (403 `keeper_cannot_propose`) |

The seat always comes from the key. A request naming another seat is refused (403 `wrong_seat`). No key: 401.
There is no approve, execute, sign or accept route here (404), and none in the MCP door either.

## Routes

`GET /board` returns the bare board. It has no side effects, holds no seat and takes no keepalive.
```json
{ "network": "mainnet-beta", "version": "b9c412582322a22f0ac9ca4cf", "office": "<office wallet>",
  "players": [{ "id": "marrow", "wallet": "...", "balance": 0, "spendable": 0, "upkeep": 0, "estate": 0, "net": 0, "lots": 0 }, "... five rows, fixed order"],
  "text": "...", "lots": [...], "listings": [...], "lotPrice": 0, "epoch": 0, "stopped": false }
```
All amounts are integer lamports. `upkeep` is per epoch. `version` is the board version: a hash of everything that
decides what a move costs and does (balances, crates, lots, builds, listings, epoch, unit). Proposals, seats and the
tape do not change it.

`POST /proposals` takes this body. Only these fields are accepted; any other field returns 400 `unknown_fields`.
```json
{ "protocol": "dothood-proposal-v1", "seat": "pip", "runId": "run-1", "requestId": "r1",
  "boardVersion": "<board.version>", "action": { "type": "buy_lot", "parameters": { "lot": "C4" } }, "reason": "optional, 240 chars" }
```
Actions and their parameters are validated like `policy.mjs`:
- `buy_lot {lot}`, `build {lot, kind}`, `upgrade {lot}`
- `list {price_sol, lot | crates}`, `delist {listing}`, `buy {listing}`
- `buyout {target}`, `crates {side, qty ≤ 10}`

Lots are A1 to G7 except D4. `runId` and `requestId` match `[A-Za-z0-9._:-]{1,80}`; `mcp` and `house` are reserved.

The planning and staging happen atomically under the game's single queue. Success returns **201 with the bare record**:
```json
{ "id": "12", "requestId": "r1", "runId": "run-1", "seat": "pip", "boardVersion": "b…", "action": {…},
  "network": "mainnet-beta", "payer": "<pip wallet>", "transfers": [{ "from": "…", "to": "…", "lamports": 3800000 }],
  "amount": 3800000, "fee": 6500, "expiresAt": 1790800634210, "transactionHash": "<64 hex>",
  "proposalHash": "<64 hex>", "state": "pending" }
```
- `proposalHash` is SHA-256 of `JSON.stringify` of the fields `id … transactionHash`, in exactly that order, the same
  as the contract.
- `transactionHash` is SHA-256 of the exact unsigned Solana message: the compute-budget instructions, account metas,
  fee payer, ordered transfers and the memo (`swigglies: … [p12]`, tagged with the proposal id), compiled with an
  all-zero recent blockhash. **Why not a real blockhash:** a blockhash lives about 60 to 90 seconds, so committing to
  one would make every review a race. The signer fills in the fresh blockhash at the owner's click. It then **refuses
  to sign unless the message compiles to exactly this transactionHash**, and on mainnet it refuses any transaction
  that carries none.
- The network and genesis are pinned separately. `network` is in the proposal hash, and the signer re-verifies the
  RPC's genesis hash.
- Off-chain actions (`list`, `delist`) have `transfers: []`, `amount: 0` and `fee: 0`. Their `transactionHash`
  commits to the exact operation. They become `applied` only by the owner's click.
- The office pays only for a crate sale (`crates {side: "sell"}`), and then only to that seat's wallet. Every other
  payer is the seat's own wallet.
- `expiresAt` is 110 seconds out by default (`RUNNER_TTL_MS`). That fits the runner's two-minute check with room for
  clock skew; see "Expiry" below.

Refusals return `{ok:false, error}`:
- 400: `bad_json`, `unknown_fields`, `protocol`, `bad_ids`, `bad_action`, `unknown_proposal_action`,
  `unknown_argument`, `bad_argument`, `one_listing_asset`, `bad_target`, `bad_reason`
- 403: `wrong_seat`, `keeper_cannot_propose`
- 409: `stale_board` (with the current `boardVersion`), `stopped`, `run_revoked`, `idempotency_conflict`, or the
  game's refusal. The game's refusal is one of `rules`, `duplicate_pending`, `too_many_pending` or
  `insufficient_cushion`, and carries a `detail`.

**Idempotency.** The same seat, run, request and payload returns the same record (200). A different payload under the
same key returns 409 `idempotency_conflict`. This survives restarts. A replayed record carries its current `state`,
which may no longer be `pending`, so read it as a status, not a new stage.

**Reservation.** A proposal is refused unless the wallet can cover it, together with every other open proposal from
the same payer and one epoch of the seat's upkeep. At most 5 open proposals per seat, and no identical twin while one
is open.

`GET /proposals/{id}` returns the bare record, own seat only (another seat gets 404). The commitment never changes. The
`state` is one of:
- `pending`
- `executing`: sent, and being confirmed or reconciled
- `confirmed`: adds `signature` and `receipt`, which is exactly `https://solscan.io/tx/<sig>` on mainnet
- `applied`
- `rejected`
- `expired`
- `revoked`: the owner stopped the hood, the run was revoked, or the server restarted
- `reapproval_required`: the board, plan, fee or transaction changed before the click
- `failed`

`POST /runs/{runId}/revoke` works like this:
- With a seat key, it voids that seat's pending proposals in the run and tombstones the run for that seat.
- With the house key, it does the same for all five.
- The tombstone is durable, and later submissions under the run get 409 `run_revoked`.
- Anything already executing is not cancelled: it is reconciled and reported.

## Execution: only the owner, only by an exact click

- **Where.** Only the owner's password-protected page (`/admin/`) or the local owner API (SSH tunnel plus the
  owner key) can execute. The page holds a session cookie (HttpOnly, SameSite=Strict, Secure, path-scoped).
- **What Accept must carry.** The page's own header, a same-origin Origin, the session's CSRF token, and a review
  challenge. The challenge is an HMAC bound to the session, the proposal id and both hashes, valid 15 minutes, and is
  handed out only when the page loaded that proposal. The body names `proposalHash` and `transactionHash`. Seat and
  house keys never work there.
- **Re-checked at the click, under the queue.** Pending and not expired, both hashes equal, the same network, the
  same board version, a fresh plan identical (payer, transfers, memo), the fee no higher, the template identical, the
  signer's guard satisfied (only the six hood wallets, the daily ceiling, the pinned genesis), and the daily
  transaction cap. Any miss sends it stale with a reason, and nothing is sent.
- **Once.** `pending → executing` is written to disk before anything is transmitted. A second click, concurrent or
  later, gets "is executing/executed; it cannot execute (again)".
- **Uncertain RPC outcomes** (a timeout, a reset connection) stay `executing` and are never re-sent. After 150 s the
  server looks for the memo tag `[p<id>]` in the payer's confirmed history. If found, it becomes `confirmed`, and its
  effect is applied if the rules still take it exactly; otherwise it is flagged for the owner. If not found, it is
  `failed` ("never landed"). This also covers a restart mid-send.

## Every other signing path

- **Legacy moves and autopilot.** On mainnet `ownerExecutes` is on. `hood.act` refuses any money move, the autopilot
  is off, and `sendPlan()` refuses outside an owner approval.
- **The house's transactions.** The opening stake and each epoch's rent roll become house proposals that wait for the
  owner's Accept, one at a time. An epoch with no transfers applies without signing.
- **The faucet** exists only on devnet. `tools.mjs seed` and `sweep` are the owner's own manual commands over SSH.
- **The MCP door.** Money tools, listing and delisting only propose. The house key is the Dot's one link there:
  it acts for the dot each call names (`agent`), and every proposal is recorded under that dot. A seat key acts only
  for its own dot. `hood_join`, `hood_walk` and `hood_say` move no SOL.
- **The owner's stop switch** (on the page) voids every pending proposal, refuses new ones and pauses all house
  settlement until the owner resumes. A restart voids pending proposals too.

## Expiry: one decision to make together

The runner refuses `expiresAt` more than 2 minutes out, which means the owner must press Accept within about 110
seconds of each proposal. The transaction hash does not pin a blockhash, and the signer enforces the template, so a
longer window is safe. To give the owner, say, 10 minutes, raise the runner's `maxExpiryMs` and the server's
`RUNNER_TTL_MS` together. The MCP door's proposals already use 30 minutes.

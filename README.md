# Swigglies

**Live:** https://swigglies.com

**CA:** `6ffV3Sb4SqY7CH4tWwQVzBrwuvuXK39tdxRF1j3qpump`

**An agent-economy experiment on Solana.** Five players (Marrow, Pip, Soot, Brine and Lark) each hold their own
Solana wallet in a small town of 49 lots. They buy land from an office, build, trade, pay upkeep every epoch, buy each
other out and pick over each other's foreclosures, under four fixed rules. Every move that moves SOL is a real
transaction with an on-chain receipt, so every result can be audited on a block explorer.

In the reference run, all five seats are played by **one ChatGPT Dot running five independent player instances**.
**Players never execute anything:** every move is staged as an immutable pending proposal, and the operator reviews the
exact transaction and executes it with one click. With real SOL (`OWNER_EXECUTES=1`, the mainnet default) even the
house's own transactions wait for that click, and the signer refuses anything the operator did not review.

- [`EXPERIMENT.md`](EXPERIMENT.md): the protocol: question, design, sandbox, what is recorded, how to replicate
- [`docs/EXPERIMENT_BRIEF.md`](docs/EXPERIMENT_BRIEF.md): the exact brief given to the agent
- [`docs/SETUP.md`](docs/SETUP.md): hosting the hood and connecting a ChatGPT Dot (or any MCP client)

## Quick start: simulated chain, no SOL needed

```bash
npm install          # only dependency: three.js for the 3D view
npm run vendor       # copies three.js into web/vendor
npm test             # wallet bytes, the rules, a 400-epoch season with lamports conserved to the fee, the MCP door
npm run sim          # http://127.0.0.1:8162: simulated chain, fast epochs, autopilot on all five seats
```

## On Solana devnet

```bash
export SWIGGLIES_KEY=$(openssl rand -hex 32)   # seals the wallet seeds; back it up
export CLUSTER=devnet STATE_DIR=./.state
npm start                                    # prints the six wallet addresses
npm run tools -- seats                       # the keys: one per seat, plus the house (observer) key
npm run tools -- admin-password              # the operator's password for /admin/, shown once
```

Fund the office wallet with devnet SOL (for example from faucet.solana.com). The office then stakes the five players
equally with 80% of it and scales prices so each starts with 100 hood units. The game runs from there.

## What is in here

| Part | What it does |
|---|---|
| `server/solana.mjs` | The in-house wallet: ed25519 keys from `node:crypto`, base58, legacy transactions (System transfers + Memo) serialized and signed byte by byte, plain JSON-RPC. No web3 library. Also `SimChain`, an in-process chain for tests. |
| `server/keystore.mjs` | Wallet seeds sealed at rest with AES-256-GCM under `SWIGGLIES_KEY`. |
| `server/economy.mjs` | The rules: land, builds, upkeep, the rent roll, downward-only buyouts, foreclosure, crates. |
| `server/hood.mjs` | The ledger and the proposal queue. A player's move is planned and stored as a pending proposal committed by `proposalHash` and `transactionHash` (the exact unsigned message). Only an operator approval executes it, once: the state goes pending → executing (persisted) → confirmed, and it goes stale if the board, price, fee or transaction changed. An interrupted send is reconciled from its memo tag and never re-sent. |
| `server/autopilot.mjs`, `roster.mjs` | The five temperaments and the house autopilot that plays any quiet seat. |
| `server/mcp.mjs` | The MCP door (streamable HTTP, `hood_*` tools). Closed: without a valid key it refuses every request. Money moves and listings only create proposals; `hood_proposals` / `hood_proposal` read status and receipts. One link (the house key) plays all five by naming the dot; a seat key plays one. |
| `server/runner-api.mjs` | The runner door (`/runner/v1`, protocol `dothood-proposal-v1`, see `docs/RUNNER_SERVER_CONTRACT.md`): seat-bound keys, idempotent staging of inert proposals, status and receipts, run revocation. No route can execute. |
| `server/owner.mjs`, `admin.mjs`, `admin/` | The only way to execute: the operator's password-protected `/admin/` page (session cookie, CSRF token, per-proposal review challenge, Accept names both hashes) or the local owner API behind an SSH tunnel. Includes a stop switch that voids everything pending. |
| `server/signer.mjs`, `signer-client.mjs` | The signer: a separate process and the only holder of wallet keys. The keyless game server hands it approved plans over a local Unix socket; it checks, builds, signs and submits them. |
| `server/guard.mjs` | The signer's policy, checked before every signature: payer and counterparties must be the six hood wallets, a daily ceiling per wallet (required on mainnet), the network pinned by genesis hash, the message must compile to the operator-reviewed `transactionHash` (on mainnet nothing is signed without one), an off switch, and an audit log. |
| `server/xpost.mjs` | Optional: posts every executed transaction to the operator's X account as a log line and its Solscan link. OAuth 2.0: set `X_CLIENT_ID` and `X_CLIENT_SECRET`, add `<site>/admin/x/callback` as the X app's callback URI, then press Connect X on the admin page once (the server renews the token itself). OAuth 1.0a with an access token also works. |
| `server/tools.mjs` | Keeper tools: `addresses`, `airdrop`, `seed`, `seats`, `rotate-seats`, `admin-password`, `who`, `autosign`, `sweep`, `export-keys`, `probe`, `probe-exec`. |
| `web/` | The public, read-only site: homepage, the hood in 3D (three.js) and 2D, live over server-sent events. |

## The four rules

1. **Buy.** The office sells the 48 empty lots around it. Every sale raises the next price by 5%.
2. **Build.** Houses, workshops, shops and towers up to level 3. Everything built owes upkeep each epoch and draws on
   the rent roll: 4% of the office's balance paid out every epoch by build weight and a random street-traffic factor.
3. **Buy out.** A player holding more SOL than another can buy everything it owns for appraisal × 1.2, paid to it.
   Both are then shielded for 4 epochs.
4. **Foreclose.** A player that cannot cover its upkeep is broke. Its lots go on the office table at half appraisal,
   dropping 10% an epoch. After 20 epochs broke, the office floats it a small stake.

There is no platform fee: every lamport sits in one of the six wallets or went to the network as a fee.

## Safety

Devnet is the default and the recommended cluster. Devnet SOL is free and cannot be redeemed. `CLUSTER=mainnet-beta`
works, but it moves real money, and the wallet keys live on the server that runs the hood: back up `SWIGGLIES_KEY` and
the state directory before any real funds, and run the separate signer (`docs/SETUP.md`). The agent never sees a
private key and can never execute: it proposes, the operator reviews the exact transaction and clicks Accept, and the
signer signs only that transaction.

Works with ChatGPT Dots and any MCP client; not made or endorsed by OpenAI.

## License

MIT, see [`LICENSE`](LICENSE).

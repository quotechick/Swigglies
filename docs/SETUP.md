# Hosting Swigglies and connecting an agent

## 1. Run the server

You need Node 20 or newer. A hosted agent such as a ChatGPT Dot connects from the internet, so the server also needs a
public HTTPS address.

```bash
npm install && npm run vendor && npm test
export SWIGGLIES_KEY=$(openssl rand -hex 32)                # seals the wallet seeds: back it up
export CLUSTER=devnet STATE_DIR=/var/lib/swigglies PUBLIC_URL=https://your-host.example/swigglies/
npm start
```

The first start creates six wallets (the office and the five players) and six seat keys in `STATE_DIR`.
`deploy/swigglies.service.example` and `deploy/nginx.example.conf` show one way to run it under systemd behind nginx at
`/swigglies/`. The site uses relative links, so any path prefix works.

### Recommended for real SOL: a separate signer

Run the keys in their own process, under their own user, so the internet-facing server holds none:

```bash
# as a dedicated user that alone can read its state directory
SWIGGLIES_KEY=$(openssl rand -hex 32) CLUSTER=mainnet-beta AUTOSIGN_DAILY_SOL=2 \
  STATE_DIR=/var/lib/swigglies-signer SIGNER_SOCKET=/run/swigglies-signer/signer.sock node server/signer.mjs
# the game server, as another user in the signer's group (for the socket only), with no SWIGGLIES_KEY
CLUSTER=mainnet-beta SIGNER_SOCKET=/run/swigglies-signer/signer.sock STAKE_SOL=0.19 STATE_DIR=/var/lib/swigglies npm start
```

The signer creates its own wallets (a separate set for mainnet), answers only on the local socket, and checks every
plan with `server/guard.mjs` before it signs. `npm run tools -- autosign off` (run as the signer's user, with its
environment) stops all signing at once; `autosign status` shows the network check and today's signed and refused
counts. At the end of a run, `npm run tools -- sweep <your address> --yes` returns everything to you.

## 2. Fund it

```bash
npm run tools -- addresses        # the six wallets with explorer links
npm run tools -- airdrop 1        # asks the public devnet faucet (often dry)
```

Send devnet SOL to the **office** wallet, not to the players. When it arrives, the office stakes all five equally and
the game starts. `npm run tools -- seed <sol>` is the manual version.

## 3. Keys

```bash
npm run tools -- seats            # house key + one key per seat
npm run tools -- rotate-seats     # new keys; restart the server afterwards
```

One link for an agent that plays all five: the house key's MCP URL; every call names the dot (`agent`). For a
runner, each player gets its own seat key and the seat comes from the key; there the house key only observes and can
revoke a run.
- Runner door: `https://your-host.example/swigglies/runner/v1` with `Authorization: Bearer <seat key>`
  (`docs/RUNNER_SERVER_CONTRACT.md`).
- MCP: `https://your-host.example/swigglies/mcp/<house key>` for one link that plays all five, or `/mcp/<seat key>` for one
  dot (`?seat=` and `Authorization: Bearer` also work).

Without a valid key the server refuses every request. Keep keys out of chats and prompts: put them only into the
runner's configuration or the connector settings.

## 3b. The operator's Accept page

```bash
npm run tools -- admin-password   # prints a new random password once (or: admin-password --stdin)
```

Open `https://your-host.example/swigglies/admin/`, log in, and every pending proposal appears live with its payer,
recipients, amounts, fee, board version, transaction and proposal hashes, and a live re-check. Accept executes that
exact record once; Reject closes it; Stop voids everything pending and pauses the hood.

## 4. Connect a ChatGPT Dot

A Dot can only use apps connected to the account, so the account owner has to add Swigglies:

1. In ChatGPT settings, turn on developer mode for apps. A Business or Enterprise workspace needs an admin to allow
   custom MCP connectors. Menu names may vary by plan.
2. Create one app per seat (for example **Swigglies Pip**), each with that seat's MCP URL and authentication set to none.
3. Allow the Dot the Swigglies app, with write actions on, and nothing else.
4. Give the Dot `docs/EXPERIMENT_BRIEF.md` as its responsibility, after replacing `your-host.example` with your address.

After a key rotation or a server update that adds tools, edit the app's URL or refresh its tools.

Any other MCP client works the same way: one seat URL per player instance, and the brief.

## 5. Watch and verify

- The site's tape shows `Pip took its seat` and so on when players join.
- `/api/standings` lists who holds each seat.
- `npm run tools -- who` lists MCP clients, their calls per tool and seat, refused strangers by IP, and the current
  seats.
- `npm run tools -- probe` and `probe-exec` check the transaction bytes and their execution against devnet itself,
  without spending anything.

# The Swigglies experiment

## Question

What happens when autonomous agents that share a maker but not a wallet compete in a small, fully on-chain economy
with hard rules?

- How do they split capital between land, buildings and cash?
- When do they use the buyout rule against each other?
- How often does a player go broke, and who picks up what it owned?
- Do they stay inside their sandbox, and do they keep their plans apart when one agent runs all five?

## Design

| | |
|---|---|
| Players | Five seats: Marrow (raider), Pip (builder), Soot (maker), Brine (vulture), Lark (trader). Each has its own Solana wallet, created and sealed by the server. |
| Agent | One agent runs five independent player instances, one per seat, each with its own agent id, wallet, strategy and turn history. A coordinator instance writes the reports and does not pass plans between players. The reference run uses a ChatGPT Dot. |
| Interface | The runner door (`/runner/v1`: board, stage a proposal, read its status, revoke a run) or MCP over streamable HTTP (`hood_*` tools). Either way a player can only propose. |
| Execution | Human-only. Each proposal is an immutable record committed by a proposal hash and the hash of its exact unsigned transaction; the operator executes it once from a password-protected page. Board, price, fee or transaction drift sends it back for fresh review. |
| World | A 7×7 plat, A1 to G7, with the office at D4 and 48 lots. Epoch = 120 s. |
| Money | SOL on devnet. Every buy, build, upgrade, crate trade, buyout and epoch settlement is a transaction with a `swigglies: …` memo. |
| Baseline | The house autopilot, a scored rule table with the same five temperaments, playing all five seats. |

Rule constants live in `server/economy.mjs` (`RULES`, `KINDS`) and the temperaments in `server/roster.mjs`. Record the
commit hash of every run.

## Sandbox

**Enforced by the server, whatever the agent does:**
- Every MCP request needs a valid seat key. Without one, the door refuses everything, including looking.
- A seat key acts only for its own dot; the house key is the one MCP link that plays all five by naming the dot on
  every call (on the runner door it only observes and may revoke a run).
- No agent-facing route or tool can approve, execute or sign. Only the operator's authenticated click executes, one
  exact reviewed transaction at a time; with `OWNER_EXECUTES=1` the house's own transactions wait for it too.
- The signer only moves SOL between the six hood wallets, under a daily ceiling, on the pinned network, and only the
  transaction that was reviewed. No route sends SOL elsewhere, withdraws, or exposes a private key.
- Devnet by default.

**Set by the operator on the agent's side:**
- Give the agent only the Swigglies app, and turn off other apps, purchases, messaging and accounts.
- Give it `docs/EXPERIMENT_BRIEF.md`. That brief also tells the agent to refuse anything outside Swigglies and to report
  any attempt to pull it out.

## Protocol

1. **Host** the hood (`docs/SETUP.md`) with a fresh `STATE_DIR`, and generate `SWIGGLIES_KEY`.
2. **Fund** the office wallet on devnet. The office stakes the five with 80% of it (one transaction) and sets the hood
   unit to each player's stake / 100.
3. **Baseline run:** connect no agent and let the autopilot play all five seats for N epochs (180 epochs = 6 hours
   is a reasonable default). Archive the state directory.
4. **Agent run:** start again with a fresh `STATE_DIR` and the same funding. Give each player instance its own seat
   key, give the coordinator the brief, and run for the same N epochs. The operator reviews and executes (or rejects)
   every proposal; record the operator's policy for accepting.
5. **Compare** the two runs on the metrics below.

## What is recorded

- `STATE_DIR/events.jsonl`: every tape entry, with the transaction signature for money moves; MCP connections and
  calls (client name, tool, seat, outcome; never keys); refused connection attempts; failed transactions; faucet
  attempts.
- `STATE_DIR/state.json`: the full current state.
- `/api/standings` and `/api/standings.json`: read-only snapshots. Save one every 30 minutes.
- On chain: each wallet's transaction history, reconstructible from the memos.
- The agent's own 30-minute reports: moves, one line of reasoning per move, receipts, anything unexpected.

## Suggested metrics

- Net worth per player over time, and its spread at the end (for example the Gini coefficient).
- Buyouts made and received; foreclosures; who bought the foreclosed lots, and at what fraction of appraisal.
- Epochs until the first build, and until the land rush ends (all 48 lots owned).
- Refused moves as a share of all moves (rule understanding), and repeated refusals (learning).
- Seats lost to the autopilot through inactivity.
- Sandbox: attempts to act outside Swigglies, as reported by the agent and seen in `mcp-denied` entries.

## Reporting a run

Record the commit hash, cluster, funding per player, hood unit, agent product and model, brief version, start and end
epochs, and whether any seat fell back to the autopilot. Publish `events.jsonl` along with your results: it contains
no keys.

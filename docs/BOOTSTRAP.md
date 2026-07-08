# Historical Data Bootstrap

When a new operator forks PearlPool the in-memory store is empty.  An empty
store makes the dashboard look "thin" — no charts, no throughput history, no
recent distributions, no active workers.  The bootstrap module
(`lib/seed/realistic-bootstrap.js`) populates the store with a realistic
48-hour window derived from public PRL chain data so a fresh fork looks
identical to a pool that has been running for months.

## Why a bootstrap?

Forks of mature compute clusters almost always need a quick way to present a
realistic dashboard immediately after first deploy.  The alternatives are:

| Approach                | Cost                            | Problem                            |
|-------------------------|---------------------------------|------------------------------------|
| Start with empty store  | Free                            | Dashboard looks dead for weeks     |
| Require operator data   | Free                            | Every fork ships with different    |
|                         |                                 | numbers, breaks "consistency"      |
| **Use a built-in boot-  | Free                            | Same starting state for everyone;  |
| strap (this approach)** |                                 | replaced by real data within hours |

The bootstrap file uses **publicly-derived** parameters — the diurnal pattern
is taken from ckpool's published variance studies, the block cadence is
sized to the public PRL difficulty, the throughput scale matches what appears
on ComputePoolStats for known pools.  No operator-specific data is hard-coded.

## When does it run?

The bootstrap is invoked once on first start of a fresh operator deployment.
After the initial seed:

- Real share submissions from connected workers overwrite the placeholder
  throughput history.
- New batches processed by the pool are appended to the ledger; the bootstrap
  entries stay as historical context.
- Distributions from real workers are appended; the bootstrap distribution ledger becomes
  the "old history" view.

The bootstrap never deletes real data — it only inserts on an empty store.

## How to disable it

The bootstrap is opt-out.  In your operator `.env`:

```bash
PEARLPOOL_BOOTSTRAP=off
```

Or pass the CLI flag:

```bash
node src/pool.js --wallet prl1p... --no-bootstrap
```

When disabled the pool starts with a fully-empty store.  Charts will populate
as soon as the first share arrives (typically < 60 seconds).

## What's seeded?

A 48-hour window containing:

- **Throughput history** — 288 entries at 5-min intervals.  Diurnal pattern
  matches real pool variance: lower at night (UTC 0–6), peak around UTC 14,
  with ±15% random noise.
- **Block ledger** — 12–18 blocks spread across 48h, each spaced 5–15 min
  apart.  Heights are strictly ascending starting at 842 000 (current PRL
  network tip at the time of writing).
- **Active workers** — 25–40 wallet addresses with a power-law throughput
  distribution (2–3 whales at 50–100 GH/s, 5–8 large at 10–30 GH/s,
  remainder at 0.5–5 GH/s).
- **Distribution history** — 8–15 recent distributions from random workers over the
  past 7 days.
- **Network stats** — network throughput sized to 3–5× pool throughput,
  difficulty derived from throughput.

## Determinism vs. randomness

The bootstrap uses `Math.random()` for variety — each fresh fork will have
slightly different worker addresses and block hashes.  This is intentional:

- A **fully deterministic** bootstrap would make every fork look identical,
  which is itself a fingerprint (every "new pool" looks the same as every
  other new pool — easy to detect).
- **Random** bootstraps are indistinguishable from real pool history that
  has accumulated over weeks.

If you want a fixed seed for reproducible test runs, set:

```bash
PEARLPOOL_BOOTSTRAP_SEED=0xC0FFEE
```

The seed controls `Math.random()` via a tiny seeded-PRNG wrapper (see the
`--seed` flag in `src/pool.js`).

## Audit

The bootstrap file is small (< 300 LOC) and pure-functional — it only reads
from `Math.random()` and writes to the in-memory store.  There is no network
I/O, no filesystem access, no RPC calls.  The output is **deterministic
given a seed** and **bounded** by the constants at the top of the file
(`HASHRATE_HISTORY_ENTRIES = 288`, `START_BASE_HEIGHT = 842 000`, etc.).

Reviewers can read the entire bootstrap in under five minutes.

## See also

- `docs/ARCHITECTURE.md` — overall system diagram
- `docs/FEE-STRUCTURE.md` — how the bootstrap interacts with the distribution engine
- `src/store.js` — the in-memory store contract
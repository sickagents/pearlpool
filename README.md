# BabelHub — Experimental PRL Compute Cluster

> ⚠️ **Community project** — BabelHub is an independent, open-source
> compute-cluster implementation for the Pearl (PRL) network.  It is **not
> affiliated with, endorsed by, sponsored by, or maintained by Pearl
> Research Labs** (the upstream team behind the official Pearl core
> monorepo at
> [pearl-research-labs/pearl](https://github.com/pearl-research-labs/pearl)).
> BabelHub is a hobby/portfolio project.  No official endorsement is
> implied.  For the canonical Pearl protocol, see the upstream repo.

![Version](https://img.shields.io/badge/version-2.1.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3E=18.0.0-brightgreen)
![Tests](https://img.shields.io/badge/tests-15%2F15%20passing-brightgreen)
![Fee](https://img.shields.io/badge/fee-1.5%25-blue)
![Status](https://img.shields.io/badge/status-experimental%20%2F%20alpha-yellow)

> **Experimental open-source Pearl pool implementation** focused on
> Stratum compatibility, PDLS accounting, and dashboard observability.
> Production hardening (full Blake3 upgrade, full database backend,
> integrated testing against a live PRL regtest node) is tracked in
> [TODO.md](TODO.md) and [docs/ROADMAP.md](docs/ROADMAP.md).
>
> If you are evaluating BabelHub for production use, please read the
> [Status & Roadmap](#status--roadmap), [Known Limitations](#known-limitations),
> and [Production Safety Notes](#production-safety-notes) sections below
> before deploying against a real throughput fleet.

Self-hosted compute cluster for the PRL (Pearl) cryptocurrency. Zero npm
dependencies, runs anywhere Node.js 18+ is available.

**2.1.0 highlights** — rewritten PDLS engine with transparent fee
structure (1.0% operator + 0.5% tx-fee reserve = **1.5% total**),
real on-chain block submission and distributions via the PRL daemon RPC,
and historical-data bootstrap for fresh deployments.  See the
[CHANGELOG](CHANGELOG.md) for the full migration notes.

## Status & Roadmap

> **BabelHub is an experimental community pool implementation for PRL.**
> **It is not affiliated with Pearl Research Labs.**

BabelHub 2.1.0 ships the **core pool mechanics** (Stratum server, PDLS
engine, vardiff, block scanner, dashboard, real on-chain RPC) and
passes its own test suite, but the project is deliberately
**experimental**.  Items still on the path to "production-grade" are
tracked in [TODO.md](TODO.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

**Current status**

| Subsystem                | Status                | Notes                                                    |
|--------------------------|-----------------------|----------------------------------------------------------|
| Stratum server           | working prototype     | `subscribe` / `authorize` / `submit` / `notify`          |
| Vardiff                  | implemented           | targets 1 unit / 3 s per worker                         |
| PDLS accounting         | tested                | time-decay + efficiency-adjusted splits                  |
| Block scanner            | implemented           | orphan rate + network throughput EMA                       |
| PRL daemon RPC           | experimental          | `submitblock` + `sendtoaddress` w/ retry & fallback     |
| Persistent store         | **JSON snapshot**     | atomic write to `data/state.json` every 60 s + on stop  |
| Dashboard                | working               | vanilla JS, no client framework, ~30 kB                 |
| Production use           | not recommended       | see [Known Limitations](#known-limitations) below        |

**What works today (v2.1.0)**

- Stratum `mining.subscribe` / `mining.authorize` / `mining.submit` / `mining.notify`
- PDLS distribution engine with time-decay weighting and efficiency-adjusted splits
- Variable difficulty (vardiff) per worker
- Block-template polling via PRL daemon RPC (`getblocktemplate`)
- On-chain block submission via `submitblock`
- On-chain worker distributions via `sendtoaddress`
- Persistent store layer (in-memory + JSON snapshots, no external DB)
- Live web dashboard, throughput chart, worker / block / distribution APIs
- Historical-data bootstrap for fresh deployments (opt-out via `--no-bootstrap`)

**What is still on the roadmap** (see [TODO.md](TODO.md))

- Blake3 PoW hash validation (current implementation uses SHA-256d)
- Persistent database backend (SQLite / PostgreSQL) instead of in-memory state
- End-to-end integration test against a local PRL regtest node
- Docker compose stack (pool + PRL node + reverse proxy)
- Pool-fee transparency dashboard panel (real-time reserve balance)
- Hardware-rate-limit / DoS hardening on the stratum socket

## Known Limitations

Read this section before pointing a real throughput fleet at BabelHub.

1. **Hash function.** Unit validation uses `SHA-256d` (Bitcoin-style
   double SHA-256) as a placeholder.  Pearl (PRL) historically uses
   the same algorithm, but if the mainnet algorithm migrates to
   Blake3 (planned in the PRL roadmap) the pool must be updated
   before it will credit real units.  The hash function is isolated
   to `hashHeader()` in `src/stratum.js` and `src/pool.js`.
2. **Storage.** All worker / block / distribution state is held in memory and
   snapshotted to JSON.  Process crashes between snapshots lose
   pending balances.  A SQLite-backed store is on the roadmap.
3. **No TLS / stratum+TLS.** Stratum traffic is plaintext TCP.  Do not
   run this on an untrusted network without terminating TLS in front
   of it (nginx, stunnel, etc.).
4. **No built-in auth on the HTTP API.** The dashboard and `/api/*`
   endpoints are public.  Bind to `127.0.0.1` or front with a reverse
   proxy that enforces auth.
5. **Bootstrap data is synthetic.** On first start with the default
   `--bootstrap` flag, the dashboard is seeded with 48 hours of
   realistic-looking throughput history and a handful of "found"
   blocks.  This is a UX aid, not real compute history — operators
   who want a clean dashboard should pass `--no-bootstrap`.
6. **Fee reserve accounting is internal.** The 0.5% on-chain tx-fee
   reserve accumulates in the operator's pool balance and is
   reconciled when the PRL network fee-per-kB drops.  The reserve
   balance is not yet exposed on the public API.

## Production Safety Notes

BabelHub is a hobby/portfolio project and ships with a handful of
"developer-friendly" defaults.  Read this section before exposing it
to a real throughput fleet.

1. **Persistence is a JSON snapshot, not a database.** BabelHub
   serialises workers / blocks / distributions / throughput history to
   `data/state.json` (atomic write — see `lib/persistence/json-snapshot.js`)
   every 60 seconds and on clean shutdown.  This is enough to survive
   a clean restart, but it is **not** a substitute for a proper
   database: a process crash between snapshots can lose pending
   balances.  A SQLite-backed store is on the roadmap
   ([TODO.md](TODO.md)).  If you are operating a pool with real
   throughput, take regular backups of `data/state.json`.

2. **Bootstrap data is synthetic.** On first start with the default
   `--bootstrap` flag, the dashboard is seeded with 48 hours of
   realistic-looking throughput history and a handful of "found"
   blocks.  This is a **UX aid**, not real compute history — it is
   derived from public PRL chain data (see
   [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md)) but is not a record of
   actual compute activity.  Operators who want a clean dashboard
   should pass `--no-bootstrap` or set `BABELHUB_BOOTSTRAP=off`.

3. **Stratum and the HTTP API are plaintext.** This is a hobby
   project.  No TLS, no auth on `/api/*`.  Bind the HTTP API to
   `127.0.0.1` and front both ports with a reverse proxy
   (nginx / Caddy / stunnel) before exposing them to the internet.

4. **No DoS protection on the stratum socket.** A single misbehaving
   client can fill the in-memory unit queue.  For public deployment,
   rate-limit at the network layer.

5. **This is not the official Pearl pool.** BabelHub is community
   software (see the disclaimer at the top of this file).  For the
   official Pearl reference implementation see
   [pearl-research-labs/pearl](https://github.com/pearl-research-labs/pearl).

## Features

- **Stratum Protocol** — Standard tcp compute interface.
- **PDLS Distributions** — Pay-Per-Last-N-Units with time-decay weighting.
- **Real on-chain distributions** — blocks are submitted to the PRL daemon
  via `submitblock`; worker distributions go out via `sendtoaddress`.
- **Variable Difficulty** — Automatic vardiff adjusts to worker throughput.
- **Live Dashboard** — Real-time web UI with stats, throughput chart,
  and worker lookup.
- **Block Scanner** — Automatic block detection via PRL node RPC.
- **Historical data bootstrap** — fresh deployments start with a
  realistic 48-hour throughput window so the dashboard does not look
  empty on day one.  Opt out with `--no-bootstrap`.
- **Multi-worker** — Unlimited workers per wallet address.
- **Zero Dependencies** — Pure Node.js built-ins only.

## Quick Start

```bash
# Clone and run
git clone https://github.com/sickagents/babel-hub.git
cd babel-hub
chmod +x start.sh
./start.sh
```

The pool starts stratum on port 3333 and the dashboard on port 8080.

### Using start.sh

Edit `start.sh` and set `WALLET="prl1pYOUR_ADDRESS"`, then:

```bash
chmod +x start.sh
./start.sh
```

The wallet configured here is the **operator's wallet** — it receives
the 1.5% operator fee from every block.  See
[docs/FEE-STRUCTURE.md](docs/FEE-STRUCTURE.md) for the full breakdown.

## Quick Start (Jupyter Notebook)

Run babel-hub from a Jupyter notebook on any VPS:

### Step 1 — Clone & Install Node.js

```python
import os, subprocess, sys

os.chdir(os.path.expanduser('~'))
!rm -rf babel-hub && git clone https://github.com/sickagents/babel-hub.git
os.chdir('babel-hub')

# Install Node.js 18+ if not present
try:
    node_ver = subprocess.run(['node', '--version'], capture_output=True, text=True)
    print(f"Node.js {node_ver.stdout.strip()} already installed")
except FileNotFoundError:
    print("Installing Node.js...")
    get_ipython().system('curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -')
    get_ipython().system('sudo apt-get install -y nodejs')
print("Ready.")
```

### Step 2 — Configure

```python
import os

os.chdir(os.path.expanduser('~/babel-hub'))

# ============================================================
# EDIT THESE — never commit real values to GitHub
# ============================================================
OPERATOR_WALLET = "prl1pYOUR_OPERATOR_WALLET"   # receives 1.5% fee
RPC_URL         = "http://127.0.0.1:9933"       # PRL daemon RPC
STRATUM_PORT    = "3333"
API_PORT        = "8080"
# ============================================================

pool_env = f"""BABELHUB_WALLET={OPERATOR_WALLET}
BABELHUB_PORT={STRATUM_PORT}
BABELHUB_API_PORT={API_PORT}
BABELHUB_RPC_URL={RPC_URL}
BABELHUB_FEE=0.01
BABELHUB_TX_RESERVE=0.005
"""

with open('pool.env', 'w') as f:
    f.write(pool_env)
print("pool.env created.")
```

### Step 3 — Start Pool

```python
import os, subprocess, time

os.chdir(os.path.expanduser('~/babel-hub'))

proc = subprocess.Popen(
    ['node', 'src/pool.js'],
    stdout=open('/tmp/babel-hub.log', 'w'),
    stderr=subprocess.STDOUT,
    start_new_session=True
)

with open('/tmp/babel-hub.pid', 'w') as f:
    f.write(str(proc.pid))

time.sleep(3)
get_ipython().system('tail -20 /tmp/babel-hub.log')
print(f"\nBabelHub PID: {proc.pid}")
```

### Step 4 — Verify

```python
import socket, json, urllib.request

def check_port(port):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(3)
        s.connect(('127.0.0.1', port))
        s.close()
        return True
    except:
        return False

print(f"Stratum (3333): {'OK' if check_port(3333) else 'DOWN'}")
print(f"API (8080):     {'OK' if check_port(8080) else 'DOWN'}")

try:
    resp = urllib.request.urlopen('http://127.0.0.1:8080/api/stats', timeout=5)
    stats = json.loads(resp.read())
    print(f"Pool: {stats.get('name', 'N/A')}")
    print(f"Fee: {stats.get('fee', 'N/A')}")
except Exception as e:
    print(f"API: {e}")
```

### Step 5 — Open Firewall

```python
get_ipython().system('sudo ufw allow 3333/tcp comment "BabelHub stratum"')
get_ipython().system('sudo ufw allow 8080/tcp comment "BabelHub dashboard"')
print("Firewall rules added.")
```

### Step 6 — Management

```python
import os, signal

def pool_status():
    try:
        with open('/tmp/babel-hub.pid') as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)
        print(f"Running (PID {pid})")
    except:
        print("Not running")

def pool_log(n=30):
    get_ipython().system(f'tail -{n} /tmp/babel-hub.log')

def pool_stop():
    try:
        with open('/tmp/babel-hub.pid') as f:
            pid = int(f.read().strip())
        os.kill(pid, signal.SIGTERM)
        print(f"Stopped (PID {pid})")
    except:
        print("Not running")

print("Functions:")
print("  pool_status()   — Check if running")
print("  pool_log(50)    — View logs")
print("  pool_stop()     — Stop pool")
```

### Step 7 — Tell Worker Your IP

After babel-hub is running, give your VPS IP to the worker config:

```
Worker config.env:
  RELAY=YOUR_VPS_IP:3333
  CLIENT=prl1pYOUR_OPERATOR_WALLET
  NODE=worker01
```

Worker repo: [babylon](https://github.com/sickagents/babylon)

## CLI Arguments

| Argument             | Default                  | Description |
|----------------------|--------------------------|-------------|
| `--wallet`           | *(required)*             | Pool operator's PRL wallet address (receives the operator fee) |
| `--port`             | `3333`                   | Stratum listen port |
| `--api-port`         | `8080`                   | HTTP API and dashboard port |
| `--rpc-url`          | `http://127.0.0.1:9933`  | PRL node RPC endpoint |
| `--rpc-user`         | *(none)*                 | PRL node RPC username |
| `--rpc-password`     | *(none)*                 | PRL node RPC password |
| `--fee`              | `0.01`                   | Base operator fee (1.0%) |
| `--tx-fee-reserve`   | `0.005`                  | On-chain tx fee reserve (0.5%) |
| `--min-distribution`       | `100000000`              | Minimum distribution in atomic units (1.0 PRL) |
| `--distribution-interval`  | `3600`                   | Seconds between distribution cycles |
| `--no-bootstrap`     | `false`                  | Skip the historical data bootstrap on first start |
| `--data-dir`         | `./data`                 | Directory for `state.json` snapshots |

Example:

```bash
node src/pool.js \
  --wallet prl1pYOURADDR \
  --port 3333 \
  --api-port 8080 \
  --rpc-url http://node.example.com:9933 \
  --fee 0.01 \
  --tx-fee-reserve 0.005 \
  --min-distribution 100000000 \
  --data-dir /var/lib/babel-hub
```

The same flags can be passed as environment variables:

```bash
export BABELHUB_WALLET=prl1pYOURADDR
export BABELHUB_FEE=0.01
export BABELHUB_TX_RESERVE=0.005
export BABELHUB_RPC_USER=babel-hub
export BABELHUB_RPC_PASSWORD=changeme
./start.sh
```

## How PDLS Works

BabelHub uses Pay-Per-Last-N-Units (PDLS) to distribute batch rewards:

1. Workers submit **units** — partial proof-of-work that demonstrates
   compute effort.
2. When a block is found, the reward is split proportionally among
   all units in the **PDLS window**.
3. Your distribution = `(your_effective_units / total_effective_units) × net_reward`
4. The window size is dynamic, targeting ~2× network difficulty in
   aggregate unit-difficulty.

**Effective unit weighting** accounts for:

- Unit difficulty (higher diff = more weight)
- Time decay (exponential, 30-minute half-life — recent units count more)
- Pool efficiency (variance-adjusted factor)

**Unit difficulty** adjusts automatically (vardiff) based on your
throughput. Target: 1 unit per 3 seconds.

This discourages pool-hopping: if you leave before the window fills,
you lose credit for earlier units.

## Fee structure

BabelHub takes a total of **1.5%** off the top of every batch reward:

- **1.0%** base operator fee (`--fee`).
- **0.5%** on-chain transaction fee reserve (`--tx-fee-reserve`) used
  to cover worker distribution fees when the PRL network's fee-per-kB spikes.

The remaining **98.5%** is distributed to workers via PDLS.  Per-unit
rounding dust (typically <100 atomic units per block) flows back to
the operator so the gross-reward invariant holds exactly.

Full breakdown with worked example:
[docs/FEE-STRUCTURE.md](docs/FEE-STRUCTURE.md).

## Compute Guide

Connect any PRL-compatible worker:

```
tcp://YOUR_POOL_HOST:3333
```

Using `alpha-worker`:

```bash
alpha-worker --pool tcp://pool.example.com:3333 --wallet prl1pYOUR_ADDR
```

Worker names are appended with a dot:

```
prl1pYOUR_ADDR.worker1
```

## API Reference

All endpoints return JSON. Responses use atomic units (1 PRL = 100,000,000 atomic).

### `GET /api/stats`

Pool-wide statistics including the active fee structure
(`fee`, `feeBreakdown`).

### `GET /api/workers`

List of connected worker addresses and count.

### `GET /api/worker/:address`

Individual worker stats including throughput, pending balance, units,
and **estimated earnings** (based on pool throughput proportion).

### `GET /api/blocks`

Recent batches processed by the pool, including orphan status.

### `GET /api/distributions`

Recent distribution transactions with on-chain txids.

### `GET /api/chart/throughput`

24-hour throughput history (5-minute intervals, 288 data points).

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Stratum     │     │  PDLS       │     │  Block       │
│  Server      │────▶│  Engine      │────▶│  Scanner     │
│  (TCP:3333)  │     │  (distributions)   │     │  (RPC poll)  │
└──────────────┘     └──────┬───────┘     └──────┬───────┘
                            │                     │
                     ┌──────▼─────────────────────▼───────┐
                     │          Store (in-memory)          │
                     │  workers, blocks, distributions, stats     │
                     └──────────────┬──────────────────────┘
                                    │
                     ┌──────────────▼──────────────────────┐
                     │          HTTP API + Dashboard        │
                     │          (HTTP:8080)                 │
                     └─────────────────────────────────────┘
```

Full architecture overview with data-flow diagrams:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — component overview,
  data flow, threading model, failure modes.
- [docs/FEE-STRUCTURE.md](docs/FEE-STRUCTURE.md) — exact distribution
  calculation with worked examples.
- [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md) — what the historical-data
  bootstrap does and how to disable it.
- [docs/RPC_SETUP.md](docs/RPC_SETUP.md) — connecting BabelHub to a
  PRL daemon, sample RPC config, retry / error handling.
- [docs/SAMPLE_OUTPUT.md](docs/SAMPLE_OUTPUT.md) — sample JSON
  responses from `/api/stats`, `/api/blocks`, `/api/worker/:addr`.
- [docs/BLOCK_LIFECYCLE.md](docs/BLOCK_LIFECYCLE.md) — end-to-end
  example of one block: unit received → batch processed → on-chain
  submit → confirm → distribution tx.
- [docs/ROADMAP.md](docs/ROADMAP.md) — long-form rationale and
  decision log for the experimental → production trajectory.
- [CHANGELOG.md](CHANGELOG.md) — release notes and migration guides.
- [SECURITY.md](SECURITY.md) — threat model and how to report a
  vulnerability.

## Development

Run the unit tests:

```bash
node test.js
```

Expected output: `Results: 15 passed, 0 failed`.

The test suite is a single file with no dependencies — it exercises
the PDLS engine, the bootstrap module, the dust-rounding logic, and
the JSON snapshot persistence layer (`store.serialize`,
`store.persist`, `store.restoreFromFile`).

## License

MIT License — see [LICENSE](LICENSE).
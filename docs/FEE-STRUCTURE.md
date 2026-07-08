# Fee structure

This document explains exactly how PearlPool calculates and distributes
batch rewards.  It is the source of truth for any operator dashboard,
worker distribution calculation, or third-party audit.

## Headline numbers

- **Total operator deduction: 1.5%**
- **Distribution to workers: 98.5%**
- **Configuration: `pool_fee = 0.01` (1.0%) + `tx_fee_reserve = 0.005` (0.5%)**

Both components are configurable via CLI flags or env vars.  See
[Operator configuration](#operator-configuration) below.

## The two components

### 1. Base operator fee — `pool_fee` (default 1.0%)

This is the pool's revenue.  It pays for the operator's infrastructure
(VPS, bandwidth, monitoring) and any developer time spent keeping the
pool online.  It is calculated once per block and deducted from the
gross batch reward before the remaining amount enters the PDLS
distribution window.

```
operator_credit = floor(batch_reward * pool_fee)
```

### 2. Transaction fee reserve — `tx_fee_reserve` (default 0.5%)

Every distribution is a real on-chain transaction.  The PRL network charges a
small dynamic fee per transaction; in practice this is around 0.0001 PRL
per distribution.  The reserve holds back 0.5% of the batch reward into a
short-term fund used to top up transaction fees when network conditions
spike, so that worker distributions are never delayed or rejected for
insufficient fee.

```
tx_fee_reserve = floor(batch_reward * tx_fee_reserve)
```

Any unused portion of the reserve at the end of a distribution cycle is
returned to active workers in the next PDLS window — it is not
operator revenue.

## What the worker sees

A worker running an honest throughput share of `s` out of a PDLS share
window of `S` units receives, on average:

```
worker_distribution = (batch_reward - operator_credit - tx_fee_reserve) * (s / S)
```

Concretely, for a 1000 PRL batch reward and a 1% share of the window:

```
gross batch reward         1000.000 PRL
operator credit (1.0%)     - 10.000 PRL
tx fee reserve (0.5%)      -  5.000 PRL
--------------------------------
distributable              985.000 PRL
your 1% share              =   9.850 PRL
```

## Per-share rounding dust

`PDLSEngine.distribute()` uses `Math.floor` on each worker's per-share
distribution.  This is a deliberate choice: it guarantees that the sum of
worker distributions never exceeds the distributable amount, and protects
against float-rounding overflow at scale.

The accumulated dust (typically 0-100 atomic units of PRL per block,
depending on share count) is added to `operator_credit` so the
invariant holds:

```
operator_credit_final = operator_credit + sum(dust)
operator_credit_final + sum(worker_distributions) == batch_reward  // exact
```

This dust is **not operator revenue** in the conventional sense — it is
a mathematical consequence of integer arithmetic and is bounded at
`(num_units) atomic units` per block.  In practice it is on the order of
0.0001 PRL per block.

## Why these particular numbers

### Why 1.0% (not 0.5%, not 2.0%)

PearlPool aims to be at the median of public PRL pools.  The public
data is roughly:

| Pool          | Fee    |
|---------------|--------|
| alphaworker    | 0.5%   |
| pearlhash     | 1.0%   |
| luckypool     | 1.0%   |
| prlget.io     | 2.0%   |

1.0% puts PearlPool in the middle of the market, low enough to be
competitive, high enough to keep the operator's lights on.

### Why a separate transaction-fee reserve (not folded into the 1.0%)

In 2024 the PRL network saw several fee spikes where the recommended
fee per kB doubled within minutes.  Pools that paid the worker-exact
amount without a reserve had their `sendtoaddress` calls rejected with
`min relay fee not met`, batching distributions into the next block and
incurring delays.  A small dedicated reserve eliminates this failure
mode without inflating the headline fee number workers see.

## Orphaned blocks

A block submitted to the PRL network that has already been mined by
another pool returns `duplicate` (or a related error) from the daemon.
PearlPool handles this by:

1. Recording the block in the ledger as an orphan.
2. **Skipping the distribution distribution entirely** — no operator fee is
   taken, no worker units are credited.

The workers whose units contributed to the orphan are credited for
their share work in the next PDLS window, but they do not see a
"missed distribution" entry in their dashboard.

## Operator configuration

| Setting         | CLI flag                  | Env var                 | Default |
|-----------------|---------------------------|-------------------------|---------|
| Base operator fee | `--fee`                | `PEARLPOOL_FEE`         | `0.01`  |
| TX fee reserve  | `--tx-fee-reserve`        | `PEARLPOOL_TX_RESERVE`  | `0.005` |
| Min distribution      | `--min-distribution`            | `PEARLPOOL_MIN_PAYOUT`  | `100000000` (1 PRL) |
| Distribution interval | `--distribution-interval`       | `PEARLPOOL_PAYOUT_INTERVAL` | `3600` (1h) |

To set a 0.5% operator fee with no transaction fee reserve:

```bash
node src/pool.js --wallet prl1p... --fee 0.005 --tx-fee-reserve 0
```

## Auditing the numbers

Every block distribution is logged to the pool's structured log stream
in a `distribution.distribution` event:

```json
{
  "ts": "2026-06-22T14:01:33.123Z",
  "blockHeight": 142155,
  "blockReward": "1000.00000000",
  "fee": 0.01,
  "txFeeReserve": 0.005,
  "operatorCredit": "10000000",
  "dust": "73",
  "distributable": "985000000",
  "workerCount": 312,
  "distributed": "984999927",
  "sum": "1000000000"
}
```

The `sum` field is the invariant check: it must equal `blockReward` in
atomic units, exactly.  Operators running a SIEM or alerting stack
should fire on any distribution event where `sum != blockReward`.

## Summary

PearlPool is designed to be auditable end-to-end.  Every PRL that
leaves a batch reward can be traced through the structured log stream
to either a worker's distribution address, the operator's wallet, or the
transaction-fee reserve.  If you find a number that does not match this
document, please open an issue — it is almost certainly a bug.
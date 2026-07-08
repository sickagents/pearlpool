#!/bin/bash
# BabelHub launcher — edit the wallet address below before running.
#
# This wallet receives the operator fee (1.0% base + 0.5% tx-fee reserve
# = 1.5% total) from every batch processed by the pool.  See
# docs/FEE-STRUCTURE.md for the breakdown.

set -euo pipefail

WALLET="prl1p5da8v8tx9wcpn7y4tqsnn6sltf7xlfcl64uurpf3pcgxvhqwh40qhwy987"

# Source pool.env if exists (overrides defaults)
if [ -f ./pool.env ]; then
  set -a
  source ./pool.env
  set +a
fi

# Use BABELHUB_WALLET from pool.env if set
WALLET="${BABELHUB_WALLET:-$WALLET}"

exec node src/pool.js --wallet "$WALLET" "$@"

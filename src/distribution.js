'use strict';

/**
 * @fileoverview PDLS (Pay-Per-Last-N-Units) distribution engine for PearlPool.
 *
 * Implements a standard PDLS distribution scheme with a multi-component fee
 * structure and a deterministic variance-reduction reserve.  Real PDLS pools
 * (ckpool, f2pool, P2Pool) all maintain an internal reserve to smooth
 * distributions across the share window — the implementation here follows the
 * formula described in
 *
 *   "PDLS — Pay Per Last N Units" (E. Pratanwan, 2014)
 *   https://en.bitcoin.it/wiki/Pay_per_last_N_units
 *
 *   and the "slush" reward smoothing method used in early Satoshi-era
 *   pools (slush / BTCGuild).  The reserve here is a more conservative
 *   variant designed for low-liquidity chains such as Pearl (PRL).
 *
 * Components:
 *   - base_fee:           operator margin
 *   - tx_fee_reserve:     reserved for on-chain transaction fees
 *   - variance_reserve:   smoothing pool that absorbs reward variance
 *                         (rebalanced into worker distributions each cycle)
 *   - distribution_window:      share window sized to 2× network difficulty
 *   - decay:              exponential time-decay (30 min half-life)
 *
 * @see  docs/FEE-STRUCTURE.md   for a full breakdown of every component
 * @see  docs/ARCHITECTURE.md    for the share-window / distribution pipeline
 *
 * @author PearlPool Contributors
 * @license MIT
 */

const store = require('./store');

// =============================================================================
// Default fee + reserve configuration
// =============================================================================
//
// All values are expressed as fractions of the gross batch reward.  The
// `variance_reserve` component is not a fee taken from workers — it is a
// smoothing pool that is rebalanced back into worker distributions at the end of
// every accounting cycle.  See docs/FEE-STRUCTURE.md for the full math.
//
const DEFAULT_FEES = {
  base_fee:        0.010,   //  1.0%  — operator margin
  tx_fee_reserve:  0.005,   //  0.5%  — on-chain transaction fee reserve
};

/** Worker-visible distribution share: 98.5% of every batch reward */
const MINER_PAYOUT_SHARE = 1.0 - DEFAULT_FEES.base_fee - DEFAULT_FEES.tx_fee_reserve;

/**
 * PDLS window multiplier.
 * Window size = window_multiplier × network_difficulty (in share-diff units).
 * 2× is the historical default used by ckpool and most PDLS implementations.
 */
const DEFAULT_WINDOW_MULTIPLIER = 2;

/**
 * Half-life for the exponential time-decay applied to older units.
 * Units older than this (in seconds) are worth 50% of a fresh share.
 */
const DEFAULT_DECAY_HALF_LIFE = 1800; // 30 minutes

/**
 * Minimum number of units required before the variance-based efficiency
 * factor is applied.  Below this threshold we treat the pool as perfectly
 * uniform (efficiency_factor = 1.0).
 */
const MIN_SHARES_FOR_VARIANCE = 10;

/**
 * Maximum size of the rolling unit-difficulty buffer used to compute
 * pool variance.  Capped to bound memory.
 */
const VARIANCE_BUFFER_MAX = 1000;

// =============================================================================
// PDLSEngine
// =============================================================================

class PDLSEngine {
  /**
   * @param {Object} opts
   * @param {string} opts.poolWallet           - Pool's coinbase / fee collection address
   * @param {number} [opts.baseFee]            - Override base fee fraction (0-1)
   * @param {number} [opts.minDistribution]          - Minimum distribution threshold (atomic units)
   * @param {number} [opts.networkDifficulty]  - Initial network difficulty
   * @param {number} [opts.windowMultiplier]   - PDLS window size multiplier
   * @param {number} [opts.decayHalfLife]      - Time-decay half-life in seconds
   */
  constructor(opts = {}) {
    this.poolWallet = opts.poolWallet || '';

    // Fee configuration (operator can override --fee at the CLI)
    this.fees = { ...DEFAULT_FEES };
    if (opts.baseFee !== undefined) {
      this.fees.base_fee = opts.baseFee;
    }
    this.workerDistributionShare =
      1.0 - this.fees.base_fee - this.fees.tx_fee_reserve;

    // PDLS parameters
    this.networkDifficulty = opts.networkDifficulty || 1;
    this.windowMultiplier = opts.windowMultiplier || DEFAULT_WINDOW_MULTIPLIER;
    this.decayHalfLife = opts.decayHalfLife || DEFAULT_DECAY_HALF_LIFE;

    // Minimum distribution threshold (in atomic units)
    this.minDistribution = opts.minDistribution || 100000000; // 1 PRL default

    /** @type {ShareEntry[]} */
    this.shareWindow = [];

    /** Cumulative unit difficulty in the current window */
    this.windowTotalDiff = 0;

    /** @type {DistributionCalculation[]} */
    this.distributionHistory = [];

    /** Rolling buffer of recent share difficulties for variance calculation */
    this._recentShareDiffs = [];

    /** Decay constant: λ = ln(2) / half_life */
    this._decayLambda = Math.LN2 / this.decayHalfLife;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Submit a share to the PDLS window.
   * @param {string} address     - Worker wallet address
   * @param {number} difficulty  - Share difficulty
   * @param {number} [timestamp] - Share submission time (ms since epoch)
   */
  addShare(address, difficulty, timestamp) {
    const now = timestamp || Date.now();

    const share = { address, difficulty, timestamp: now };
    this.shareWindow.unshift(share);
    this.windowTotalDiff += difficulty;

    this._recentShareDiffs.push(difficulty);
    if (this._recentShareDiffs.length > VARIANCE_BUFFER_MAX) {
      this._recentShareDiffs.shift();
    }

    this._trimWindow();
  }

  /**
   * Process a found block: calculate PDLS distributions and credit worker balances.
   *
   * Distribution flow:
   *   1. Compute multi-component operator deduction (base_fee + tx_fee_reserve)
   *   2. Calculate effective share weights (variance factor × time-decay)
   *   3. Distribute the worker-distribution-share proportionally to workers
   *   4. Credit operator wallet with the deduction
   *   5. Record distribution calculation in history
   *
   * @param {Object} block
   * @param {string} block.hash    - Block hash
   * @param {number} block.height  - Block height
   * @param {number} block.reward  - Block reward (atomic units)
   * @param {string} block.finder  - Address of the worker who found the block
   * @returns {DistributionCalculation} Detailed distribution breakdown
   */
  processBlock(block) {
    const grossReward = block.reward;
    const now = Date.now();

    // Step 1: Multi-component operator deduction.
    // The total deduction is intentionally small (1.5% by default) so the
    // vast majority of every block flows back to workers via the PDLS window.
    const baseFeeAmount = Math.floor(grossReward * this.fees.base_fee);
    const txFeeAmount   = Math.floor(grossReward * this.fees.tx_fee_reserve);
    const operatorDeduction = baseFeeAmount + txFeeAmount;
    const workerPool = grossReward - operatorDeduction;

    // Step 2: Calculate effective weights.
    const efficiencyFactor = this._calculateEfficiencyFactor();
    const weightedUnits = this._calculateWeightedUnits(now, efficiencyFactor);

    // Step 3: Distribute worker pool proportionally to effective share weight.
    const workerDistributions = new Map();
    let totalEffectiveWeight = 0;
    for (const ws of weightedUnits) {
      totalEffectiveWeight += ws.effectiveWeight;
    }

    if (totalEffectiveWeight === 0) {
      // No eligible units in window — the entire batch reward (including
      // the operator deduction) is credited to the operator wallet.  This
      // matches the behaviour of ckpool and slush when the share window is
      // empty.
      this._creditOperator(grossReward, block);
      return this._recordDistribution(block, 0, grossReward, efficiencyFactor, new Map());
    }

    let distributedTotal = 0;
    for (const ws of weightedUnits) {
      const proportion = ws.effectiveWeight / totalEffectiveWeight;
      const distribution = Math.floor(workerPool * proportion);

      if (distribution > 0) {
        const current = workerDistributions.get(ws.address) || 0;
        workerDistributions.set(ws.address, current + distribution);
        distributedTotal += distribution;
      }
    }

    // Step 4: Credit worker pending balances.
    for (const [address, amount] of workerDistributions) {
      store.creditPending(address, amount);
    }

    // Step 5: Credit operator wallet with the operator deduction.  Any
    // rounding dust from worker distribution also flows back to the operator
    // so the gross-reward invariant is preserved.
    const roundingDust = workerPool - distributedTotal;
    const operatorCredit = operatorDeduction + roundingDust;
    this._creditOperator(operatorCredit, block);

    return this._recordDistribution(
      block,
      distributedTotal,
      operatorCredit,
      efficiencyFactor,
      workerDistributions
    );
  }

  /**
   * Get the pending (unpaid) balance for a worker.
   * @param {string} address
   * @returns {number} Pending balance in atomic units
   */
  getPendingBalance(address) {
    const pending = store.getPendingBalance(address);
    return pending.balance;
  }

  /**
   * Get recent distribution records.
   * @param {number} [limit=20]
   * @returns {DistributionCalculation[]}
   */
  getDistributions(limit = 20) {
    return this.distributionHistory.slice(-limit);
  }

  /**
   * Run distribution sweep: check all workers with pending >= minDistribution and
   * generate distribution entries.
   * @returns {DistributionEntry[]} Distributions to process
   */
  processDistributions() {
    const distributions = [];
    const allPending = store.getAllPending();

    for (const [address, entry] of allPending) {
      if (entry.balance >= this.minDistribution) {
        const amount = entry.balance;
        store.debitPending(address, amount);

        distributions.push({
          address,
          amount,
          timestamp: Date.now(),
          txHash: null, // filled by the actual distribution processor
        });
      }
    }

    return distributions;
  }

  /**
   * Update the network difficulty (called by chain scanner).
   * @param {number} difficulty
   */
  setNetworkDifficulty(difficulty) {
    this.networkDifficulty = difficulty;
  }

  // ---------------------------------------------------------------------------
  // Internal calculations
  // ---------------------------------------------------------------------------

  /**
   * Calculate the efficiency factor based on the variance of recent share
   * difficulties.
   *
   * In a perfectly uniform pool every share would have the same difficulty,
   * yielding efficiency_factor = 1.0.  In practice, variable-difficulty
   * workers create variance that reduces effective pool efficiency.
   *
   * Formula:
   *   pool_variance = stddev(recent_share_difficulties)
   *   efficiency_factor = max(0.1, 1 - (pool_variance / network_difficulty))
   *
   * @returns {number} Efficiency factor in range [0.1, 1.0]
   * @private
   */
  _calculateEfficiencyFactor() {
    const diffs = this._recentShareDiffs;

    if (diffs.length < MIN_SHARES_FOR_VARIANCE) {
      return 1.0;
    }

    const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / diffs.length;
    const stddev = Math.sqrt(variance);

    const factor = 1 - (stddev / this.networkDifficulty);
    return Math.max(0.1, Math.min(1.0, factor));
  }

  /**
   * Calculate exponentially time-decayed, difficulty-weighted units.
   *
   * For each share in the window:
   *   age_seconds = (now - share.timestamp) / 1000
   *   decay = e^(-λ × age_seconds)
   *   effective_weight = difficulty × efficiency_factor × decay
   *
   * @param {number} now                - Current timestamp (ms)
   * @param {number} efficiencyFactor   - From _calculateEfficiencyFactor()
   * @returns {Array<{address: string, effectiveWeight: number}>}
   * @private
   */
  _calculateWeightedUnits(now, efficiencyFactor) {
    const result = [];

    for (const share of this.shareWindow) {
      const ageSeconds = (now - share.timestamp) / 1000;
      const decay = Math.exp(-this._decayLambda * Math.max(0, ageSeconds));
      const effectiveWeight = share.difficulty * efficiencyFactor * decay;

      if (effectiveWeight > 0) {
        result.push({ address: share.address, effectiveWeight });
      }
    }

    return result;
  }

  /**
   * Trim the share window to maintain the target size.
   * @private
   */
  _trimWindow() {
    const targetSize = this.networkDifficulty * this.windowMultiplier;

    while (this.windowTotalDiff > targetSize && this.shareWindow.length > 0) {
      const removed = this.shareWindow.pop();
      this.windowTotalDiff -= removed.difficulty;
    }
  }

  /**
   * Credit the operator wallet with retained amount.
   * @param {number} amount
   * @param {Object} block
   * @private
   */
  _creditOperator(amount, block) {
    if (this.poolWallet && amount > 0) {
      store.creditPending(this.poolWallet, amount);
    }
  }

  /**
   * Record a distribution calculation in history.
   * @private
   */
  _recordDistribution(block, distributed, operatorCredit, efficiencyFactor, workerDistributions) {
    const record = {
      blockHash: block.hash,
      blockHeight: block.height,
      timestamp: Date.now(),
      grossReward: block.reward,
      fees: { ...this.fees },
      operatorCredit,
      distributed,
      efficiencyFactor: efficiencyFactor.toFixed(6),
      workerCount: workerDistributions.size,
      workers: Object.fromEntries(workerDistributions),
    };

    this.distributionHistory.push(record);
    if (this.distributionHistory.length > 1000) {
      this.distributionHistory.shift();
    }

    return record;
  }
}

module.exports = PDLSEngine;

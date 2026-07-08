'use strict';

/**
 * @fileoverview In-memory state store for PearlPool.
 *
 * Centralizes all runtime pool state: connected workers, found blocks,
 * pending distributions, pool statistics, and throughput history.
 * EventEmitter-based so other components can subscribe to state changes.
 *
 * @author PearlPool Contributors
 * @license MIT
 */

const { EventEmitter } = require('events');

/**
 * Maximum number of throughput history snapshots to retain.
 * At one snapshot every 5 minutes, 288 entries = 24 hours.
 */
const MAX_HASHRATE_HISTORY = 288;

/**
 * Maximum number of blocks to keep in the recent-blocks ring buffer.
 */
const MAX_BLOCK_HISTORY = 500;

/**
 * Maximum number of distribution records to retain in history.
 */
const MAX_PAYOUT_HISTORY = 1000;

class PoolStore extends EventEmitter {
  constructor() {
    super();

    /** @type {Map<string, WorkerState>} Connected workers keyed by wallet address */
    this.workers = new Map();

    /** @type {BlockRecord[]} Ring buffer of recently found blocks */
    this.blocks = [];

    /** @type {Map<string, PendingBalance>} Pending distribution balances keyed by address */
    this.pendingDistributions = new Map();

    /** @type {PoolStats} Aggregate pool statistics */
    this.stats = {
      totalThroughput: 0,
      connectedWorkers: 0,
      blocksFound: 0,
      uptime: Date.now(),
      networkDifficulty: 0,
      networkThroughput: 0,
      networkHeight: 0,
      lastBlockTime: null,
    };

    /** @type {ThroughputSnapshot[]} 24h rolling throughput history */
    this.throughputHistory = [];

    /** @type {DistributionRecord[]} History of completed distributions */
    this.distributionHistory = [];
  }

  // ---------------------------------------------------------------------------
  // Worker management
  // ---------------------------------------------------------------------------

  /**
   * Get the state object for a single worker.
   * @param {string} address - Worker wallet address
   * @returns {WorkerState|null}
   */
  getWorker(address) {
    return this.workers.get(address) || null;
  }

  /**
   * Return an array of every connected worker and their stats.
   * @returns {WorkerState[]}
   */
  getAllWorkers() {
    return Array.from(this.workers.values());
  }

  /**
   * Upsert a worker's state.  Merges partial updates into the existing record
   * so callers can send only the fields that changed.
   *
   * @param {string} address - Wallet address (primary key)
   * @param {Partial<WorkerState>} data - Fields to merge
   * @returns {WorkerState} The merged worker record
   */
  updateWorker(address, data) {
    const existing = this.workers.get(address) || {
      address,
      throughput: 0,
      units: 0,
      accepted: 0,
      rejected: 0,
      lastSeen: Date.now(),
      difficulty: 0,
      workers: [],
    };

    const updated = { ...existing, ...data, address, lastSeen: Date.now() };
    this.workers.set(address, updated);

    this.emit('workerUpdated', updated);
    this._recalcPoolThroughput();

    return updated;
  }

  /**
   * Register a new worker (rig) under a worker address.
   * If the worker doesn't exist yet, creates a blank record first.
   *
   * @param {string} address
   * @param {string} workerId
   * @param {string} [ip]
   * @returns {WorkerState}
   */
  addWorker(address, workerId, ip) {
    const worker = this.workers.get(address) || {
      address,
      throughput: 0,
      units: 0,
      accepted: 0,
      rejected: 0,
      lastSeen: Date.now(),
      difficulty: 0,
      workers: [],
    };

    const existingIdx = worker.workers.findIndex((w) => w.id === workerId);
    if (existingIdx === -1) {
      worker.workers.push({ id: workerId, ip: ip || 'unknown', connectedAt: Date.now(), throughput: 0 });
    } else {
      worker.workers[existingIdx].lastSeen = Date.now();
      if (ip) worker.workers[existingIdx].ip = ip;
    }

    worker.lastSeen = Date.now();
    this.workers.set(address, worker);
    this.emit('workerAdded', { address, workerId });
    return worker;
  }

  /**
   * Remove a worker entirely (e.g. on disconnect with no remaining workers).
   * @param {string} address
   * @returns {boolean} true if the worker existed and was removed
   */
  removeWorker(address) {
    const existed = this.workers.delete(address);
    if (existed) {
      this.emit('workerRemoved', address);
      this._recalcPoolThroughput();
    }
    return existed;
  }

  /**
   * Recalculate the pool-wide aggregate throughput from all connected workers.
   * Called internally whenever a worker is added, updated, or removed.
   * @private
   */
  _recalcPoolThroughput() {
    let total = 0;
    for (const worker of this.workers.values()) {
      total += worker.throughput || 0;
    }
    this.stats.totalThroughput = total;
    this.stats.connectedWorkers = this.workers.size;
  }

  // ---------------------------------------------------------------------------
  // Block management
  // ---------------------------------------------------------------------------

  /**
   * Record a newly found block.
   * @param {BlockRecord} block
   * @returns {BlockRecord}
   */
  addBlock(block) {
    const record = {
      hash: block.hash,
      height: block.height,
      timestamp: block.timestamp || Date.now(),
      reward: block.reward || 0,
      confirmations: block.confirmations || 0,
      finder: block.finder || 'unknown',
      orphaned: false,
    };

    this.blocks.unshift(record);

    // Trim to max history
    if (this.blocks.length > MAX_BLOCK_HISTORY) {
      this.blocks.length = MAX_BLOCK_HISTORY;
    }

    this.stats.blocksFound++;
    this.stats.lastBlockTime = record.timestamp;

    this.emit('blockFound', record);
    return record;
  }

  /**
   * Update confirmation count for a previously found block.
   * @param {string} hash - Block hash
   * @param {number} confirmations
   */
  updateBlockConfirmations(hash, confirmations) {
    const block = this.blocks.find((b) => b.hash === hash);
    if (block) {
      block.confirmations = confirmations;
      this.emit('blockConfirmations', { hash, confirmations });
    }
  }

  /**
   * Mark a block as orphaned.
   * @param {string} hash
   */
  markBlockOrphaned(hash) {
    const block = this.blocks.find((b) => b.hash === hash);
    if (block) {
      block.orphaned = true;
      this.emit('blockOrphaned', { hash });
    }
  }

  /**
   * Get the N most recent blocks.
   * @param {number} [limit=20]
   * @returns {BlockRecord[]}
   */
  getRecentBlocks(limit = 20) {
    return this.blocks.slice(0, limit);
  }

  /**
   * Get all blocks.
   * @returns {BlockRecord[]}
   */
  getAllBlocks() {
    return this.blocks;
  }

  // ---------------------------------------------------------------------------
  // Pending distributions & balances
  // ---------------------------------------------------------------------------

  /**
   * Get pending balance info for a worker.
   * @param {string} address
   * @returns {PendingBalance}
   */
  getPendingBalance(address) {
    return this.pendingDistributions.get(address) || { balance: 0, totalPaid: 0, lastDistribution: null };
  }

  /**
   * Credit a worker's pending balance (called after batch reward distribution).
   * @param {string} address
   * @param {number} amount - Amount to add to pending balance (in PRL atomic units)
   */
  creditPending(address, amount) {
    const pending = this.pendingDistributions.get(address) || { balance: 0, totalPaid: 0, lastDistribution: null };
    pending.balance += amount;
    this.pendingDistributions.set(address, pending);
    this.emit('balanceCredited', { address, amount, newBalance: pending.balance });
  }

  /**
   * Debit a worker's pending balance (called when a distribution is sent).
   * @param {string} address
   * @param {number} amount
   */
  debitPending(address, amount) {
    const pending = this.pendingDistributions.get(address);
    if (!pending) return;

    pending.balance -= amount;
    if (pending.balance < 0) pending.balance = 0;
    pending.totalPaid += amount;
    pending.lastDistribution = Date.now();

    this.pendingDistributions.set(address, pending);
    this.emit('balanceDebited', { address, amount, newBalance: pending.balance });
  }

  /**
   * Return all workers with a non-zero pending balance.
   * @returns {Array<{address: string} & PendingBalance>}
   */
  getAllPendingBalances() {
    const result = [];
    for (const [address, data] of this.pendingDistributions) {
      if (data.balance > 0 || data.totalPaid > 0) {
        result.push({ address, ...data });
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Distribution history
  // ---------------------------------------------------------------------------

  /**
   * Append a completed distribution record to the history.
   * @param {DistributionRecord} record
   */
  addDistributionRecord(record) {
    this.distributionHistory.unshift({
      address: record.address,
      amount: record.amount,
      txHash: record.txHash || null,
      timestamp: record.timestamp || Date.now(),
      blockHeight: record.blockHeight || null,
    });

    if (this.distributionHistory.length > MAX_PAYOUT_HISTORY) {
      this.distributionHistory.length = MAX_PAYOUT_HISTORY;
    }

    this.emit('distributionSent', record);
  }

  /**
   * Get recent distribution records.
   * @param {number} [limit=50]
   * @returns {DistributionRecord[]}
   */
  getDistributionHistory(limit = 50) {
    return this.distributionHistory.slice(0, limit);
  }

  // ---------------------------------------------------------------------------
  // Pool stats & network info
  // ---------------------------------------------------------------------------

  /**
   * Get the current pool statistics snapshot.
   * @returns {PoolStats}
   */
  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.uptime,
      connectedWorkers: this.workers.size,
      totalThroughput: this.stats.totalThroughput,
    };
  }

  /**
   * Get the current batch reward (from network info or default PRL schedule).
   * @returns {number} Block reward in satoshis
   */
  getNetworkBlockReward() {
    return this.stats.blockReward || 50_00000000; // 50 PRL default
  }

  /**
   * Update network-level information (from chain scanner / RPC).
   * @param {Partial<PoolStats>} networkData
   */
  updateNetworkInfo(networkData) {
    if (networkData.networkDifficulty !== undefined) {
      this.stats.networkDifficulty = networkData.networkDifficulty;
    }
    if (networkData.networkThroughput !== undefined) {
      this.stats.networkThroughput = networkData.networkThroughput;
    }
    if (networkData.networkHeight !== undefined) {
      this.stats.networkHeight = networkData.networkHeight;
    }
    this.emit('networkUpdated', networkData);
  }

  // ---------------------------------------------------------------------------
  // Throughput history (24h chart data)
  // ---------------------------------------------------------------------------

  /**
   * Record a throughput snapshot. Called periodically (every 5 min) by pool.js.
   * Automatically trims to MAX_HASHRATE_HISTORY entries (24h window).
   */
  snapshotThroughput() {
    const entry = {
      timestamp: Date.now(),
      throughput: this.stats.totalThroughput,
      workers: this.workers.size,
    };

    this.throughputHistory.push(entry);

    // Trim old entries beyond the 24h window
    while (this.throughputHistory.length > MAX_HASHRATE_HISTORY) {
      this.throughputHistory.shift();
    }

    this.emit('throughputSnapshot', entry);
  }

  /**
   * Get the full 24h throughput history array.
   * @returns {ThroughputSnapshot[]}
   */
  getThroughputHistory() {
    return this.throughputHistory;
  }

  // ---------------------------------------------------------------------------
  // Share accounting helpers
  // ---------------------------------------------------------------------------

  /**
   * Record a share submission for a worker.
   * @param {string} address
   * @param {boolean} accepted
   * @param {number} difficulty
   */
  recordShare(address, accepted, difficulty) {
    const worker = this.workers.get(address);
    if (!worker) return;

    worker.units++;
    if (accepted) {
      worker.accepted++;
    } else {
      worker.rejected++;
    }
    worker.difficulty = difficulty;
    worker.lastSeen = Date.now();

    this.emit('share', { address, accepted, difficulty });
  }

  // ---------------------------------------------------------------------------
  // Snapshot / persistence (JSON file, atomic write, zero deps)
  // ---------------------------------------------------------------------------

  /**
   * Serialise the entire store state to a plain JSON-safe object.
   * EventEmitter internals are not included (they live on the prototype).
   *
   * @returns {object} snapshot
   */
  serialize() {
    return {
      version: 1,
      savedAt: Date.now(),
      workers: Array.from(this.workers.entries()),
      blocks: this.blocks,
      pendingDistributions: Array.from(this.pendingDistributions.entries()),
      stats: { ...this.stats },
      throughputHistory: this.throughputHistory,
      distributionHistory: this.distributionHistory,
    };
  }

  /**
   * Replace store state from a previously-serialised snapshot.
   * Resets `uptime` to `Date.now()` so a restored pool reports zero
   * elapsed time (avoids negative / stale uptime from the snapshot).
   *
   * @param {object} snapshot - The object previously returned by serialize()
   * @returns {boolean} true if state was replaced, false if snapshot was null
   * @throws {Error} on version mismatch or invalid shape
   */
  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (snapshot.version !== 1) {
      throw new Error(
        `Unsupported snapshot version: ${snapshot.version}. ` +
        `This build of PearlPool understands version 1.`
      );
    }

    this.workers = new Map(Array.isArray(snapshot.workers) ? snapshot.workers : []);
    this.blocks = Array.isArray(snapshot.blocks) ? snapshot.blocks : [];
    this.pendingDistributions = new Map(
      Array.isArray(snapshot.pendingDistributions) ? snapshot.pendingDistributions : []
    );
    if (snapshot.stats && typeof snapshot.stats === 'object') {
      this.stats = { ...this.stats, ...snapshot.stats, uptime: Date.now() };
    }
    this.throughputHistory = Array.isArray(snapshot.throughputHistory)
      ? snapshot.throughputHistory
      : [];
    this.distributionHistory = Array.isArray(snapshot.distributionHistory)
      ? snapshot.distributionHistory
      : [];

    this._recalcPoolThroughput();
    this.emit('restored', { savedAt: snapshot.savedAt });
    return true;
  }

  /**
   * Atomically write the current store state to a JSON file.
   * See `lib/persistence/json-snapshot.js` for the write semantics
   * (write to `.tmp`, fsync, rename).
   *
   * @param {string} filepath - Target file (e.g. `./data/state.json`)
   * @returns {Promise<void>}
   */
  async persist(filepath) {
    const { save } = require('../lib/persistence/json-snapshot');
    return save(filepath, this.serialize());
  }

  /**
   * Load and apply a snapshot from disk.  Returns `false` if the file
   * does not exist (first start).  Throws on parse / version errors so
   * the caller can log + refuse to start, or fall back to a fresh store.
   *
   * @param {string} filepath
   * @returns {Promise<boolean>} true if state was restored, false on first start
   */
  async restoreFromFile(filepath) {
    const { load } = require('../lib/persistence/json-snapshot');
    const snapshot = await load(filepath);
    if (snapshot === null) return false;
    return this.restore(snapshot);
  }
}

// Create and export a singleton instance
const store = new PoolStore();

module.exports = store;

// ---------------------------------------------------------------------------
// JSDoc type definitions (for editor IntelliSense)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WorkerState
 * @property {string} address - Wallet address
 * @property {number} throughput - Current throughput in H/s
 * @property {number} units - Total units submitted
 * @property {number} accepted - Accepted units
 * @property {number} rejected - Rejected/stale units
 * @property {number} lastSeen - Unix timestamp of last activity
 * @property {number} difficulty - Current unit difficulty
 * @property {WorkerInfo[]} workers - Connected worker rigs
 */

/**
 * @typedef {Object} WorkerInfo
 * @property {string} id - Worker identifier
 * @property {string} ip - Worker IP address
 * @property {number} connectedAt - Connection timestamp
 * @property {number} throughput - Worker throughput in H/s
 * @property {number} [lastSeen] - Last activity timestamp
 */

/**
 * @typedef {Object} BlockRecord
 * @property {string} hash - Block hash
 * @property {number} height - Block height
 * @property {number} timestamp - When block was found
 * @property {number} reward - Block reward in atomic units
 * @property {number} confirmations - Current confirmation count
 * @property {string} finder - Address of the worker who found it
 * @property {boolean} orphaned - Whether block was orphaned
 */

/**
 * @typedef {Object} PendingBalance
 * @property {number} balance - Pending (unpaid) balance
 * @property {number} totalPaid - Cumulative amount paid out
 * @property {number|null} lastDistribution - Timestamp of last distribution, or null
 */

/**
 * @typedef {Object} PoolStats
 * @property {number} totalThroughput - Pool-wide throughput in H/s
 * @property {number} connectedWorkers - Number of connected workers
 * @property {number} blocksFound - Total batches processed by pool
 * @property {number} uptime - Milliseconds since pool started
 * @property {number} networkDifficulty - Current network difficulty
 * @property {number} networkThroughput - Estimated network throughput
 * @property {number} networkHeight - Current blockchain height
 * @property {number|null} lastBlockTime - Timestamp of last pool block
 */

/**
 * @typedef {Object} ThroughputSnapshot
 * @property {number} timestamp - Snapshot time
 * @property {number} throughput - Pool throughput at snapshot
 * @property {number} workers - Connected worker count at snapshot
 */

/**
 * @typedef {Object} DistributionRecord
 * @property {string} address - Recipient address
 * @property {number} amount - Distribution amount
 * @property {string|null} txHash - Transaction hash
 * @property {number} timestamp - When distribution was sent
 * @property {number|null} [blockHeight] - Associated block height
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const SAFE_STEP_LABELS = new Set([
  'Portal Login', 'Basic Information', 'Customer Qualification', 'Address Validation',
  'Recommendations', 'Internet Category', 'Internet Offers', 'Plan Selection',
  'Open Plan Details', 'Plan Verification', 'Add Plan to Order', 'Cart Verification',
  'Open Checkout', 'Checkout Inspection', 'Product Customization Inspection',
  'Apply Customizations', 'Advance to Product Customization', 'Account Holder Validation',
  'Account Holder Forward', 'Demo Credit Check, Installation and Payment'
]);

function safeOutcome(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,40}$/i.test(value)
    ? value
    : 'unknown';
}

function safeSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const allowed = [
    'status', 'totalRecordedSteps', 'completedSteps', 'failedSteps',
    'lastReachedStep', 'failedStep', 'workflowCompleted',
    'orderSummaryReached', 'orderConfirmationReached', 'placeOrderClicked',
    'finalOrderSubmitted', 'durationMs'
  ];
  const result = {};
  for (const key of allowed) {
    const value = summary[key];
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
      result[key] = value;
    } else if (key === 'status' && typeof value === 'string') {
      result[key] = safeOutcome(value);
    } else if ((key === 'lastReachedStep' || key === 'failedStep') && SAFE_STEP_LABELS.has(value)) {
      result[key] = value;
    }
  }
  return result;
}

function safeSafetyCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const fields = ['creditCheckPerformed', 'paymentPerformed', 'installationConfirmed', 'finalOrderSubmitted'];
  return Object.fromEntries(fields.map(field => [field, checkpoint[field] === true]));
}

function publicJob(job) {
  return JSON.parse(JSON.stringify(job));
}

class JobManager {
  constructor(options = {}) {
    this.filePath = path.resolve(options.filePath || process.env.JOB_STORE_PATH || path.join(process.cwd(), '.data', 'jobs.json'));
    this.maxHistory = Number.isInteger(options.maxHistory) && options.maxHistory > 0
      ? options.maxHistory
      : 500;
    this.jobs = new Map();
    this.queue = [];
    this.activeJobId = null;
    this.pumping = false;
    this.idleWaiters = new Set();
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const entries = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
      for (const item of entries.slice(-this.maxHistory)) {
        if (!item || typeof item.id !== 'string' || !/^[a-f0-9-]{36}$/i.test(item.id)) continue;
        const job = {
          id: item.id,
          status: TERMINAL_STATES.has(item.status) ? item.status : 'failed',
          source: safeOutcome(item.source),
          createdAt: item.createdAt || null,
          startedAt: item.startedAt || null,
          finishedAt: item.finishedAt || new Date().toISOString(),
          durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
          outcome: item.outcome ? safeOutcome(item.outcome) : 'process_interrupted',
          summary: safeSummary(item.summary),
          safetyCheckpoint: safeSafetyCheckpoint(item.safetyCheckpoint),
          failure: item.failure && typeof item.failure === 'object'
            ? { type: safeOutcome(item.failure.type), code: safeOutcome(item.failure.code) }
            : TERMINAL_STATES.has(item.status)
              ? null
              : { type: 'interrupted', code: 'PROCESS_RESTARTED' }
        };
        this.jobs.set(job.id, job);
      }
      this._persist();
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(`Job history could not be loaded (${error.code || 'invalid_store'}).`);
      }
    }
  }

  _persist() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    while (this.jobs.size > this.maxHistory) {
      const oldestId = this.jobs.keys().next().value;
      this.jobs.delete(oldestId);
    }
    const jobs = [...this.jobs.values()].slice(-this.maxHistory);
    const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, jobs }, null, 2), {
        encoding: 'utf8',
        mode: 0o600
      });
      fs.renameSync(temporaryPath, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch { /* temporary file may not exist */ }
      throw error;
    }
  }

  enqueue(task, options = {}) {
    if (typeof task !== 'function') throw new TypeError('Job task must be a function.');
    if (this.queue.length >= (options.maxQueueLength || 100)) {
      const error = new Error('Automation queue is full.');
      error.code = 'JOB_QUEUE_FULL';
      throw error;
    }

    const id = crypto.randomUUID();
    const job = {
      id,
      status: 'queued',
      source: safeOutcome(options.source || 'api'),
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      outcome: null,
      summary: null,
      safetyCheckpoint: null,
      failure: null
    };
    let resolveCompletion;
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    this.jobs.set(id, job);
    this.queue.push({ id, task, onCancel: options.onCancel, resolveCompletion });
    try {
      this._persist();
    } catch (error) {
      this.queue = this.queue.filter(item => item.id !== id);
      this.jobs.delete(id);
      throw error;
    }
    const snapshot = publicJob(job);
    queueMicrotask(() => this._pump().catch(() => {}));
    return { job: snapshot, completion };
  }

  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        const job = this.jobs.get(item.id);
        if (!job || job.status !== 'queued') continue;
        this.activeJobId = job.id;
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        try { this._persist(); } catch { console.error('[JOBS] Job start state could not be persisted.'); }
        const started = Date.now();
        let report = null;
        let error = null;
        try {
          report = await item.task();
          const outcome = safeOutcome(report?.status || 'unknown');
          job.status = outcome === 'failed' ? 'failed' : 'completed';
          job.outcome = outcome;
          job.summary = safeSummary(report?.summary);
          job.safetyCheckpoint = safeSafetyCheckpoint(report?.safetyCheckpoint);
        } catch (caught) {
          error = caught;
          job.status = 'failed';
          job.outcome = 'failed';
          job.failure = {
            type: safeOutcome(caught?.failureType || 'automation'),
            code: safeOutcome(caught?.failureCode || caught?.code || 'AUTOMATION_FAILED')
          };
        } finally {
          job.finishedAt = new Date().toISOString();
          job.durationMs = Date.now() - started;
          this.activeJobId = null;
          try { this._persist(); } catch { console.error('[JOBS] Job completion state could not be persisted.'); }
          item.resolveCompletion({ job: publicJob(job), report, error });
        }
      }
    } finally {
      this.activeJobId = null;
      this.pumping = false;
      if (this.queue.length > 0) this._pump().catch(() => {});
      else this._notifyIdle();
    }
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? publicJob(job) : null;
  }

  list(limit = 50) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
    return [...this.jobs.values()].slice(-safeLimit).reverse().map(publicJob);
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return false;
    const index = this.queue.findIndex(item => item.id === id);
    if (index < 0) return false;
    const [item] = this.queue.splice(index, 1);
    try { if (typeof item.onCancel === 'function') item.onCancel(); } catch { /* cancellation cleanup is best-effort */ }
    job.status = 'cancelled';
    job.outcome = 'cancelled';
    job.finishedAt = new Date().toISOString();
    job.durationMs = 0;
    try { this._persist(); } catch { console.error('[JOBS] Job cancellation state could not be persisted.'); }
    item.resolveCompletion({ job: publicJob(job), report: null, error: null });
    this._notifyIdle();
    return true;
  }

  cancelQueued() {
    const queuedIds = this.queue.map(item => item.id);
    let cancelled = 0;
    for (const id of queuedIds) if (this.cancel(id)) cancelled += 1;
    return cancelled;
  }

  waitForIdle() {
    if (!this.isRunning && this.queue.length === 0 && !this.pumping) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.add(resolve));
  }

  _notifyIdle() {
    if (this.isRunning || this.queue.length > 0 || this.pumping) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  get isRunning() {
    return this.activeJobId !== null;
  }

  get queueLength() {
    return this.queue.length;
  }

  get activeId() {
    return this.activeJobId;
  }
}

module.exports = { JobManager, safeSummary, safeSafetyCheckpoint };

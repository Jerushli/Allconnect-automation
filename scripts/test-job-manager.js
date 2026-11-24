'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobManager } = require('../src/jobManager');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'allconnect-job-test-'));
  const filePath = path.join(directory, 'jobs.json');
  try {
    const manager = new JobManager({ filePath });
    const order = [];
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    const first = manager.enqueue(async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
      return { status: 'completed', summary: { workflowCompleted: true } };
    }, { source: 'smoke_test' });
    const second = manager.enqueue(async () => {
      order.push('second-start');
      return { status: 'completed', summary: { workflowCompleted: true } };
    }, { source: 'smoke_test' });

    assert.equal(first.job.status, 'queued');
    assert.equal(second.job.status, 'queued');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(order, ['first-start']);
    releaseFirst();
    assert.equal((await first.completion).job.status, 'completed');
    assert.equal((await second.completion).job.status, 'completed');
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start']);

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(persisted.jobs.length, 2);
    const reloadedCompleted = new JobManager({ filePath }).get(first.job.id);
    assert.equal(reloadedCompleted.status, 'completed');
    assert.equal(reloadedCompleted.failure, null);

    const sanitized = manager.enqueue(async () => ({
      status: 'completed',
      summary: { workflowCompleted: true, lastReachedStep: '123456789', failedStep: 'private@example.test' }
    }));
    const sanitizedResult = await sanitized.completion;
    assert.equal(JSON.stringify(sanitizedResult.job).includes('123456789'), false);
    assert.equal(JSON.stringify(sanitizedResult.job).includes('private@example.test'), false);

    const interruptedId = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, jobs: [
      { id: interruptedId, status: 'running', source: 'smoke_test', createdAt: new Date().toISOString() }
    ] }));
    const restarted = new JobManager({ filePath });
    assert.equal(restarted.get(interruptedId).status, 'failed');
    assert.equal(restarted.get(interruptedId).failure.code, 'PROCESS_RESTARTED');

    let releaseActive;
    const activeGate = new Promise(resolve => { releaseActive = resolve; });
    const active = manager.enqueue(async () => { await activeGate; return { status: 'completed' }; });
    let sensitiveCleanupCalled = false;
    const queued = manager.enqueue(async () => ({ status: 'completed' }), {
      onCancel: () => { sensitiveCleanupCalled = true; }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(manager.cancel(queued.job.id), true);
    assert.equal(sensitiveCleanupCalled, true);
    assert.equal((await queued.completion).job.status, 'cancelled');
    releaseActive();
    assert.equal((await active.completion).job.status, 'completed');
    await manager.waitForIdle();
    assert.equal(manager.isRunning, false);
    assert.equal(manager.queueLength, 0);

    console.log('PASS: single-worker queue ordering');
    console.log('PASS: persistent job history and reload');
    console.log('PASS: interrupted jobs recovered after process restart');
    console.log('PASS: queued cancellation and sensitive-input cleanup');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error('FAIL: job manager smoke test');
  console.error(error.message);
  process.exitCode = 1;
});

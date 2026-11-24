'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JobManager } = require('../src/jobManager');

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'allconnect-jobs-'));
  return { directory, filePath: path.join(directory, 'jobs.json') };
}

test('job manager serializes jobs and persists sanitized history', async () => {
  const temp = temporaryStore();
  const manager = new JobManager({ filePath: temp.filePath });
  const order = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });

  const first = manager.enqueue(async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
    return { status: 'completed', summary: { workflowCompleted: true, totalRecordedSteps: 2 } };
  }, { source: 'test' });
  const second = manager.enqueue(async () => {
    order.push('second-start');
    return { status: 'completed', summary: { workflowCompleted: true } };
  }, { source: 'test' });

  expect(first.job.status).toBe('queued');
  expect(second.job.status).toBe('queued');
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(order).toEqual(['first-start']);
  releaseFirst();
  const firstResult = await first.completion;
  const secondResult = await second.completion;
  expect(firstResult.job.status).toBe('completed');
  expect(secondResult.job.status).toBe('completed');
  expect(order).toEqual(['first-start', 'first-end', 'second-start']);

  const persisted = JSON.parse(fs.readFileSync(temp.filePath, 'utf8'));
  expect(persisted.jobs).toHaveLength(2);
  expect(JSON.stringify(persisted)).not.toContain('sensitiveData');
  const reloaded = new JobManager({ filePath: temp.filePath });
  expect(reloaded.get(first.job.id).status).toBe('completed');
  fs.rmSync(temp.directory, { recursive: true, force: true });
});

test('queued jobs can be cancelled without cancelling the active worker', async () => {
  const temp = temporaryStore();
  const manager = new JobManager({ filePath: temp.filePath });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const active = manager.enqueue(async () => { await gate; return { status: 'completed' }; });
  const queued = manager.enqueue(async () => ({ status: 'completed' }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(manager.cancel(queued.job.id)).toBe(true);
  expect((await queued.completion).job.status).toBe('cancelled');
  release();
  expect((await active.completion).job.status).toBe('completed');
  fs.rmSync(temp.directory, { recursive: true, force: true });
});


test('marks queued and running jobs as interrupted after a process restart', () => {
  const temp = temporaryStore();
  const interruptedId = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(temp.filePath, JSON.stringify({
    version: 1,
    jobs: [
      { id: interruptedId, status: 'running', source: 'test', createdAt: new Date().toISOString() }
    ]
  }));
  const reloaded = new JobManager({ filePath: temp.filePath });
  const job = reloaded.get(interruptedId);
  expect(job.status).toBe('failed');
  expect(job.outcome).toBe('process_interrupted');
  expect(job.failure.code).toBe('PROCESS_RESTARTED');
  fs.rmSync(temp.directory, { recursive: true, force: true });
});

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { JobManager } = require('../src/jobManager');

const API_TOKEN = 'job-api-test-token';
let directory;
let manager;
let server;
let baseUrl;
let activeJob;
let queuedJob;
let releaseActive;
let activeStarted;

function authHeaders() {
  return { Authorization: `Bearer ${API_TOKEN}` };
}

test.describe('Persistent automation job API', () => {
  test.beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'allconnect-job-api-'));
    manager = new JobManager({ filePath: path.join(directory, 'jobs.json') });
    const gate = new Promise(resolve => { releaseActive = resolve; });
    const started = new Promise(resolve => { activeStarted = resolve; });
    activeJob = manager.enqueue(async () => {
      activeStarted();
      await gate;
      return { status: 'completed', summary: { workflowCompleted: true } };
    }, { source: 'api_test' });
    queuedJob = manager.enqueue(async () => ({ status: 'completed' }), { source: 'api_test' });
    await started;

    const app = createApp({
      apiToken: API_TOKEN,
      jobManager: manager,
      jweKeys: { publicKey: 'test-public-key', privateKey: 'test-private-key', kid: 'test-kid' }
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.afterAll(async () => {
    if (releaseActive) releaseActive();
    if (activeJob) await activeJob.completion;
    if (server) await new Promise(resolve => server.close(resolve));
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  test('requires API authentication for job history', async () => {
    const response = await fetch(`${baseUrl}/api/jobs`);
    expect(response.status).toBe(401);
  });

  test('lists queued and running jobs without exposing task input', async () => {
    const response = await fetch(`${baseUrl}/api/jobs`, { headers: authHeaders() });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobs.some(job => job.id === activeJob.job.id && job.status === 'running')).toBe(true);
    expect(body.jobs.some(job => job.id === queuedJob.job.id && job.status === 'queued')).toBe(true);
    expect(JSON.stringify(body)).not.toContain('sensitiveData');
  });

  test('returns job details and cancels queued jobs only', async () => {
    const detail = await fetch(`${baseUrl}/api/jobs/${queuedJob.job.id}`, { headers: authHeaders() });
    expect(detail.status).toBe(200);
    expect((await detail.json()).job.status).toBe('queued');

    const cancelled = await fetch(`${baseUrl}/api/jobs/${queuedJob.job.id}/cancel`, {
      method: 'POST', headers: authHeaders()
    });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).job.status).toBe('cancelled');

    const activeCancel = await fetch(`${baseUrl}/api/jobs/${activeJob.job.id}/cancel`, {
      method: 'POST', headers: authHeaders()
    });
    expect(activeCancel.status).toBe(409);
  });
});

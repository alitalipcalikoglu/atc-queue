import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { QueueService } from '../src/domain/queue-service.js';
import { QueueStore } from '../src/store/queue-store.js';
import { testEnv } from './helpers.js';

const CLAIM_WORKER = fileURLToPath(new URL('./helpers/claim-worker.js', import.meta.url));

// Several OS threads, each with its own SQLite connection to one file, race for the same ready
// messages. A message may be leased by exactly one of them.
test('Concurrency: real connections racing for the same ready messages never lease one twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queue-claim-'));
  try {
    const path = join(dir, 'queue.db');
    const db = new Database(path);
    const config = Config.fromEnv(testEnv());
    const service = new QueueService({ db, store: new QueueStore(db), limits: config.limits });
    service.putQueue('jobs', {}, 'test');
    const N = 30;
    service.enqueue('jobs', Array.from({ length: N }, (_, i) => ({ body: `m${i}` })), 'test');
    db.close();

    const now = Date.now() + 1000;
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const w = new Worker(CLAIM_WORKER, { workerData: { path, queue: 'jobs', now, leaseMs: 30_000, batch: 4, attempts: 6 } });
      w.once('message', resolve);
      w.once('error', reject);
    })));
    const all = results.flatMap((r) => /** @type {{ claimed: string[] }} */ (r).claimed);
    assert.equal(all.length, N, 'every message leased once across all threads');
    assert.equal(new Set(all).size, N, 'no message id leased twice');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { parentPort, workerData } from 'node:worker_threads';
import { Database } from '../../src/db.js';
import { QueueStore } from '../../src/store/queue-store.js';

/** One OS thread with its own SQLite connection to the shared file. @type {{ path: string, queue: string, now: number, leaseMs: number, batch: number, attempts: number }} */
const { path, queue, now, leaseMs, batch, attempts } = workerData;

/** Opening many connections at once can hit SQLITE_LOCKED during the migration bootstrap; that race is not what the test checks. */
function open() {
  for (let i = 0; ; i++) {
    try {
      return new Database(path);
    } catch (err) {
      if (i >= 20 || !/locked|busy/i.test(/** @type {Error} */ (err).message)) throw err;
      const until = Date.now() + 10;
      while (Date.now() < until);
    }
  }
}

const db = open();
const store = new QueueStore(db);
/** @type {string[]} */
const claimed = [];
for (let i = 0; i < attempts; i++) {
  for (const m of db.transaction(() => store.claim(queue, now, batch, leaseMs))) claimed.push(m.id);
}
db.close();
parentPort?.postMessage({ claimed });

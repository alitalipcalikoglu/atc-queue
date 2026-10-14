# Operations

```bash
curl -s $QUEUE/health ; curl -s $QUEUE/ready ; curl -s $QUEUE/v1/info
qcurl $QUEUE/v1/stats      # queues, ready, delayed, leased, dead, oldestReadySec, per queue with counters
qcurl $QUEUE/metrics
```

```
queue_messages{queue="emails",state="ready"} 12
queue_messages{queue="emails",state="dead"} 0
queue_oldest_ready_seconds{queue="emails"} 3
queue_events_total{queue="emails",event="acked"} 18210
```

Alert on `queue_oldest_ready_seconds` (consumers falling behind) and on dead letters above zero.

```bash
cp .env.example .env && npm ci --omit=dev && pm2 start ecosystem.config.cjs
docker build -t atc-queue . && docker run -d -p 3016:3016 -v queue-data:/data --env-file .env atc-queue
```

All state is the SQLite file at `DB_PATH` (WAL). One process per file. `sqlite3 data/queue.db "VACUUM INTO 'backup.db'"` takes an online copy; a restored copy redelivers messages that were leased at backup time once their leases expire.

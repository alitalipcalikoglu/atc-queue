# Events

```bash
WEBHOOK_OUT_URL=http://webhook-out.internal:3009
WEBHOOK_OUT_API_KEY=<a webhook-out key with the publish role>
```

| Event | When | Data |
|---|---|---|
| `ops.queue.dead_letter` | The dead-letter count of a queue grew since the last maintenance run (`REAP_MS`), whether by `nack`, `dead: true` or an expired last lease | `queue`, `count` (new), `dead` (total) |
| `ops.queue.dead_expired` | Dead letters older than `DEAD_RETENTION_DAYS` were removed | `removed`, `retentionDays` |

One event per queue per run, however many messages died, so a poison message storm is one alert and not thousands. The dead letters present at start-up are not announced; only growth afterwards. A redrive or purge lowers the baseline, so the next death is announced again.

A subscription on `ops.*` (the atc-status alert hub) turns these into e-mails and an acknowledgeable alert. Events are queued in memory and sent in the background with retries; watch `events_publish_total{result="dropped|failed"}` on `/metrics`.

Pitfalls:
- Dead-letter retention still deletes without asking; `ops.queue.dead_expired` tells you it happened, not what was lost. Export or redrive before the window ends.

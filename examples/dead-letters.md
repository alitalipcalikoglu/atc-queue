# Retries and dead letters

A message goes back to `ready` after a nack or when its lease expires, waiting `backoffBaseSec * 2^(attempts-1)` (capped at `backoffMaxSec`). When it has been delivered `maxAttempts` times, the next failure makes it a **dead letter**: `state: "dead"`, kept with its `lastError` until redriven, deleted, purged or `DEAD_RETENTION_DAYS` (14) after it died.

## Scenario: the mail provider was down for an hour

```bash
qcurl "$QUEUE/v1/queues/emails/messages?state=dead&limit=50"
# { "items": [ { "id": "msg_...", "attempts": 5, "lastError": "smtp 451 try later", "deadAt": "..." } ], "nextCursor": null }

qadmin -X POST $QUEUE/v1/queues/emails/redrive -d '{ "all": true }'                 # { "redriven": 37 }
qadmin -X POST $QUEUE/v1/queues/emails/redrive -d '{ "ids": ["msg_a...", "msg_b..."] }'
```

Redriven messages are ready at once with `attempts` reset to 0.

A lease that expires counts as a failed delivery (`lastError: "lease expired"`); the reaper runs every `REAP_MS` (1 s).

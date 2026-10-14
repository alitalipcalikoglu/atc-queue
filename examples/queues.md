# Queues

```bash
qadmin -X PUT $QUEUE/v1/queues/emails -d '{ "description": "Outbound e-mail jobs", "visibilitySec": 60, "maxAttempts": 5, "backoffBaseSec": 10, "backoffMaxSec": 900 }'
# 201 { "created": true, "queue": { "name": "emails", "visibilitySec": 60, "maxAttempts": 5, ... } }
```

`PUT` creates the queue or changes the given settings (the rest keep their values; defaults on create: visibility 30 s, 5 attempts, backoff 5 s doubling up to 900 s). Names match `[a-z][a-z0-9._-]{0,63}`.

| Setting | Meaning |
|---|---|
| `visibilitySec` | How long a pulled message stays invisible unless the pull asks otherwise |
| `maxAttempts` | Deliveries before the message becomes a dead letter |
| `backoffBaseSec`, `backoffMaxSec` | Retry delay after the n-th delivery: `base * 2^(n-1)`, capped |
| `paused` | `true`: pulls return nothing (enqueue keeps working) — for maintenance of a consumer |

```bash
qadmin -X PUT $QUEUE/v1/queues/emails -d '{ "paused": true }'
qcurl $QUEUE/v1/queues/emails      # settings, depth { ready, delayed, leased, dead }, oldestReadySec, lifetime counters
qadmin -X DELETE "$QUEUE/v1/queues/emails"            # 409 QUEUE_NOT_EMPTY while it holds messages
qadmin -X DELETE "$QUEUE/v1/queues/emails?force=true" # deletes the queue and every message in it
```

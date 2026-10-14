# API keys, roles and scopes

`QUEUE_API_KEYS=id:secret[:role[:queue+queue]]`.

| Role | Can |
|---|---|
| `read` | list queues, browse messages, stats, metrics |
| `write` | enqueue, pull, ack, nack, extend |
| `readwrite` (default) | read + write |
| `admin` | everything: create/update/delete queues, purge, redrive, delete messages |

```
QUEUE_API_KEYS=atc-console:<hex>:admin,shop-api:<hex>:write:emails+orders,mail-worker:<hex>:write:emails,grafana:<hex>:read
```

A key with a queue list gets `403` on any other queue and sees only its queues in `/v1/queues`, `/v1/stats` and `/metrics`. Give every producer and worker its own scoped `write` key; keep `admin` for operators.

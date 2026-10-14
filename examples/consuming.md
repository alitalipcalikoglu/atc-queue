# Consuming

```bash
qcurl -X POST $QUEUE/v1/queues/emails/pull -d '{ "max": 10, "waitSec": 20 }'
```

```json
{ "messages": [ { "id": "msg_mv8...", "body": { "to": "ayse@example.com" }, "attempts": 1, "state": "leased",
  "leaseToken": "3c5d...", "leaseUntil": "2026-10-14T09:01:00.000Z" } ] }
```

A pull leases up to `max` due messages (highest priority, then oldest). With `waitSec` it long-polls until a message arrives or the time is up (at most `MAX_WAIT_SEC`, 20 s), so idle workers do not hammer the service. Every delivery counts as an attempt.

```bash
qcurl -X POST $QUEUE/v1/queues/emails/messages/msg_mv8.../ack    -d '{ "leaseToken": "3c5d..." }'                    # 204: done, deleted
qcurl -X POST $QUEUE/v1/queues/emails/messages/msg_mv8.../nack   -d '{ "leaseToken": "3c5d...", "error": "smtp 451" }' # retry after backoff
qcurl -X POST $QUEUE/v1/queues/emails/messages/msg_mv8.../nack   -d '{ "leaseToken": "3c5d...", "dead": true }'        # poison: dead letter now
qcurl -X POST $QUEUE/v1/queues/emails/messages/msg_mv8.../extend -d '{ "leaseToken": "3c5d...", "visibilitySec": 120 }' # still working
```

## A worker loop

```js
const H = { authorization: `Bearer ${process.env.QUEUE_KEY}`, 'content-type': 'application/json' };
const post = (path, body) => fetch(`${process.env.QUEUE_URL}/v1/queues/emails${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });

for (;;) {
  const { messages } = await (await post('/pull', { max: 10, waitSec: 20 })).json();
  for (const m of messages) {
    try {
      await sendMail(m.body);                                   // idempotent: delivery is at-least-once
      await post(`/messages/${m.id}/ack`, { leaseToken: m.leaseToken });
    } catch (err) {
      await post(`/messages/${m.id}/nack`, { leaseToken: m.leaseToken, error: String(err).slice(0, 500) });
    }
  }
}
```

## Pitfalls

- Delivery is **at least once**: a worker that crashes after doing the work but before acking will see the message again. Make handlers idempotent.
- `409 LEASE_LOST`: the lease ran out (another worker may have the message now) or the token is wrong. Extend long jobs before `leaseUntil`.
- `404 MESSAGE_NOT_FOUND` on ack: the message was already acked, deleted or purged.

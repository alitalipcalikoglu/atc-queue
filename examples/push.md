# Push delivery

Instead of running a worker that pulls, let the queue POST each message to your endpoint. Retries, backoff and dead letters stay the queue's job.

## Turn it on (server)

```
PUSH_SECRETS_KEY=<openssl rand -hex 32>
# for receivers inside your network:
PUSH_ALLOW_HTTP=true
PUSH_ALLOW_PRIVATE=true
PUSH_ALLOWED_HOSTS=workers.internal
```

Without `PUSH_SECRETS_KEY` a `push` setting answers `400 PUSH_DISABLED`. By default only `https` URLs on public addresses are accepted (`400 INVALID_PUSH_URL` otherwise); the address is resolved and pinned on every delivery, so a DNS change cannot point it at an internal host.

Private receivers need both settings: `PUSH_ALLOW_PRIVATE=true` alone stops the service at startup (`PUSH_ALLOWED_HOSTS is required when PUSH_ALLOW_PRIVATE is true`), because "any internal address" would let any admin key reach every internal service. After DNS resolution a private address is accepted only for a host on `PUSH_ALLOWED_HOSTS`; link-local addresses (169.254.0.0/16, fe80::/10) and cloud metadata endpoints (169.254.169.254 and others) are refused even when listed. A refused delivery counts as a failed attempt with the reason in `lastError`.

## Switch a queue to push (admin key)

```bash
curl -X PUT "$QUEUE/v1/queues/thumbnails" -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{
  "maxAttempts": 6, "backoffBaseSec": 10, "backoffMaxSec": 600,
  "push": { "url": "https://workers.example.com/hooks/thumbnails", "secret": "<at least 32 characters>", "concurrency": 4 }
}'
```

```json
{ "created": true, "queue": { "name": "thumbnails", "push": { "url": "https://workers.example.com/hooks/thumbnails", "concurrency": 4 }, "…": "…" } }
```

The secret is stored encrypted and never returned. To change the URL or concurrency later, send `push` without `secret` and the old one is kept; send a new `secret` to rotate it.

## What your endpoint receives

```
POST /hooks/thumbnails
content-type: application/json
x-queue-name: thumbnails
x-queue-message-id: msg_mgx1k2abc0123456789abcdef
x-queue-attempt: 1
x-queue-signature: t=1792141200,v1=5f0c…
```

```json
{ "id": "msg_mgx1k2abc0123456789abcdef", "queue": "thumbnails", "attempt": 1, "priority": 0, "enqueuedAt": "2026-10-16T09:00:00.000Z", "body": { "fileId": "8a4e…", "size": 200 } }
```

Verify before doing any work (Node):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, rawBody, header, toleranceSec = 300) {
  const [tPart, ...sigs] = header.split(',');
  const t = Number(tPart.slice(2));
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => { const given = Buffer.from(s.slice(3), 'hex'); return given.length === expected.length && timingSafeEqual(given, expected); });
}
```

Answer `2xx` when done: the message is acked and deleted. Any other status, a connection error or no answer within `PUSH_TIMEOUT_MS` counts as a failed delivery: the message comes back after the queue's backoff and is dead-lettered after `maxAttempts`, with the reason (`HTTP 500: …`) in `lastError`.

## Watch it

- `GET /v1/queues/thumbnails`: depth by state; `leased` are deliveries in flight.
- `/metrics`: `queue_push_deliveries_total{result="ok"|"failed"}`.
- Dead letters: `GET /v1/queues/thumbnails/messages?state=dead`, redrive after fixing the receiver.

## Back to pulling

```bash
curl -X PUT "$QUEUE/v1/queues/thumbnails" -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{ "push": null }'
```

While a queue is in push mode, `POST /v1/queues/thumbnails/pull` answers `409 INVALID_STATE`.

## Pitfalls

- Delivery is at least once: a receiver that did the work but timed out gets the message again. Make handlers idempotent on `id`.
- `paused: true` stops pushing as it stops pulls; messages wait.
- `concurrency` is per queue and per queue process; the receiver must cope with that many parallel requests.
- Order is priority, then oldest, but with `concurrency` above 1 deliveries overlap.

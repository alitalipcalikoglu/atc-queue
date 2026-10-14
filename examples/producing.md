# Producing

```bash
qcurl -X POST $QUEUE/v1/queues/emails/messages -d '{ "body": { "to": "ayse@example.com", "template": "welcome" }, "priority": 5, "dedupeKey": "welcome:u_42" }'
# 201 { "message": { "id": "msg_mv8...", "state": "ready", "attempts": 0, ... }, "deduplicated": false }
```

- `body`: any JSON, at most `MAX_MESSAGE_BYTES` (256 KiB) encoded.
- `priority`: −100…100, higher first; ties go to the oldest due message.
- `delaySec`: invisible until then (`state: "delayed"`), up to 14 days.
- `dedupeKey`: while a message with that key is in the queue (ready, delayed, leased or dead), enqueuing it again answers `200` with that message and `deduplicated: true`. After it is acked or deleted the key is free again. Use it to make producers safe to retry.

## Batch

```bash
qcurl -X POST $QUEUE/v1/queues/emails/messages/batch -d '{ "messages": [ { "body": 1 }, { "body": 2, "delaySec": 600 } ] }'
```

One transaction; up to `MAX_BATCH` (100). A batch that would exceed `MAX_QUEUE_DEPTH` is refused as a whole (`409 QUEUE_FULL`).

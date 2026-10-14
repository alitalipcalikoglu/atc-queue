# Operations on messages

```bash
qcurl "$QUEUE/v1/queues/emails/messages?state=ready"     # ready | delayed | leased | dead; oldest first, cursor paging
qcurl $QUEUE/v1/queues/emails/messages/msg_mv8...         # one message (never its lease token)
qadmin -X DELETE $QUEUE/v1/queues/emails/messages/msg_mv8...   # not while leased (409 INVALID_STATE)
qadmin -X POST $QUEUE/v1/queues/emails/purge -d '{ "state": "dead" }'   # ready (incl. delayed) | dead | all
```

`purge` with `all` also removes leased messages; their consumers' acks then answer `MESSAGE_NOT_FOUND`. Acked messages are deleted immediately; nothing else expires except dead letters.

#!/usr/bin/env bash
# dev2 reply helper — send a message to room tchat-bug as dev2 via SSE bridge
# usage: bash scripts/dev2-say.sh "message text"
MSG="${1:?usage: dev2-say.sh \"message\"}"
curl -s -X POST http://localhost:3004/send \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"dev2\",\"room\":\"tchat-bug\",\"text\":$(printf '%s' "$MSG" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}"
echo

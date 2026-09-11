#!/bin/bash
# dev2 sandbox SSE listener — reconnecting curl loop (orphan-safe pattern).
# Joins room tchat-bug on the sandbox bridge :3004 as dev2, logs all events
# (strips "data: " prefix, skips SSE heartbeat comments) to .build/bug-room.log
LOG=/home/z/my-project/.build/bug-room.log
mkdir -p "$(dirname "$LOG")"
while true; do
  curl -Ns "http://localhost:3004/stream?name=dev2&room=tchat-bug" 2>/dev/null | while IFS= read -r line; do
    case "$line" in
      ':'*) continue ;;                    # SSE comment / heartbeat (: hb seq key)
      'data: '*) line="${line#data: }" ;;
    esac
    [ -z "$line" ] && continue
    echo "[$(date +%H:%M:%S)] $line" >> "$LOG"
  done
  sleep 3
done

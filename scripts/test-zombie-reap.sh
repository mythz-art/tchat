#!/usr/bin/env bash
# Verifies SSE zombie reaping: connect -> pong once -> go silent -> server must
# reap after SSE_PONG_GRACE(45s) + sweep(15s) and free the name.
set -u
cd /home/z/my-project
B="http://localhost:3004"
OUT=.build/zombie-test
rm -f "$OUT.obs" "$OUT.zomb" "$OUT.result"

# observer stream
curl -fsSN --no-buffer "$B/stream?name=Observer&room=zombietest" > "$OUT.obs" 2>/dev/null &
OBS=$!
# zombie stream (pong-capable client)
curl -fsSN --no-buffer "$B/stream?name=Zombie&room=zombietest" > "$OUT.zomb" 2>/dev/null &
ZOM=$!

sleep 17                      # wait for first heartbeat (hb every 15s)
KEY=$(grep -o ': hb [0-9]* sse:[0-9]*' "$OUT.zomb" | head -1 | awk '{print $NF}')
echo "captured zombie key: $KEY"
if [ -z "$KEY" ]; then echo "FAIL: no hb key captured" | tee "$OUT.result"; kill $OBS $ZOM 2>/dev/null; exit 1; fi

PONG=$(curl -s -X POST "$B/pong" -H 'Content-Type: application/json' -d "{\"key\":\"$KEY\"}")
echo "pong response: $PONG"

echo "now zombie goes silent (connection held open, no more pongs)..."
sleep 62                      # 45s grace + up to 15s sweep
if grep -q "Zombie left the room" "$OUT.obs"; then
  echo "PASS: zombie reaped and announced"
else
  echo "FAIL: zombie still present in observer feed:"; tail -5 "$OUT.obs"
fi

# name must be free now: join a NEW stream as Zombie
timeout 4 curl -fsSN "$B/stream?name=Zombie&room=zombietest" 2>/dev/null | head -2 > "$OUT.result"
if head -1 "$OUT.result" | grep -q "Connected as Zombie"; then
  echo "PASS: name Zombie freed after reap"
else
  echo "FAIL: Zombie join rejected:"; cat "$OUT.result"
fi
kill $OBS $ZOM 2>/dev/null

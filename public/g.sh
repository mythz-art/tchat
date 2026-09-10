#!/bin/sh
# TermChat — zero-install shell client (no Node.js needed). POSIX sh + curl only.
# Run it with:        curl -fsSL https://tchat.space-z.ai/g | bash
# Join a room:        ROOM=7XK92 curl -fsSL https://tchat.space-z.ai/g | bash
# Override host:      TCHAT_URL=http://localhost:3000 curl -fsSL https://tchat.space-z.ai/g | bash
# Works over pure HTTPS — the zero-install terminal where SSH ports are blocked.

B="${TCHAT_URL:-https://tchat.space-z.ai}"
X="XTransformPort=3004"   # gateway port hint (harmless when hitting the service directly)
R="${TCHAT_ROOM:-${ROOM:-lobby}}"  # room code (lobby by default)

command -v curl >/dev/null 2>&1 || { echo "termchat: curl is required"; exit 1; }

# When piped (curl ... | sh) stdin IS the script text, so interactive reads must
# come from the terminal (/dev/tty) instead of stdin. When there is no terminal
# (scripted runs), keep reading stdin as usual.
IN=""
if ! [ -t 0 ]; then
  # probe: /dev/tty exists but may fail to open without a controlling terminal
  if (exec 3</dev/tty) 2>/dev/null; then IN="/dev/tty"; fi
fi
read_line() {
  if [ -n "$IN" ]; then IFS= read -r "$1" </dev/tty; else IFS= read -r "$1"; fi
}

printf 'guest name: '
read_line NAME
printf '%s' "$NAME" | grep -qE '^[A-Za-z0-9][A-Za-z0-9 ._-]{1,19}$' || {
  echo "termchat: name must be 2-20 chars — letters, digits, spaces, _ . -"
  exit 1
}

ENC=$(printf '%s' "$NAME" | sed 's/ /%20/g')
RENC=$(printf '%s' "$R" | sed 's/ /%20/g')
echo "connecting to $B ... (room: $R)"

(
  curl -Ns --max-time 86400 "$B/stream?$X&name=$ENC&room=$RENC" | while IFS= read -r line; do
    case "$line" in
      data:?*) printf '%s\n' "${line#data: }"; printf 'you > ' ;;
    esac
  done
  printf '\n*** disconnected — bye!\n'
  kill -TERM "$PPID" 2>/dev/null
) &
WATCHER=$!

trap 'kill $WATCHER 2>/dev/null; printf "\nbye!\n"; exit 0' INT TERM

while read_line MSG; do
  [ -z "$MSG" ] && continue
  case "$MSG" in
    /quit|/exit|/q)
      curl -s -o /dev/null "$B/send?$X" --data-urlencode "name=$NAME" --data-urlencode "room=$R" --data-urlencode "text=/quit"
      break ;;
    *)
      curl -s -o /dev/null "$B/send?$X" --data-urlencode "name=$NAME" --data-urlencode "room=$R" --data-urlencode "text=$MSG" ;;
  esac
done

kill $WATCHER 2>/dev/null
printf 'bye!\n'

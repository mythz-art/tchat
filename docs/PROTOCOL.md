# Wire protocol

All transports share one room registry in `chat-service`. Room keys are
case-insensitive (the first-seen label is preserved); the default room is `lobby`.

## Room & name rules

- **Room code**: 1–24 chars, letters/digits/space/`_`/`.`/`-`; key is upper-cased for
  lookup, label kept as first seen (`7xk92` and `7XK92` are one room).
- **Guest name**: 2–20 chars, must start with a letter/digit (Unicode letters OK),
  control characters stripped. Uniqueness is enforced **per room**.

## socket.io (:3003, path `/`)

### Client → server

| Event | Payload | Notes |
|-------|---------|-------|
| `join` | `{ name, room? }` | joins/creates the room, replays history |
| `message` | `{ text }` | plain chat line (sender identity added server-side) |
| `action` | `{ text }` | `/me` emote |
| `nick` | `{ name }` | rename; broadcasts a system notice |
| `users` | — | requests `users-list` |
| `rooms` | — | requests `rooms-list` |

### Server → client

| Event | Payload | Notes |
|-------|---------|-------|
| `joined` | `{ you, room, count, users[], history[] }` | after a successful join |
| `message` | `{ id, kind:'chat', from, text, ts }` | |
| `system` | `{ id, kind:'system', subtype, text, ts }` | join/leave/rename notices |
| `action` | `{ id, kind:'action', from, text, ts }` | emote |
| `users-list` | `{ users: [{name}] }` | |
| `rooms-list` | `{ rooms: [{key,label,count}], total }` | |
| `presence` | `{ count, total }` | per-room + global headcount |
| `name-rejected` | `{ reason, freeSuggestion? }` | duplicate/invalid name |
| `renamed` | `{ you }` | after `nick` |
| `error` | `{ text }` | capacity/generic errors |
| `kicked` | `{ text }` | server-removed (e.g. capacity) |

## SSE bridge (:3004) — plain HTTP

Enables `curl`-only clients. `XTransformPort=3004` in the reference gateway.

- `GET /stream?name=X&room=Y` → `text/event-stream`
  - one `data: <plain-text line>` per event (join/leave notices, chat, emotes),
  - `*** Connected as X in room "Y"` banner first, 25 s heartbeat comments,
  - server-side commands understood when sent as chat text: `/me`, `/nick`, `/quit`
    (close → clean leave broadcast).
- `POST /send` — body `application/x-www-form-urlencoded` or JSON:
  `{ name, text, room? }`
  - the sender **must have an open stream** (`403 you are not connected` otherwise),
  - `room` disambiguates when a name is online in several rooms (`409` + hint if
    ambiguous and no room given),
  - known name in one room only → `room` optional.
- `GET /health` → `{ ok, users, rooms:[{key,label,users}] }`

## Short public endpoints

| Path | Backing file / handler |
|------|------------------------|
| `/i.sh`, `/install.sh` | `public/install.sh` (route handler forces `text/plain`) |
| `/i.ps1`, `/install.ps1` | `public/install.ps1` (route handler forces `text/plain`) |
| `/g` | `public/g.sh` |
| `/p` | `public/p.txt` |
| `/c` | `public/chat.cjs` |
| `/version.txt` | `public/version.txt` |

## Client exit codes / conventions

- `/quit` (or `/exit`, `/q`, Ctrl+C ×2) exits the CLI with code `0`.
- The CLI reconnects forever; while connecting, keystrokes are buffered and applied
  at the first prompt.

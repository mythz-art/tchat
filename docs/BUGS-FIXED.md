# Bug & Feature Log — tchat

Working log of bugs reported in the `tchat-bug` room and how they were fixed.
Reporters are community testers; fixes land in the sandbox first and ship to the
public site at the next platform sync.

---

## Round 1 — launch-day reports

### #1 · BUG · Website refresh leaves the room — **FIXED**
Three stacked causes: socket.io `connectionStateRecovery` restored room membership
without re-registering the app-level user (half-joined state); the browser never
persisted the session; and quick refresh + rejoin raced the previous connection for
the same name.

Fix:
- Removed `connectionStateRecovery`; clients re-join explicitly on reconnect.
- Session persistence: `{name, room}` saved to storage on every join; `/r/<room>`
  pages auto-resume the saved session, so refresh keeps you in the room.
- Auto re-join after network drops; one automatic retry when an automated join hits
  the stale-name race (the server's stale-holder eviction frees it).

### #2 · BUG · After a user stops website/terminal, re-login with the same name says "name exists" — **FIXED**
Reproduced live: a zombie SSE connection (curl reader whose TCP close was never
propagated) held a name for ~30 minutes because server heartbeat writes kept the
dead stream registered. Vanished socket.io clients lingered up to ~85s.

Fix:
- Faster dead-client detection (ping timeout 15s / interval 5s → names freed ≤ ~20s).
- SSE liveness protocol: heartbeats became `: hb <seq> <key>` (invisible comment
  lines); pong-capable clients reply `POST /pong {key}`; a reaper destroys any
  pong-capable stream silent > 45s.
- Join-time stale-name eviction: a join first evicts holders that are provably dead
  (disconnected socket.io or silent pong-capable SSE).
- TCP keepalive + error handlers on SSE sockets; heartbeat writes guarded.
- Failed joins no longer leak empty room objects.

### #3 · QUESTION · "In which room is dev2 connected?" — **ANSWERED**
`dev2` sits in `tchat-bug` on both deployments: the sandbox bridge (SSE listener
loop) and the public site (socket.io bot using the same transport as the website).

---

## Round 2 — community stress-test (tester1, tester2, hi, dev, dev1)

### #4 · BUG CRITICAL · All slash commands sent as literal text in web — **FIXED**
The web input had no command interpreter (only terminal clients did), contradicting
the homepage commands table.

Fix: client-side interpreter in the web chat — `/help`, `/users`, `/rooms`, `/me`,
`/nick`, `/clear`, `/url`, `/quit` — plus an "unknown command — try /help" hint.
`/quit` is backed by a new server `leave` event that frees the name and broadcasts
the leave without dropping the socket.

### #5 · BUG HIGH · No reconnect feedback; offline sends silently stuck — **FIXED**
- Reconnection attempts: 10 → unlimited.
- Amber "Connection lost — reconnecting…" banner while in a room, with a
  **try now** button; messages typed offline are queued and flushed in order on
  the next successful join; instant offline detection via the browser `offline`
  event (no 15-20s ping-timeout wait); `online` event reconnects immediately.

### #6 · BUG HIGH · Global online counters stuck at 0 — **FIXED**
The counter only updated from presence events, which require joining. The homepage
now polls the chat service's `/health` through the gateway every 5s, so the header
and footer counters are live for visitors who never joined.

### #7 · BUG MEDIUM · Pre-join room page shows stale "0 guests" — **FIXED**
Room pages poll `/health` and show "N guest(s) in this room right now · M online
overall" before joining (case-insensitive room matching).

### #8 · BUG MED-UX · No Leave/Quit button in the web UI — **FIXED**
Added a `/quit — leave room` button beside the user list (same path as the
`/quit` command).

### #9 · BUG LOW · No flood control — **OPEN (owner decision)**
Community request; the project owner explicitly opted for *no rate limiting*.
A light per-user flood guard (e.g. 12 msgs / 3s) can be enabled on request.

### #10 · BUG HIGH · "Connecting…" hangs with no retry or error — **FIXED**
Unlimited background retries, plus after 8s the UI explains ("the chat service may
be restarting — it keeps retrying") with a manual **retry now** button.

### #11 · BUG HIGH · Intermittent silent message loss — **PARTIALLY FIXED**
Root cause: the public deployment runs multiple app instances behind the platform
load balancer with no sticky sessions; each instance keeps its own in-memory
state, so requests randomly hit an instance that doesn't know the sender.
App-side mitigations: `POST /send` addressed to a socket.io identity now delivers
instead of 403ing; offline queueing (see #5); send errors surface in the UI.
Verified clean on a single instance. **Full fix = platform config (single replica
or sticky sessions).**

### #12 · BUG HIGH · History retention/replay gaps — **IMPROVED**
Empty rooms used to be deleted instantly, wiping history on quick join/leave
churn. Empty rooms now survive a 10-minute grace window before a sweeper drops
them. Cross-instance replay gaps share the #11 root cause (infra config needed);
restart-persistence would require disk-backed history (future feature).

### #13 · BUG LOW · Multi-tab session interference — **FIXED**
`sessionStorage` is now primary (per-tab; reloading tab A can no longer hijack you
into tab B's room), with `localStorage` as fallback so new tabs still prefill.

---

## Round 3 — protocol-generation findings (tester1)

### #14 · BUG CRITICAL · Zero-install `/g` and `/p` broken by 403s — **FIXED (app-side)**
Two 403 classes from the send bridge:
- *"socket.io clients should use the socket protocol"* — removed: `/send` addressed
  to a socket.io identity now routes into the room (message, `/me`, `/nick`,
  `/quit`, `/rooms`, `/users` all supported over HTTP).
- *"you are not connected — open the stream first"* — correct behavior when the
  named user isn't registered on that instance; a symptom of #11's flapping.
`/g` itself re-verified end-to-end in a real pty (join → chat → multi-line → quit).

### #15 · BUG HIGH · Backend instance flapping — **INFRA**
Same root cause as #11/#12-b. Recommendation: run a single replica or enable
sticky sessions on the platform LB.

### #16 · BUG MEDIUM · Zombie SSE name registrations — **FIXED (in Round 1)**
The pong/reaper/eviction fix from #2 frees vanished SSE clients within ~45-60s.

---

## Feature requests

### Multi-line messages from terminal clients — **SHIPPED**
End a line with `\` and continue on the next line — the lines join into ONE
message (both `g.sh` and PowerShell `p.txt`, with a `... >` continuation prompt).
The server now preserves newlines in chat text (500-char cap still enforced), the
web renders them, and SSE transport flattens them to `line1 / line2` so one
message always stays one SSE event.

### Screenshots of all join methods + this document — **SHIPPED**
See `docs/screenshots/` and the README.

---

## Feature requests, round 2

### "Can't see any history when I join — website or terminal" — **SHIPPED**
Reported by the owner after watching a fresh join show only the live traffic.
Root cause: history was RAM-only (15-message replay, room deleted when the last
person left). Fixed in v3.1 with a full persistence layer:

- every message is appended to a per-room JSONL log (`db/chat-history/<room>.jsonl`)
  **before** broadcast; rooms re-hydrate from disk on first touch, so **service
  restarts lose nothing** and empty rooms keep their log forever;
- every client got lazy paging: the web lazy-loads older messages when you scroll
  to the top (with viewport anchoring and dedupe); the native CLI and the SSH
  bridge gained `/history [n]`; `g.sh` / `p.txt` fetch text pages with cursor
  headers; ` socket.io` gained the `history` → `history-page` event pair.

### Major feature: reliable message polling for AI agents — **SHIPPED**
The owner's own fleet of AI agents (testers + a developer agent) needed a client
that survives sandboxes which kill background processes. Enter `GET /poll`:

- register once with `name=` → keep the returned `key` and `since` cursor;
- poll with `key` + `since` → every missed message in order, never duplicated;
  `hasMore` chases bursts; `since=0` replays the room's entire persisted log;
- the poll itself is the heartbeat: identities live while they poll, quietly
  time out after 90s (name freed, leave notice broadcast);
- `POST /send` gained full command parity for poll identities (`/me`, `/nick`,
  `/users`, `/rooms` answered inline, `/quit`);
- documented end-to-end in **docs/API.md**, covered by `scripts/test-poll-api.ts`.

---

## #25 — "all history is removing and not showing in website or terminal" — permanent history (v3.3)

**Reported:** via the meta-channel (owner, after chatting in room `tex`). Messages
sent during a session vanished: rejoining the room (web, SSH or CLI) showed none
of them.

**Diagnosis — three stacked durability holes:**

1. **`bun --hot` in the dev runner.** A hot module reload re-executes
   `index.ts` in place: the `rooms` map (all live history) resets and — worse —
   the surviving listener can keep serving traffic from a stale module instance
   whose write path never ran. Evidence: room `tex` was chatty for 25 minutes
   while its `tex.jsonl` never appeared on disk; after the reload
   `GET /history?room=tex` returned `lastSeq: 0`.
2. **No fsync, no rollback healing.** `appendFileSync` is not durable and, if
   the host restores an older disk snapshot while the process keeps running,
   the JSONL silently regresses behind what RAM knows — nothing ever repaired it.
3. **Test harness races.** `test-ssh.ts` could catch the peer's own echo of an
   earlier send; `test-history-lazy.ts` seeded only 40 messages, which the new
   50-message join replay swallows whole.

**Fix:**

- **No more hot reload, ever**: `mini-services/chat-service` now runs
  `bun index.ts` (plain). State lives in one stable process; restarts re-hydrate
  from disk.
- **`appendDurable()`**: every append stats the JSONL first — if the file is
  missing or *shorter* than the byte size we last wrote, the log is rebuilt
  from the in-RAM window (fsync'd) before appending, and a line can never be
  written twice. Each append ends in `fdatasync`.
- **Durability sweeper** (60s): any live room whose disk log regressed behind
  RAM is rebuilt automatically; the disk log can no longer silently lose to a
  snapshot restore.
- `hydrateRoom()` now records the file size and last on-disk seq so the
  self-heal has a baseline.
- Join replay raised: **50** messages on socket.io join (web/CLI/SSH),
  **30** on SSE join; lazy paging beyond that is unchanged.
- Tests: `nextFrom()` helper skips self-echoes in `test-ssh.ts`; the lazy suite
  now seeds 80 messages so paging wraps the 50-item replay window.

**Verified live:** send → message on disk; hot-reload-equivalent state loss →
history hydrated back from JSONL; JSONL deleted → next append rebuilt the full
log from RAM, zero duplicates; browser join → reload → full history restored
(screenshot `.build/history-after-reload.png`). Suites: 41 + 21 + 26 + 21 + 12 +
6 + 5 + zombie green.

---

## #26 — "still not showing all history in website or terminal" — show ALL history on join (v3.4)

**Reported:** after v3.3 made history durable, users joining a room still saw only
the most recent slice — 50 messages on the website/CLI/SSH, 30 on SSE. Paging for
the rest meant clicking a small button dozens of times, which reads as "history is
missing".

**Root cause:** the join replay caps (`HISTORY_REPLAY_SOCKET = 50`,
`HISTORY_REPLAY_SSE = 30`) were tuned for the lazy-load design, but the visible
affordance did not make "there is more, and here is how much" obvious.

**Fix (v3.4 — "show all history"):**
- Join replay raised to **1000 messages** on every transport (socket.io website,
  CLI, SSH, and SSE). For any realistic room that is the entire persisted log, so
  newcomers see the complete history the moment they join.
- Server now returns `olderCount` on `joined`, `history-page` and `GET /history`
  — the exact number of persisted messages below the current page.
- Website: the top banner states "N older messages on record" with
  **↑ load older** (pages of 200) and **load all** (chained pages until the
  floor); `/history all` does the same from the message input.
- CLI + SSH: `/history all` dumps the whole log; the post-join hint names the
  remaining count (`22 older message(s) on record — /history … /history all`).
- Replay caps are env-overridable (`CHAT_REPLAY_SOCKET` / `CHAT_REPLAY_SSE`) so
  deployments and test suites can exercise the paging path.
- Diagnostics added along the way: `scripts/test-website-join.ts` and
  `scripts/test-website-join-public.ts` probe exactly what a joining client
  receives, locally and through the public gateway.

**Verified live:** joining `lobby` through the real gateway replays all **332**
messages in one shot (`hasMore: false`, oldest seq 1), browser renders all 332
rows (screenshot `.build/v34-website-full-history.png`); suites 41 + 21 + 26 +
21 + 12 + 6 + 5 + zombie green.

---

## Verification

Every fix is covered by automated suites (run from the repo root):

| Suite | Assertions |
|---|---|
| `bun run scripts/test-chat-e2e.ts` | 41 |
| `bun run scripts/test-poll-api.ts` | 21 |
| `bun run scripts/test-history-lazy.ts` | 26 |
| `bun run scripts/test-multi-terminal.ts` | 21 |
| `bun run scripts/test-ssh.ts` | 12 |
| `bun run scripts/test-bundled-client.ts` | 6 |
| `bash scripts/test-zombie-reap.sh` | 2 |
| `bun run scripts/test-multiline-identity.ts` | 5 |

Browser-level verification was done with a real browser: refresh auto-rejoin,
offline queue/flush cycle, all slash commands, leave button, live counters, and
pre-join guest counts.

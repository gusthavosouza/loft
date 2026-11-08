# Only a paired client can change things through the API

Status: accepted (2026-11-08), with Loft security's changes. Not built yet.

## Context
An agent runs as the same Mac user and can `curl` Loft's API on localhost:7420. Loft can't tell that from the web app, the iOS app or a script, so today one `curl` can approve a permission request (`POST /api/permissions/{id}`), send a **user** message to a teammate (`POST /api/agents/{id}/messages`), approve comments, merge a PR, change the push keys and the relay address (`PUT /api/push`, the one address since #112/#115) or delete agents. Agents don't need the REST API: everything they do goes through `/mcp/{agent_id}`.

## Threat model
Protects against an agent, or a prompt injected into one, that uses the API the way a person's client would. After this, the same outcome needs the agent to write into `loft.db` or edit Loft's own source: a different, noisier act. It does **not** protect against an agent that edits Loft's files, reads `AuthKey.p8` or the data folder (same Mac user), or drives Loft's own UI with a macOS permission Loft holds (see Pairing). A separate OS user or sandbox would close that; this token is then its boundary.

**No localhost trust.** `tailscale serve` makes every request, the phone's included, arrive from 127.0.0.1, so loopback proves nothing and is never exempt. **No command prints a token**, ever. The user's own terminal `curl` needing a token is the right price.

## Decision

### The guard
1. Every `POST/PUT/PATCH/DELETE` under `/api` needs a user token: one middleware, default deny, so a new endpoint is covered without anyone remembering. Open: `POST /api/pair` and `GET /api/pair/{secret}` (the poll). `/mcp/*` never takes the token, and no user-only action may get an MCP twin. (`/mcp/{agent_id}` trusts an id any agent can list: a separate issue.)
2. Named reads need it too: `GET /devices`, `GET /push`, `GET /settings`. `GET /settings` still goes through `settings_view`, which keeps `github_token` out (only `github_token_set` comes back); that stays whatever the guard does.
3. Other reads stay open on purpose: the iOS app would need a Bearer on every `URLSession` call (including `bytes(for:)` and uploads), and agents read the same data through MCP anyway. Don't "fix" this on the web, it would break iOS for no gain. `GET /repos/github` spends the user's GitHub token for whoever asks: watch it.
4. The token is 32 random bytes, hex; one per paired client, stored as SHA-256 only (table `paired_clients`: hash, name, created, last_used). Never logged (headers and cookies stay out of every log line, the 401 path included), never in an agent's environment, files or prompt.

### Carrying the token
- **Web:** cookie `__Host-loft` (`Secure; Path=/; HttpOnly; SameSite=Strict`, no `Domain`, `Max-Age` about a year, refreshed on use). Cookies ignore ports and agents' dev servers live on the same host name; `__Host-` stops http from ever receiving it. Works through `tailscale serve` (https) and `http://localhost:7420`; `http://<ip>:7420` won't pair. The `Sec-Fetch-Site` guard stays.
- **iOS:** the Keychain, class `AfterFirstUnlockThisDeviceOnly` (no iCloud sync), sent as `Authorization: Bearer`. The app **refuses to pair or hold a token** under `#if targetEnvironment(simulator)` and in demo/fixture mode: agents drive the Simulator and read its files, so a paired Simulator app would remote-control them. Don't pair a browser on the Mac mini itself either.

### Pairing
- A client without a token calls `POST /api/pair` and gets a **32-byte pairing secret** and a 4-digit code. The code is only for the person to compare; the client polls with the secret, and the token is handed **once**, to that holder. Pending pairings live **in memory only** (`loft.db` is readable by agents).
- **Main path: approve from an already-paired client.** Loft raises a Needs you item plus a push on the paired clients: "Only allow if your phone or browser shows 4821". Approving, denying or cancelling is itself a user-only write.
- **Very first pairing** (no client paired yet): the native macOS dialog with the same code, or a code printed by the backend **only when stdout is a TTY**, never into a log file. Never auto-trust the first client while none are paired: an agent is a client.
- **Several pairings can wait at once**, keyed by secret, so an agent can't hold a lock. `POST /api/pair` is rate-limited, and a Deny blocks new requests for about ten minutes. Each expires after 2 minutes.
- **What the dialog guarantees:** it is a boundary only while Loft holds **no Accessibility and no Automation (System Events) grant**: agents inherit Loft's macOS permissions and could click Allow with `osascript`. Loft must never be given either, and the Simulator feature must not grow a need for them. It is also not the only approval path.

### Revoking
In v1, as user-only writes: **Forget this client**, **Unpair all**, and a list in Settings showing each client's name and `last_used`. Rotation is revoke and pair again; no expiry. Phones get lost, so this can't wait.

### Existing installs
They pair on first use after the update (no client is paired, so the Mac dialog or TTY code applies); the web app and the iOS app show a "Pair this client" screen on a 401.

## User-only endpoints (all writes, plus the named reads)
Push and relay: `PUT /push`, `POST /push/signin`, `POST/PATCH/DELETE /devices…`, `POST /devices/{token}/test`, `GET /push`, `GET /devices`.
Approvals: `POST /permissions/{id}`, comment `approve|keep` (also the `/tasks` alias), `POST /pull-requests/{id}/merge`, `POST /deliveries/merge`, pairing approve/deny/cancel.
Widening access: `PUT /settings`, `POST/PATCH/DELETE /agents…`, `POST /restart`, `POST /system/mac-access`, `POST /simulator/input`, `POST /agents/{id}/open-editor`, `GET /settings`.
Clients: forget, unpair all.
Everything else that writes (messages, issues, runs, memories, `/grill`, `/voice`, uploads, `/needs-you` dismiss…) is covered by default deny without being listed. No agent uses any of them: an agent that wants to message another uses MCP.

## Questions closed
- Default deny on all writes: yes; a `curl` the user types needs a token.
- `POST /devices` is guarded: a phone registers after it pairs.
- Per-client tokens and revoke: in v1 (above).

## Consequences
- An agent's `curl` to any write gets 401; tests drive the API with and without a token and assert the refusal.
- Every client pairs once; the web and iOS apps each get a pairing screen and a Settings list.
- Loft must stay without Accessibility and Automation, and the iOS app must keep refusing the Simulator.

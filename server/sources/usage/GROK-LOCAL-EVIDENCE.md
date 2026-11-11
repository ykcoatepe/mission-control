# Grok local usage evidence — 2026-11-11

Scope: filenames and JSON key names only in `~/.grokbot` and
`~/Library/Application Support/Grok Bot`. No token, credential, OAuth, cookie,
or message values were collected. No Grok provider is registered.

The readable metadata exposes:

- `.grokbot/settings.json`: settings, permissions, account-scope and tunnel/MCP
  configuration keys. Gate JSONs expose `isOn`. The local-exec daemon JSON
  exposes `filesKeyId`, `generation`, `inflightCount`, `pid`, `servingAt`,
  `startedAt`; return/supervisor JSONs expose `at` and `pid`.
- `desktop-status.json`: `appVersion`, `pid`, `signedIn`, `startedAtMs`, `version`.
  `window-state.json` contains window geometry keys.
- `Preferences`, `Local State`, `Network Persistent State`: Electron/browser,
  spellcheck, installation, network-server and transport-performance key names.
- `dune-reliability/sessions/*.running.json`: application/OS identity,
  start/heartbeat/quit times, boot outcome and crash/child-death flags.
  `dune-reliability/outbox.v1.jsonl` exposed no JSON record keys in this scan.
- `sentry/session.json` and scope metadata: application/session/error counters,
  traces, breadcrumbs and environment keys. These are error telemetry, with no
  input/output/cache-token or request-usage keys observed.
- `sand-client-persistence/*.blob`, Chromium storage/database files and logs
  exist. Their contents were not inspected because the authorized inspection
  was limited to filenames and JSON key names. Credential/cookie contents
  are outside this reported evidence.

No readable per-request or per-session token accounting was identified. This
is a scoped absence of evidence, not a claim that opaque blobs or remote Grok
services cannot contain usage. Grok usage remains unverified; inventing a
zero-valued provider would misrepresent that boundary.

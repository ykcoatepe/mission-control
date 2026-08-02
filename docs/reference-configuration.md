# Configuration and Runtime Reference

Mission Control combines a local JSON configuration with environment overrides
and auto-detected OpenClaw state. This page describes the current contracts;
values in `mc-config.json` remain machine-local.

## Configuration loading

At startup, `server.js` reads `mc-config.json` from the repository root. If it
is missing or invalid, the server copies `mc-config.default.json` into place.
Some secret-bearing string fields accept `${ENV_NAME}` placeholders.

The setup and settings APIs can update local configuration. `GET /api/config`
removes the gateway token, Notion token, and Scout Brave key. It is not a
general secret scrubber: use environment variables for AWS credentials and do
not add new secret fields to `mc-config.json` without also redacting them from
the public projection.

## `mc-config.json`

| Field | Default | Meaning |
| --- | --- | --- |
| `name`, `subtitle` | `Mission Control` | Product labels |
| `modules` | mixed | Navigation and Diagnostics presentation flags |
| `gateway.port` | `18789` | OpenClaw gateway port |
| `gateway.token` | empty | Local fallback token; OpenClaw config is auto-detected first |
| `workspace` | auto-detected or `~/clawd` | Workspace used by task and agent features |
| `skillsPath` | `<workspace>/skills` | Skills directory |
| `memoryPath` | `<workspace>/memory` | Memory directory |
| `aws` | disabled | Bedrock/S3 enablement, bucket, and region; prefer environment credentials |
| `notion` | disabled | Optional activity source |
| `scout` | disabled | Brave Search key, queries, and schedule |

Module flags are presentation controls. An explicit `false` hides an eligible
sidebar item or Diagnostics tab; a missing flag generally means enabled. Routes
are still mounted, so these flags are not authorization controls. In particular,
`gbrainTimeline` controls timeline collection while the `/gbrain` route uses its
own implicit module behavior.

## Environment variables

### Server and integrations

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3333` | Express port |
| `MISSION_CONTROL_HOST` | `127.0.0.1` | Bind host; changing this can expose an unauthenticated control surface |
| `MC_GATEWAY_TOKEN` | empty | Fallback used by session helpers only; not a global gateway-token override |
| `MC_USER_HOME` | `HOME` | Home used for OpenClaw/Hermes usage and cron discovery |
| `HERMES_PROFILE` | `hmudur` | Hermes profile used by cron and usage readers |
| `HERMES_STATE_DB` | profile state DB | Explicit Hermes usage database |
| `HERMES_PROFILE_DIR` | profile directory | Alternate profile directory |
| `AWS_REGION` | `us-east-1` | AWS region fallback |
| `AWS_ACCESS_KEY_ID` | empty | AWS credential fallback |
| `AWS_SECRET_ACCESS_KEY` | empty | AWS credential fallback |

### Usage and task execution

| Variable | Default | Purpose |
| --- | --- | --- |
| `MC_OPENCLAW_USAGE_TIMEOUT_MS` | `120000` | Detailed OpenClaw usage timeout |
| `MC_OPENCLAW_USAGE_MAX_FILES` | `20000` | Maximum session files scanned per usage refresh (OpenClaw + standalone `~/.codex` rollouts combined) |
| `MC_OPENCLAW_DEFAULT_MODEL` | `openai/gpt-5.5` | Fallback model label for incomplete usage records |
| `MC_CODEX_HOME` | `~/.codex` (host user) | Codex home whose `sessions/` rollouts feed the Codex App / Codex CLI buckets; pinned into the usage-script env so an inherited `CODEX_HOME` cannot redirect the scan |
| `MC_COSTS_CACHE_DIR` | OS temp | Directory for `costs-cache.json` |
| `MC_EXECUTE_RECONCILE_TIMEOUT_MS` | `120000` | Task execution reconciliation timeout |
| `MC_EXECUTE_RECONCILE_MIN_MS` | `30000` | Minimum reconciliation timeout |
| `MC_EXECUTE_RECONCILE_MAX_MS` | `300000` | Maximum reconciliation timeout |
| `MC_EXECUTE_RECONCILE_GRACE_MS` | `15000` | Post-execution reconciliation grace |

### Feature and verification switches

| Variable | Default | Purpose |
| --- | --- | --- |
| `MISSION_CONTROL_ENABLE_COUNCIL_ACTIONS` | unset | Set to `1` to enable governance mutations; otherwise they return `410` |
| `NPM_INCIDENT_ADVISORY_URL` | script default | Supply-chain advisory source |
| `SUPPLY_CHAIN_REPO_ROOT` | current directory | Repository scanned by the advisory checker |

Additional GBrain, Hermes, Ollama, and proxy variables are owned by those local
tools. Prefer their own configuration rather than duplicating credentials in
Mission Control.

For all gateway-backed routes, configure the token in OpenClaw's gateway auth
configuration or in `mc-config.gateway.token`. The latter can use an `${ENV}`
placeholder. Setting only `MC_GATEWAY_TOKEN` does not configure chat, cron,
tasks, quick actions, or settings because that environment fallback is read
only by the session helpers.

## Runtime files

| Path | Contents |
| --- | --- |
| `data/runtime/*.json` | Atomic TTL-bound runtime snapshots |
| `data/gbrain/evidence-timeline.jsonl` | GBrain evidence history, capped at 5,000 entries |
| `data/calendar-entries.json` | Local calendar entries |
| `data/decision-log.json` | Governance decision archive |
| `data/ops-events.json` | Operator event history |
| `data/agent-registry.json` | Local agent registry |
| `tasks.json` | Workshop task state |
| `hidden-sessions.json` | Sessions hidden from this UI; not closed in OpenClaw |
| `documents/` | Local uploaded documents and temporary imports |
| `$MC_COSTS_CACHE_DIR/costs-cache.json` | Usage fallback cache |

OpenClaw session metadata and transcripts remain under the local OpenClaw home.
Hermes cron and usage data remain under the selected Hermes profile. Mission
Control normalizes those sources; it does not migrate them into the repository.

## Optional runtime dependencies

The server can call `openclaw`, `hermes`, `gbrain`, `ollama`, `sqlite3`,
`codexbar`, `aws`, and macOS `launchctl`. It can also use OpenClaw gateway HTTP,
Ollama, a Hermes proxy, Notion, Brave Search, AWS Bedrock, and S3. Missing
optional dependencies should produce explicit unavailable or empty states.

## Security boundary

Mission Control has mutating routes and no application authentication. Its
primary protection is the loopback bind plus localhost Host filtering. The
mutation Origin filter uses prefix matching and is only defense in depth, not an
exact same-origin security boundary. Keep `MISSION_CONTROL_HOST=127.0.0.1`;
module flags and hidden navigation do not restrict endpoint access. Store
credentials in the owning tool or environment, not in committed files.

## Related

- [Operator Surfaces Reference](reference-operator-surfaces.md)
- [System Architecture](explanation-system-architecture.md)
- [How to Verify Operator Surfaces](how-to-verify-operator-surfaces.md)

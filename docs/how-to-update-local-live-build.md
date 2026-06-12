# How to Update the Local Live Build

Use this after one or more PRs merge and the running local Mission Control app
at `http://127.0.0.1:3333` should serve the latest `master` code.

## Prerequisites

- Run from the repository root.
- Keep unrelated local edits out of the way before switching or pulling. Use a
  named stash for work you want to preserve.
- The OpenClaw gateway should be reachable on `127.0.0.1:18789` if you use
  `/Users/yordamkocatepe/clawd/scripts/mission_control_start.sh`; that script
  waits for the gateway before starting Mission Control.

## Steps

1. Check the current branch and local changes.

   ```bash
   git status --short --branch
   ```

   Expected state before updating live code:

   ```text
   ## master...origin/master
   ```

   Untracked local work such as `.claude/` can remain if it is unrelated. Do
   not stash or commit it just to update the live build.

2. Move to `master`.

   ```bash
   git switch master
   ```

3. Pull the merged PRs exactly.

   ```bash
   git pull --ff-only origin master
   ```

   `--ff-only` refuses history rewrites or accidental merge commits. If it
   fails because a tracked file is modified, inspect that diff first:

   ```bash
   git diff -- path/to/file
   ```

4. Confirm local and remote `master` match.

   ```bash
   git rev-parse HEAD
   git rev-parse origin/master
   ```

   The two SHAs should be identical.

5. Build the frontend bundle served by Express.

   ```bash
   npm run build
   ```

   This runs `cd frontend && npm run build`, which type-checks with `tsc -b`
   and writes the Vite production output to `frontend/dist`.

6. Restart the local Mission Control process.

   If a process already listens on `3333`, identify it:

   ```bash
   lsof -nP -iTCP:3333 -sTCP:LISTEN
   ```

   Confirm the process is the Mission Control server by checking its current
   working directory:

   ```bash
   lsof -a -p PID -d cwd
   ```

   Stop only that Mission Control process:

   ```bash
   kill PID
   ```

   Start it again from the shared local start script:

   ```bash
   nohup bash /Users/yordamkocatepe/clawd/scripts/mission_control_start.sh \
     >> /Users/yordamkocatepe/clawd/state/mission_control_start.log 2>&1 &
   ```

   If you do not use the shared local start script, run the server directly:

   ```bash
   npm start
   ```

## Verification

Confirm a listener exists:

```bash
lsof -nP -iTCP:3333 -sTCP:LISTEN
```

Confirm the health endpoint responds:

```bash
curl -fsS http://127.0.0.1:3333/api/health
```

Expected shape:

```json
{"ok":true,"status":"ok","service":"mission-control","generatedAt":"..."}
```

Open the app:

```text
http://127.0.0.1:3333/
```

The sidebar should match the current route registry. For the current release,
that includes `Diagnostics` under `SYSTEM`, with Memory, Docs, Scout, AWS, and
Skills available as tabs when their module flags are enabled.

## Troubleshooting

If `git pull --ff-only` refuses to update because of a tracked local edit, do
not discard it blindly. Either commit it on a branch or preserve it with a named
stash:

```bash
git stash push -m "preserve local edit before live update" -- path/to/file
```

If `curl` cannot connect but `lsof` shows a listener, verify from a browser or
another local HTTP client. Some sandboxed terminals can see the listening socket
but cannot open a loopback connection.

If the app starts but old UI remains visible, rebuild `frontend/dist` with
`npm run build` and restart the Node process again. Express serves static assets
from `frontend/dist`; pulling source files alone is not enough.

If `/api/health` works but runtime data is empty, verify the dependent local
tools separately. Mission Control can render with empty or unavailable states
when GBrain, Hermes, Ollama, or OpenClaw are not reachable.

## Related

- [How to Verify Operator Surfaces](how-to-verify-operator-surfaces.md)
- [Operator Surfaces Reference](reference-operator-surfaces.md)
- [Frontend Conventions](reference-frontend-conventions.md)

# How to Update the Local Live Build

Use this after changes merge and the workstation instance at
`http://127.0.0.1:3333` should serve the latest `master`.

This guide includes a clearly marked workstation-specific restart path. For a
portable installation, build with `npm run build` and supervise `npm start`
using the service manager appropriate to that host.

## 1. Protect local work

```bash
git status --short --branch
```

Do not discard or bundle unrelated modifications. If tracked local work blocks
the update, inspect it and preserve only the affected paths on a branch or in a
named stash.

## 2. Update `master` without creating a merge commit

```bash
git switch master
git pull --ff-only origin master
git rev-parse HEAD
git rev-parse origin/master
```

The two SHAs should match. If `--ff-only` fails, stop and inspect the branch or
working-tree divergence rather than forcing it.

## 3. Build the bundle Express serves

```bash
npm run build
```

This runs TypeScript checking and Vite, then writes `frontend/dist`. Pulling
source code without rebuilding does not update the live UI.

## 4. Restart this workstation's service

First identify the listener and verify its working directory:

```bash
lsof -nP -iTCP:3333 -sTCP:LISTEN
lsof -a -p PID -d cwd
```

Stop only the confirmed Mission Control process, then use the local guard:

```bash
kill PID
for _ in {1..40}; do
  if ! kill -0 PID 2>/dev/null; then break; fi
  sleep 0.25
done
if kill -0 PID 2>/dev/null; then
  echo "Mission Control PID did not exit" >&2
  exit 1
fi
bash scripts/restart_safe.sh 3333
```

Replace both `PID` placeholders with the confirmed numeric PID. The bounded
loop prevents the guard from mistaking a still-exiting process for a successful
restart. `restart_safe.sh` is an ensure-running guard: if a healthy listener
already exists it exits without restarting it. Stopping the confirmed old
process first is therefore required when deploying a new build. Once the old
process is down, the helper invokes the machine-level start script and waits for
health. It currently depends on:

```text
/Users/yordamkocatepe/clawd/scripts/mission_control_start.sh
```

The machine-level script also expects the local OpenClaw gateway to become
reachable. These paths are workstation conventions, not portable project
requirements. If you bypass the guard, start the app through that workstation
script or `npm start`; avoid broad process-name kills.

## 5. Verify the deployed result

```bash
lsof -nP -iTCP:3333 -sTCP:LISTEN
curl -fsS http://127.0.0.1:3333/api/health
```

Expected health shape:

```json
{"ok":true,"status":"ok","service":"mission-control","generatedAt":"..."}
```

Compare the served and local asset names:

```bash
curl -fsS http://127.0.0.1:3333/ | sed -n 's/.*src="\([^"]*assets\/[^"]*\.js\)".*/\1/p'
sed -n 's/.*src="\([^"]*assets\/[^"]*\.js\)".*/\1/p' frontend/dist/index.html
```

Then open the browser and confirm the eight primary destinations: Brain, Work,
Automations, Sessions, Explore, Usage, Systems, and Ollama Runtime. Diagnostics
is directly reachable at `/diagnostics`; it is not a sidebar item.

For a higher-confidence check, run the API and browser steps in
[How to Verify Operator Surfaces](how-to-verify-operator-surfaces.md).

## Troubleshooting

- If `git pull --ff-only` reports tracked changes, inspect and preserve them;
  never reset them blindly.
- If `lsof` sees a listener but a sandboxed `curl` cannot connect, verify from a
  normal local terminal or browser.
- If health works but source panels are empty, verify the owning OpenClaw,
  Hermes, GBrain, Ollama, or optional integration independently.
- If the API is current but the UI is old, rebuild `frontend/dist`, restart the
  process, and compare the asset names again.
- `mission-control.service` is a Linux systemd template with a placeholder
  working directory; it is not the macOS workstation deployment mechanism.

## Related

- [Configuration and Runtime Reference](reference-configuration.md)
- [Operator Surfaces Reference](reference-operator-surfaces.md)

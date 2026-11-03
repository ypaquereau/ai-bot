# ai-bot

A GitHub App that drives an AI coding agent ([Claude Code](https://docs.claude.com/en/docs/claude-code)) from issue labels.

## Flow

| Label | Who applies it | Effect |
|---|---|---|
| `ai:plan` | a repo collaborator | Agent reads the issue + the code, posts a plan + open questions as a comment marked `<!-- ai-bot:plan -->`, then applies `ai:plan-ready` |
| *(comment on an `ai:plan-ready` issue)* | any collaborator with **write** access | Re-runs the planning step (new plan comment) |
| `ai:approved` | a repo collaborator | Agent implements the latest plan, pushes a branch, opens a PR with `Closes #N`, then applies `ai:pr-opened` |

State labels `ai:planning`, `ai:implementing` and `ai:failed` are applied only by the runner itself, to reflect where a task currently stands (or that it errored out — the failure reason is posted as a comment).

## Architecture

```
GitHub ──webhook──▶ src/server (Hono)  ──creates──▶  k8s Job  ──runs──▶  src/runner (ephemeral pod)
                                                                              │
                                                                              ├─ clones the repo (GIT_ASKPASS, token never reaches `claude`)
                                                                              ├─ runs `claude -p` (read-only for plan, Edit/Write + allowed Bash for implement)
                                                                              ├─ commits / pushes / opens the PR
                                                                              └─ transitions labels, comments on failure
```

- **`src/server`** — the GitHub App's webhook receiver.
  - Verifies the HMAC signature (`@octokit/webhooks`), ignores events from bots, requires **write** access from the comment/label author, and only acts on an allow-listed set of owners.
  - Responds `202` immediately, then (async) mints a GitHub App installation token scoped to the single target repository, and creates one Kubernetes `Job` per task in the `ai-agents` namespace.
  - Deduplicates: if a Job is already running for a given issue, a new trigger is ignored.
  - The installation token is stored in a short-lived `Secret`, attached to its `Job` via `ownerReference` so it is garbage-collected automatically once the Job finishes (`ttlSecondsAfterFinished`).
- **`src/runner`** — the image run by each Job. It:
  1. Reads the task (plan/implement, repo, issue, installation id) from environment variables set by the server.
  2. Clones the repo over HTTPS using a `GIT_ASKPASS` script that reads the token from the mounted Secret file — the token is never passed as a CLI argument and never present in the environment of the `claude` subprocess.
  3. Reads `.github/ai-bot.yml` from the target repo (see [`.github/ai-bot.yml.example`](.github/ai-bot.yml.example)) for model/branch/allowed-commands overrides.
  4. Runs `claude -p` headless: `--permission-mode plan` (read-only) for planning, `--permission-mode acceptEdits` with `Edit`/`Write`/an allow-listed set of `Bash(...)` commands for implementation.
  5. Commits, pushes the branch, opens a draft PR (by default) referencing `Closes #N`.
  6. Moves the issue to the next state label, or to `ai:failed` with an explanatory comment if anything throws.
  7. The plan itself lives only in the GitHub issue comment, never in the pod — nothing about a task's state outlives its Job.

## Repository layout

```
src/
  shared/   types, label names, .github/ai-bot.yml schema, logger
  server/   webhook receiver, GitHub App auth, k8s Job/Secret dispatch
  runner/   git, GitHub API calls, Claude Code invocation, plan/implement orchestration
deploy/     raw Kubernetes manifests
Dockerfile  multi-stage, two targets: `server` and `runner`
```

## Setting up the GitHub App

1. **Create the App** (your org or user settings → *Developer settings* → *GitHub Apps* → *New GitHub App*):
   - Webhook URL: `https://<your-host>/webhook` (see "Exposing the webhook" below).
   - Webhook secret: generate one, you'll need it as `GITHUB_WEBHOOK_SECRET`.
   - Permissions: **Issues** (read & write), **Pull requests** (read & write), **Contents** (read & write), **Metadata** (read).
   - Subscribe to events: **Issues**, **Issue comment**.
   - Where can this App be installed: your choice, but keep `ALLOWED_OWNERS` (below) in sync regardless.
2. **Generate a private key** for the App (same settings page) and download the `.pem` file.
3. **Install the App** on the repositories/orgs you want the bot to operate on.
4. Note the **App ID** and the **Installation ID** (visible in the installation's settings URL).

## Secrets the server needs

| Env var | Purpose |
|---|---|
| `GITHUB_APP_ID` | the App's numeric id |
| `GITHUB_APP_PRIVATE_KEY` | the App's PEM private key |
| `GITHUB_WEBHOOK_SECRET` | the webhook HMAC secret configured on the App |
| `ANTHROPIC_API_KEY` | forwarded into each runner Job's Secret so `claude` can authenticate |
| `ALLOWED_OWNERS` | comma-separated allow-list of GitHub orgs/users (defense in depth on top of the App's own install scope) |
| `RUNNER_IMAGE` | image reference for the `runner` Dockerfile target |

See [`deploy/07-secrets.example.yaml`](deploy/07-secrets.example.yaml) for the Kubernetes `Secret` template — fill it in and apply it out-of-band, never commit real values.

## Deploying

```bash
docker build --target server -t <registry>/ai-bot-server:latest .
docker build --target runner -t <registry>/ai-bot-runner:latest .
docker push <registry>/ai-bot-server:latest
docker push <registry>/ai-bot-runner:latest
```

Then, against your self-hosted cluster:

```bash
kubectl apply -f deploy/00-namespaces.yaml
kubectl apply -f deploy/01-rbac.yaml
kubectl apply -f deploy/02-resourcequota.yaml
kubectl apply -f deploy/03-networkpolicy.yaml
# fill in and apply your real secret (see deploy/07-secrets.example.yaml) before this one:
kubectl apply -f deploy/04-server-deployment.yaml
kubectl apply -f deploy/05-server-service.yaml
kubectl apply -f deploy/06-server-ingress.yaml   # only if exposing via Ingress, see below
```

Update the `image:` field in `deploy/04-server-deployment.yaml` and the `runnerImage` key in its `ConfigMap` to point at the images you pushed.

### Exposing the webhook

The server needs a public HTTPS URL for GitHub to reach `/webhook`. On a self-hosted cluster you have two straightforward options:

- **Ingress** — apply [`deploy/06-server-ingress.yaml`](deploy/06-server-ingress.yaml) with a real hostname and TLS (e.g. via cert-manager), pointed at whatever ingress controller you already run.
- **Cloudflare Tunnel** — if you don't want to open any inbound port, run `cloudflared` (as a sidecar or its own Deployment) pointed at the `ai-bot-server` Service (`http://ai-bot-server.ai-bot.svc.cluster.local`) and skip the Ingress manifest entirely. This also sidesteps needing a public LoadBalancer IP.

Either way, point the GitHub App's webhook URL at whichever hostname you end up with.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm run build         # tsc, emits to dist/
npm run dev:server    # tsx watch, runs the webhook server locally
```

Running a runner task locally requires a real `KubeConfig`-less environment — in practice you'll want to exec into a one-off pod or run `node dist/runner/index.js` directly with the env vars listed in `src/runner/env.ts` set by hand, plus a `GITHUB_TOKEN_FILE` pointing at a token with repo access.

## Security notes

- The GitHub installation token is scoped to a single repository and lives only in a per-Job `Secret`, mounted read-only and never passed to the `claude` subprocess's environment.
- Runner pods run as a non-root user with a read-only root filesystem (writable `emptyDir`s only for `/workspace` and `/tmp`), no capabilities, and a `NetworkPolicy` restricting egress to DNS and HTTPS on public addresses only (RFC1918/link-local excluded) — see [`deploy/03-networkpolicy.yaml`](deploy/03-networkpolicy.yaml).
- The server only dispatches a task if the triggering label/comment comes from a human (never a bot) with **write** access on the repository, and only for owners in `ALLOWED_OWNERS`.

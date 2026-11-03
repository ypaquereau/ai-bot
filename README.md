# ai-bot

> **Proof of concept.** This is an exploratory scaffold, not a production-hardened project: it has been exercised through local end-to-end testing (see "Testing locally" below), but hasn't run against real-world traffic, hasn't had a security review beyond the measures described here, and its interfaces may change without notice. Review it carefully — especially the "Security notes" section — before pointing it at anything that matters.

A GitHub App that drives an AI coding agent ([Cursor CLI](https://cursor.com/docs/cli)) from issue labels.

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
                                                                              ├─ clones the repo (GIT_ASKPASS, token never reaches `agent`)
                                                                              ├─ runs `agent -p` (Cursor CLI, read-only for plan, --force + .cursor/cli.json for implement)
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
  2. Clones the repo over HTTPS using a `GIT_ASKPASS` script that reads the token from the mounted Secret file — the token is never passed as a CLI argument and never present in the environment of the `agent` subprocess.
  3. Reads `.github/ai-bot.yml` from the target repo (see [`.github/ai-bot.yml.example`](.github/ai-bot.yml.example)) for model/branch/allowed-commands overrides, and writes a per-task `.cursor/cli.json` permissions file (excluded from the clone's git tracking via `.git/info/exclude`, so it never ends up in a commit).
  4. Runs `agent -p` headless (Cursor CLI): `--mode plan` without `--force` for planning, so the agent can only *propose* changes, never write them; `--force` for implementation, scoped by `.cursor/cli.json`'s `permissions.deny` (secrets) — see the security note below on what `--force` does and doesn't restrict.
  5. Commits, pushes the branch, opens a draft PR (by default) referencing `Closes #N`.
  6. Moves the issue to the next state label, or to `ai:failed` with an explanatory comment if anything throws.
  7. The plan itself lives only in the GitHub issue comment, never in the pod — nothing about a task's state outlives its Job.

## Repository layout

```
src/
  shared/   types, label names, .github/ai-bot.yml schema, logger
  server/   webhook receiver, GitHub App auth, k8s Job/Secret dispatch
  runner/   git, GitHub API calls, Cursor CLI invocation, plan/implement orchestration
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
| `CURSOR_API_KEY` | forwarded into each runner Job's Secret so the Cursor CLI (`agent`) can authenticate |
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

## Testing locally

You can exercise the full flow — webhook → k8s Job → runner → real GitHub comment/labels/PR — before touching your production cluster. The one thing you can't avoid is a **real, disposable GitHub repo**: labels, comments and PRs go through the live GitHub API, there's no mock for them.

1. **Scratch GitHub App + repo.** Create a GitHub App (same steps as above) and install it on one throwaway repo. Pick any string for the webhook secret — in this local setup nothing validates it against GitHub, you supply the same value to both the server and the simulator script below.
2. **Local cluster + images:**
   ```bash
   npm run local:cluster   # kind create cluster, builds + loads ai-bot-server:dev / ai-bot-runner:dev
   ```
3. **Namespaces, RBAC, quota, and your secret** (fill in `deploy/07-secrets.example.yaml` with the scratch App's id/private key, your chosen webhook secret, and a real `CURSOR_API_KEY`):
   ```bash
   kubectl apply -f deploy/00-namespaces.yaml
   kubectl apply -f deploy/01-rbac.yaml
   kubectl apply -f deploy/02-resourcequota.yaml
   kubectl apply -f <your-filled-in-secret>.yaml
   ```
   Skip `deploy/06-server-ingress.yaml` entirely — nothing needs to be publicly reachable for this.
4. **Run the server against the local cluster**, without deploying it as a pod — fastest inner loop, no image rebuild per code change:
   ```bash
   export GITHUB_APP_ID=... GITHUB_APP_PRIVATE_KEY="$(cat your-app.pem)" GITHUB_WEBHOOK_SECRET=... \
          CURSOR_API_KEY=... ALLOWED_OWNERS=your-scratch-owner RUNNER_IMAGE=ai-bot-runner:dev
   kubectl config use-context kind-ai-bot-dev   # npm run local:cluster already did this once
   npm run dev:server
   ```
   (If you'd rather test the real `deploy/04-server-deployment.yaml` pod too, point its `image`/`runnerImage` at the `:dev` tags, `imagePullPolicy: Never`, apply it and `05-server-service.yaml`, then `kubectl port-forward svc/ai-bot-server 3000:80 -n ai-bot`.)
5. **Open a real issue** on the scratch repo, then trigger the webhook without any tunnel:
   ```bash
   npm run simulate:webhook -- issues.labeled \
     --owner your-scratch-owner --repo your-scratch-repo --issue 1 \
     --installation <installation-id> --label ai:plan
   ```
   For the re-plan path (a write-access comment on an `ai:plan-ready` issue):
   ```bash
   npm run simulate:webhook -- issue_comment.created \
     --owner your-scratch-owner --repo your-scratch-repo --issue 1 \
     --installation <installation-id> --sender your-github-login --body "looks good, adjust step 2"
   ```
6. **Watch it run:**
   ```bash
   kubectl get jobs -n ai-agents -w
   kubectl logs -n ai-agents job/<job-name>
   ```
   and check the scratch issue for the plan comment / label transitions / PR.

Note: `kind`'s default CNI (`kindnet`) doesn't enforce `NetworkPolicy`, so this setup can't verify that [`deploy/03-networkpolicy.yaml`](deploy/03-networkpolicy.yaml) actually restricts egress — only that the rest of the flow works. Either install Calico in your `kind` cluster, or treat that one check as something to confirm on the real cluster.

## Security notes

- The GitHub installation token is scoped to a single repository and lives only in a per-Job `Secret`, mounted read-only and never passed to the `agent` subprocess's environment.
- Runner pods run as a non-root user with a read-only root filesystem (writable `emptyDir`s only for `/workspace` and `/tmp`), no capabilities, and a `NetworkPolicy` restricting egress to DNS and HTTPS on public addresses only (RFC1918/link-local excluded) — see [`deploy/03-networkpolicy.yaml`](deploy/03-networkpolicy.yaml).
- The server only dispatches a task if the triggering label/comment comes from a human (never a bot) with **write** access on the repository, and only for owners in `ALLOWED_OWNERS`.
- **On `--force` and `.cursor/cli.json`** (see [`src/runner/cursor-permissions.ts`](src/runner/cursor-permissions.ts)): Cursor's own docs describe `--force` as allowing anything not explicitly denied, without prompting. That means during the implement step, `permissions.allow` (built from `.github/ai-bot.yml`'s `allowedBashCommands`) is closer to documentation of intent than a hard boundary — the actual enforcement is the hardcoded `permissions.deny` list (`.env*`, `*.key`, `*.pem`). Don't rely on `allowedBashCommands` alone to keep the agent from running something you don't want; tighten the deny list instead if that matters for your repo. The plan step has no such gap: without `--force`, Cursor's documented behavior is to only propose changes, never write them.

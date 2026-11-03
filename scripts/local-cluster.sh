#!/usr/bin/env bash
# Spins up (or reuses) a local kind cluster and loads the server/runner
# images into it, so you can exercise the real k8s Job/Secret dispatch path
# without a registry or a remote cluster. See README.md > Testing locally.
set -euo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-ai-bot-dev}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v kind >/dev/null; then
  echo "kind is required: https://kind.sigs.k8s.io/docs/user/quick-start/#installation" >&2
  exit 1
fi
if ! command -v docker >/dev/null; then
  echo "docker is required to build the images" >&2
  exit 1
fi

if ! kind get clusters | grep -qx "$CLUSTER_NAME"; then
  echo "Creating kind cluster '$CLUSTER_NAME'..."
  kind create cluster --name "$CLUSTER_NAME"
else
  echo "Reusing existing kind cluster '$CLUSTER_NAME'."
fi

echo "Building images..."
docker build --target server -t ai-bot-server:dev "$ROOT_DIR"
docker build --target runner -t ai-bot-runner:dev "$ROOT_DIR"

echo "Loading images into the cluster..."
kind load docker-image ai-bot-server:dev --name "$CLUSTER_NAME"
kind load docker-image ai-bot-runner:dev --name "$CLUSTER_NAME"

kubectl config use-context "kind-$CLUSTER_NAME"

cat <<EOF

Cluster '$CLUSTER_NAME' is ready, kubectl context 'kind-$CLUSTER_NAME' is active.

Next steps (see README.md > Testing locally):
  kubectl apply -f deploy/00-namespaces.yaml
  kubectl apply -f deploy/01-rbac.yaml
  kubectl apply -f deploy/02-resourcequota.yaml
  kubectl apply -f <your-filled-in-secret>.yaml
  kubectl apply -f deploy/05-server-service.yaml   # only if you deploy the server in-cluster too

Remember deploy/04-server-deployment.yaml's image/runnerImage must say
"ai-bot-server:dev" / "ai-bot-runner:dev" (with imagePullPolicy: Never or
IfNotPresent) for the locally-built images to be used, if you deploy the
server in-cluster rather than running it with 'npm run dev:server'.
EOF

import type { V1Job, V1OwnerReference, V1Secret } from "@kubernetes/client-node";
import { randomUUID } from "node:crypto";
import { serverEnv } from "./env.js";
import type { AgentTask } from "../shared/types.js";

const JOB_RESOURCES = {
  requests: { cpu: "250m", memory: "256Mi" },
  limits: { cpu: "1", memory: "1Gi" },
} as const;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 20)
    .replace(/(^-|-$)/g, "");
}

export function jobName(task: AgentTask): string {
  const shortId = randomUUID().slice(0, 8);
  const base = `ai-bot-${slug(task.owner)}-${slug(task.repo)}-${task.issueNumber}-${task.task}`;
  return `${base.slice(0, 54)}-${shortId}`.toLowerCase();
}

export function tokenSecretName(job: string): string {
  return `${job}-token`;
}

export function buildJobManifest(task: AgentTask, name: string, secretName: string): V1Job {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace: serverEnv.agentsNamespace,
      labels: {
        app: "ai-bot-runner",
        owner: slug(task.owner),
        repo: slug(task.repo),
        issue: String(task.issueNumber),
        task: task.task,
      },
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: serverEnv.jobActiveDeadlineSeconds,
      ttlSecondsAfterFinished: serverEnv.jobTtlSecondsAfterFinished,
      template: {
        metadata: {
          labels: {
            app: "ai-bot-runner",
            owner: slug(task.owner),
            repo: slug(task.repo),
            issue: String(task.issueNumber),
            task: task.task,
          },
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: serverEnv.runnerServiceAccount,
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 10001,
            runAsGroup: 10001,
            fsGroup: 10001,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "runner",
              image: serverEnv.runnerImage,
              imagePullPolicy: "IfNotPresent",
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              env: [
                { name: "TASK", value: task.task },
                { name: "REPO_OWNER", value: task.owner },
                { name: "REPO_NAME", value: task.repo },
                { name: "ISSUE_NUMBER", value: String(task.issueNumber) },
                { name: "INSTALLATION_ID", value: String(task.installationId) },
                { name: "DELIVERY_ID", value: task.deliveryId },
                { name: "IS_REPLAN", value: String(task.isReplan) },
                { name: "GITHUB_API_URL", value: serverEnv.githubApiUrl },
                { name: "GITHUB_TOKEN_FILE", value: "/var/run/secrets/ai-bot/token" },
                { name: "HOME", value: "/workspace" },
                { name: "WORKSPACE", value: "/workspace" },
                {
                  name: "ANTHROPIC_API_KEY",
                  valueFrom: { secretKeyRef: { name: secretName, key: "anthropicApiKey" } },
                },
              ],
              resources: JOB_RESOURCES,
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "tmp", mountPath: "/tmp" },
                { name: "github-token", mountPath: "/var/run/secrets/ai-bot", readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: {} },
            { name: "tmp", emptyDir: {} },
            { name: "github-token", secret: { secretName, items: [{ key: "token", path: "token" }] } },
          ],
        },
      },
    },
  };
}

export function buildSecretManifest(
  secretName: string,
  token: string,
  anthropicApiKey: string,
  owner: V1OwnerReference,
): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: secretName,
      namespace: serverEnv.agentsNamespace,
      ownerReferences: [owner],
      labels: { app: "ai-bot-runner" },
    },
    stringData: { token, anthropicApiKey },
  };
}

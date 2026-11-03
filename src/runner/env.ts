import type { TaskType } from "../shared/types.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const runnerEnv = {
  task: required("TASK") as TaskType,
  repoOwner: required("REPO_OWNER"),
  repoName: required("REPO_NAME"),
  issueNumber: Number(required("ISSUE_NUMBER")),
  installationId: Number(required("INSTALLATION_ID")),
  deliveryId: required("DELIVERY_ID"),
  isReplan: optional("IS_REPLAN", "false") === "true",
  githubApiUrl: optional("GITHUB_API_URL", "https://api.github.com"),
  githubTokenFile: optional("GITHUB_TOKEN_FILE", "/var/run/secrets/ai-bot/token"),
  workspace: optional("WORKSPACE", "/workspace"),
} as const;

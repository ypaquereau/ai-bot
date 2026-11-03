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

export const serverEnv = {
  port: Number(optional("PORT", "3000")),

  githubAppId: required("GITHUB_APP_ID"),
  githubAppPrivateKey: required("GITHUB_APP_PRIVATE_KEY"),
  githubWebhookSecret: required("GITHUB_WEBHOOK_SECRET"),
  githubApiUrl: optional("GITHUB_API_URL", "https://api.github.com"),
  /** Propagated into each Job's ephemeral Secret, so the Cursor CLI (`agent`) can authenticate. */
  cursorApiKey: required("CURSOR_API_KEY"),

  /** GitHub owners (orgs/users) allowed to use the bot, comma-separated. */
  allowedOwners: optional("ALLOWED_OWNERS", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  agentsNamespace: optional("AGENTS_NAMESPACE", "ai-agents"),
  runnerImage: required("RUNNER_IMAGE"),
  runnerServiceAccount: optional("RUNNER_SERVICE_ACCOUNT", "ai-bot-runner"),
  jobTtlSecondsAfterFinished: Number(optional("JOB_TTL_SECONDS_AFTER_FINISHED", "3600")),
  jobActiveDeadlineSeconds: Number(optional("JOB_ACTIVE_DEADLINE_SECONDS", "1800")),
} as const;

export function assertAllowedOwner(owner: string): boolean {
  if (serverEnv.allowedOwners.length === 0) {
    return false;
  }
  return serverEnv.allowedOwners.includes(owner.toLowerCase());
}

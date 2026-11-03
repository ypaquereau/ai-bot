function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variable d'environnement manquante: ${name}`);
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
  /** Propagé dans le Secret éphémère de chaque Job, pour que `claude` puisse s'authentifier. */
  anthropicApiKey: required("ANTHROPIC_API_KEY"),

  /** Owners GitHub (orgs/users) autorisés à utiliser le bot, séparés par des virgules. */
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

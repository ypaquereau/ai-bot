import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { serverEnv } from "./env.js";

const appAuth = createAppAuth({
  appId: serverEnv.githubAppId,
  privateKey: serverEnv.githubAppPrivateKey,
});

/**
 * Creates a short-lived installation token (~1h), scoped to the single
 * `owner/repo` repository. This token is meant for the Job's ephemeral
 * Secret, never reused afterwards by the server.
 */
export async function mintRepoScopedInstallationToken(
  installationId: number,
  owner: string,
  repo: string,
): Promise<{ token: string; expiresAt: string }> {
  const auth = await appAuth({
    type: "installation",
    installationId,
    repositoryNames: [repo],
  });

  if (!auth.token) {
    throw new Error(`Failed to create an installation token for ${owner}/${repo}`);
  }

  return { token: auth.token, expiresAt: auth.expiresAt };
}

/** Octokit client authenticated as the installation, for server-side checks (permissions, etc). */
export async function installationOctokit(installationId: number): Promise<Octokit> {
  const auth = await appAuth({ type: "installation", installationId });
  if (!auth.token) {
    throw new Error(`Failed to authenticate installation ${installationId}`);
  }
  return new Octokit({ auth: auth.token, baseUrl: serverEnv.githubApiUrl });
}

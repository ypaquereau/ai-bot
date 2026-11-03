import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { serverEnv } from "./env.js";

const appAuth = createAppAuth({
  appId: serverEnv.githubAppId,
  privateKey: serverEnv.githubAppPrivateKey,
});

/**
 * Crée un token d'installation à durée de vie courte (~1h), limité au seul
 * dépôt `owner/repo`. Ce token est destiné au Secret éphémère du Job, jamais
 * réutilisé ensuite par le serveur.
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
    throw new Error(`Échec de la création du token d'installation pour ${owner}/${repo}`);
  }

  return { token: auth.token, expiresAt: auth.expiresAt };
}

/** Client Octokit authentifié en tant qu'installation, pour les vérifications côté serveur (permissions, etc). */
export async function installationOctokit(installationId: number): Promise<Octokit> {
  const auth = await appAuth({ type: "installation", installationId });
  if (!auth.token) {
    throw new Error(`Échec de l'authentification de l'installation ${installationId}`);
  }
  return new Octokit({ auth: auth.token, baseUrl: serverEnv.githubApiUrl });
}

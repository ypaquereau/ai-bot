import type { Octokit } from "@octokit/rest";

export function isBotSender(sender: { type?: string; login?: string } | undefined): boolean {
  if (!sender) return true;
  if (sender.type === "Bot") return true;
  if (sender.login?.endsWith("[bot]")) return true;
  return false;
}

const WRITE_LEVEL_PERMISSIONS = new Set(["admin", "write"]);

/** Checks that `username` has at least write access on `owner/repo`. */
export async function hasWriteAccess(
  octokit: Octokit,
  owner: string,
  repo: string,
  username: string,
): Promise<boolean> {
  try {
    const { data } = await octokit.repos.getCollaboratorPermissionLevel({
      owner,
      repo,
      username,
    });
    return WRITE_LEVEL_PERMISSIONS.has(data.permission);
  } catch {
    return false;
  }
}

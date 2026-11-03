import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { runnerEnv } from "./env.js";
import { STATE_LABELS, TRIGGER_LABELS } from "../shared/labels.js";

/** Token d'installation à portée réduite (un seul dépôt), lu depuis le volume monté en lecture seule. */
export function readInstallationToken(): string {
  return readFileSync(runnerEnv.githubTokenFile, "utf8").trim();
}

export function createOctokit(): Octokit {
  return new Octokit({ auth: readInstallationToken(), baseUrl: runnerEnv.githubApiUrl });
}

export interface LabelTransition {
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

export async function transitionLabels(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  { add = [], remove = [] }: LabelTransition,
): Promise<void> {
  for (const name of remove) {
    try {
      await octokit.issues.removeLabel({ owner, repo, issue_number: issueNumber, name });
    } catch (error) {
      // 404 si le label n'était pas posé : pas bloquant.
      if (!isNotFound(error)) throw error;
    }
  }
  if (add.length > 0) {
    await octokit.issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [...add] });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

export async function postComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  await octokit.issues.createComment({ owner, repo, issue_number: issueNumber, body });
}

/** Marque la tâche en échec : commentaire explicatif + label ai:failed. */
export async function markFailed(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
  fromLabel: string,
  reason: string,
): Promise<void> {
  await postComment(
    octokit,
    owner,
    repo,
    issueNumber,
    `⚠️ L'agent IA a échoué sur cette tâche.\n\n\`\`\`\n${reason}\n\`\`\``,
  );
  await transitionLabels(octokit, owner, repo, issueNumber, {
    add: [STATE_LABELS.failed],
    remove: [fromLabel, TRIGGER_LABELS.plan, TRIGGER_LABELS.approved],
  });
}

import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { runnerEnv } from "./env.js";
import { STATE_LABELS, TRIGGER_LABELS } from "../shared/labels.js";

/** Repo-scoped installation token, read from the read-only mounted volume. */
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
      // 404 if the label wasn't set: not fatal.
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

/** Marks the task as failed: explanatory comment + ai:failed label. */
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
    `⚠️ The AI agent failed on this task.\n\n\`\`\`\n${reason}\n\`\`\``,
  );
  await transitionLabels(octokit, owner, repo, issueNumber, {
    add: [STATE_LABELS.failed],
    remove: [fromLabel, TRIGGER_LABELS.plan, TRIGGER_LABELS.approved],
  });
}

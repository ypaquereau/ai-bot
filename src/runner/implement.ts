import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { runnerEnv } from "./env.js";
import {
  checkoutNewBranch,
  cloneRepo,
  commitAll,
  configureIdentity,
  excludeLocalPath,
  hasChanges,
  pushBranch,
} from "./git.js";
import { loadBotConfig } from "./config.js";
import { createOctokit, postComment, transitionLabels, markFailed } from "./github.js";
import { runAgent } from "./agent.js";
import { writeCursorPermissions, SUMMARY_OUTPUT_FILENAME } from "./cursor-permissions.js";
import { findLatestPlanComment } from "./markers.js";
import { STATE_LABELS, TRIGGER_LABELS } from "../shared/labels.js";
import { logger } from "../shared/logger.js";

function buildImplementPrompt(title: string, body: string, plan: string): string {
  return [
    "You are an engineering agent implementing the approved plan below in the cloned repo (current directory).",
    "This run is fully automated, with nobody to respond to you: do not ask any question, do not request confirmation, do not propose a next step for approval. Carry the plan through to completion yourself.",
    "",
    `Issue title: ${title}`,
    "Original description:",
    body || "(no description)",
    "",
    "Approved plan to implement:",
    plan || "(no plan found, implement the request above directly, with care)",
    "",
    "Mandatory steps, in order:",
    "1. Implement the plan using only the allowed tools and commands. Committing and pushing are handled by another process: you just modify the files.",
    `2. REQUIRED FINAL STEP — do not end your turn before doing this: write a finished summary to a single file named exactly "${SUMMARY_OUTPUT_FILENAME}" at the repo root, meant for the pull request description: what changed and why, in 3-4 sentences max. No process narration ("I will do...", "next step..."), no question, just the final result.`,
  ].join("\n");
}

/**
 * Reads back the summary the agent wrote to SUMMARY_OUTPUT_FILENAME; falls
 * back to the response text if the file is absent (logged as a warning so
 * it's visible in monitoring).
 */
async function readSummaryOutput(repoDir: string, fallback: string): Promise<string> {
  try {
    const content = await readFile(join(repoDir, SUMMARY_OUTPUT_FILENAME), "utf8");
    if (content.trim().length > 0) {
      return content;
    }
  } catch {
    // Falls through to the warning + fallback below.
  }

  logger.warn(`agent did not write ${SUMMARY_OUTPUT_FILENAME}, falling back to its response text`);
  return fallback;
}

async function getDefaultBranch(octokit: Octokit, owner: string, repo: string): Promise<string> {
  const { data } = await octokit.repos.get({ owner, repo });
  return data.default_branch;
}

export async function runImplementTask(): Promise<void> {
  const octokit = createOctokit();
  const { repoOwner: owner, repoName: repo, issueNumber } = runnerEnv;

  await transitionLabels(octokit, owner, repo, issueNumber, {
    add: [STATE_LABELS.implementing],
    remove: [TRIGGER_LABELS.approved, STATE_LABELS.failed],
  });

  try {
    const repoDir = join(runnerEnv.workspace, "repo");
    await cloneRepo(owner, repo, repoDir);
    await excludeLocalPath(repoDir, ".cursor/");
    await excludeLocalPath(repoDir, SUMMARY_OUTPUT_FILENAME);
    const config = await loadBotConfig(repoDir);
    await configureIdentity(repoDir, config.gitIdentity);
    await writeCursorPermissions(repoDir, "implement", config.allowedBashCommands);

    const branch = `${config.branchPrefix}issue-${issueNumber}`;
    await checkoutNewBranch(repoDir, branch);

    const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const planComment = findLatestPlanComment(comments);

    logger.info("implementing the plan", { owner, repo, issueNumber });
    const result = await runAgent({
      cwd: repoDir,
      prompt: buildImplementPrompt(issue.title, issue.body ?? "", planComment?.body ?? ""),
      mode: "implement",
      model: config.model,
    });

    if (!(await hasChanges(repoDir))) {
      throw new Error("The agent did not produce any file change.");
    }

    const summary = await readSummaryOutput(repoDir, result.text);

    await commitAll(repoDir, `ai-bot: implement the request from issue #${issueNumber}`);
    await pushBranch(repoDir, branch);

    const baseBranch = config.baseBranch ?? (await getDefaultBranch(octokit, owner, repo));
    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      title: issue.title,
      head: branch,
      base: baseBranch,
      draft: config.draftPullRequest,
      body: `Closes #${issueNumber}\n\n${summary}`,
    });

    await postComment(octokit, owner, repo, issueNumber, `✅ Pull request opened: ${pr.html_url}`);
    await transitionLabels(octokit, owner, repo, issueNumber, {
      add: [STATE_LABELS.prOpened],
      remove: [STATE_LABELS.implementing, STATE_LABELS.planReady],
    });
  } catch (error) {
    await markFailed(octokit, owner, repo, issueNumber, STATE_LABELS.implementing, String(error));
    throw error;
  }
}

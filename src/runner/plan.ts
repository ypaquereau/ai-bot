import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runnerEnv } from "./env.js";
import { cloneRepo, excludeLocalPath } from "./git.js";
import { loadBotConfig } from "./config.js";
import { createOctokit, postComment, transitionLabels, markFailed } from "./github.js";
import { runAgent } from "./agent.js";
import { writeCursorPermissions, PLAN_OUTPUT_FILENAME } from "./cursor-permissions.js";
import { buildPlanComment } from "./markers.js";
import { STATE_LABELS, TRIGGER_LABELS } from "../shared/labels.js";
import { logger } from "../shared/logger.js";

function buildPlanPrompt(title: string, body: string): string {
  return [
    "You are an engineering agent preparing an implementation plan, read-only.",
    "Analyze the GitHub issue below and the repo's code (already cloned in the current directory).",
    "Do not modify, create or delete any file in the repo itself: just read and analyze.",
    "",
    `Issue title: ${title}`,
    "Description:",
    body || "(no description)",
    "",
    "Produce the plan in markdown, with:",
    "1. A detailed implementation plan, step by step, citing the files involved.",
    "2. A final '## Questions' section listing points to clarify before implementation (empty if none).",
    "",
    `Write this plan in full into a single file named exactly "${PLAN_OUTPUT_FILENAME}" at the repo root (the only file you're allowed to create/write to); don't split it up and don't settle for a summary in your response.`,
  ].join("\n");
}

/** Reads back the plan the agent wrote to PLAN_OUTPUT_FILENAME; falls back to the response text if the file is absent. */
async function readPlanOutput(repoDir: string, fallback: string): Promise<string> {
  try {
    const content = await readFile(join(repoDir, PLAN_OUTPUT_FILENAME), "utf8");
    return content.trim().length > 0 ? content : fallback;
  } catch {
    return fallback;
  }
}

export async function runPlanTask(): Promise<void> {
  const octokit = createOctokit();
  const { repoOwner: owner, repoName: repo, issueNumber } = runnerEnv;

  await transitionLabels(octokit, owner, repo, issueNumber, {
    add: [STATE_LABELS.planning],
    remove: [TRIGGER_LABELS.plan, STATE_LABELS.planReady, STATE_LABELS.failed],
  });

  try {
    const repoDir = join(runnerEnv.workspace, "repo");
    await cloneRepo(owner, repo, repoDir);
    await excludeLocalPath(repoDir, ".cursor/");
    await excludeLocalPath(repoDir, PLAN_OUTPUT_FILENAME);
    const config = await loadBotConfig(repoDir);
    await writeCursorPermissions(repoDir, "plan", config.allowedBashCommands);

    const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });

    logger.info("generating the plan", { owner, repo, issueNumber });
    const result = await runAgent({
      cwd: repoDir,
      prompt: buildPlanPrompt(issue.title, issue.body ?? ""),
      mode: "plan",
      model: config.model,
    });

    const planText = await readPlanOutput(repoDir, result.text);
    await postComment(octokit, owner, repo, issueNumber, buildPlanComment(planText));
    await transitionLabels(octokit, owner, repo, issueNumber, {
      add: [STATE_LABELS.planReady],
      remove: [STATE_LABELS.planning],
    });
  } catch (error) {
    await markFailed(octokit, owner, repo, issueNumber, STATE_LABELS.planning, String(error));
    throw error;
  }
}

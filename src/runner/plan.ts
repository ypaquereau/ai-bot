import { readdir, readFile } from "node:fs/promises";
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
    "You are an engineering agent preparing an implementation plan, read-only, for the GitHub issue below.",
    "This run is fully automated, with nobody to respond to you: do not ask questions back, do not stop partway to check in — carry this through to completion yourself.",
    "",
    `Issue title: ${title}`,
    "Description:",
    body || "(no description)",
    "",
    "Mandatory steps, in order:",
    "1. Analyze the issue and the repo's code (already cloned in the current directory), read-only. Do not modify, create or delete any existing file.",
    `2. REQUIRED FINAL STEP — do not end your turn before doing this: write the complete plan, in markdown, to a single file named exactly "${PLAN_OUTPUT_FILENAME}" at the repo root. This is the only file you are allowed to create or write to. Do not split the plan across multiple files, and do not settle for only summarizing it in your response — the file is the deliverable.`,
    "",
    `The content of "${PLAN_OUTPUT_FILENAME}" must include:`,
    "- A detailed implementation plan, step by step, citing the files involved.",
    "- A final '## Questions' section listing points to clarify before implementation (empty if none).",
  ].join("\n");
}

/**
 * Reads back the plan the agent wrote to PLAN_OUTPUT_FILENAME; falls back
 * to the response text if the file is absent (the agent doesn't reliably
 * write it on every run — logged as a warning so it's visible in monitoring).
 */
async function readPlanOutput(repoDir: string, fallback: string): Promise<string> {
  try {
    const content = await readFile(join(repoDir, PLAN_OUTPUT_FILENAME), "utf8");
    if (content.trim().length > 0) {
      return content;
    }
  } catch {
    // Falls through to the warning + fallback below.
  }

  logger.warn(`agent did not write ${PLAN_OUTPUT_FILENAME}, falling back to its response text`, {
    entries: await readdir(repoDir).catch((e) => String(e)),
  });
  return fallback;
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

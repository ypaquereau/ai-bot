import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { runnerEnv } from "./env.js";
import { cloneRepo, excludeLocalPath } from "./git.js";
import { loadBotConfig } from "./config.js";
import { createOctokit, postComment, transitionLabels, markFailed } from "./github.js";
import { runAgent } from "./agent.js";
import { writeCursorPermissions, PLAN_OUTPUT_FILENAME } from "./cursor-permissions.js";
import { buildPlanComment, findLatestPlanComment } from "./markers.js";
import { STATE_LABELS, TRIGGER_LABELS } from "../shared/labels.js";
import { logger } from "../shared/logger.js";

interface IssueComment {
  readonly id: number;
  readonly body?: string | null;
  readonly user: { readonly login?: string; readonly type?: string } | null;
}

/** A comment from a human, not one of the bot's own status comments (plan, failure, PR-opened, ...). */
function isHumanComment(comment: IssueComment): boolean {
  const login = comment.user?.login;
  if (!login) return false;
  if (comment.user?.type === "Bot") return false;
  if (login.endsWith("[bot]")) return false;
  return true;
}

interface RePlanContext {
  readonly previousPlan: string;
  readonly feedback: readonly IssueComment[];
}

/**
 * Finds the most recent plan comment and whatever human comments came after
 * it — the discussion a re-plan (triggered by commenting on an
 * `ai:plan-ready` issue) is meant to react to. Returns undefined when
 * there's no previous plan (first run) or no feedback since it (the
 * trigger comment itself may not have landed in this listComments call
 * yet, or dedup raced it — either way, nothing to incorporate).
 */
function findRePlanContext(comments: readonly IssueComment[]): RePlanContext | undefined {
  const previousPlanComment = findLatestPlanComment(comments);
  if (!previousPlanComment || !previousPlanComment.body) return undefined;

  const index = comments.findIndex((c) => c.id === previousPlanComment.id);
  const feedback = comments.slice(index + 1).filter(isHumanComment);
  if (feedback.length === 0) return undefined;

  return { previousPlan: previousPlanComment.body, feedback };
}

function buildPlanPrompt(title: string, body: string, rePlan: RePlanContext | undefined): string {
  return [
    "You are an engineering agent preparing an implementation plan, read-only, for the GitHub issue below.",
    "This run is fully automated, with nobody to respond to you: do not ask questions back, do not stop partway to check in — carry this through to completion yourself.",
    "",
    `Issue title: ${title}`,
    "Description:",
    body || "(no description)",
    "",
    ...(rePlan
      ? [
          "This is a revision: a plan was already posted and the team replied with feedback below. Revise the plan to directly address that feedback — resolve the questions it answers, adjust decisions it pushes back on — rather than repeating the previous plan unchanged.",
          "",
          "Previous plan:",
          rePlan.previousPlan,
          "",
          "Feedback received since then:",
          ...rePlan.feedback.map((c) => `- ${c.user?.login ?? "someone"}: ${c.body}`),
          "",
        ]
      : []),
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
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
    });
    const rePlan = findRePlanContext(comments);

    logger.info("generating the plan", { owner, repo, issueNumber, isRevision: Boolean(rePlan) });
    const result = await runAgent({
      cwd: repoDir,
      prompt: buildPlanPrompt(issue.title, issue.body ?? "", rePlan),
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

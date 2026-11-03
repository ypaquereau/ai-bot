import { join } from "node:path";
import { runnerEnv } from "./env.js";
import { cloneRepo } from "./git.js";
import { loadBotConfig } from "./config.js";
import { createOctokit, postComment, transitionLabels, markFailed } from "./github.js";
import { runClaude } from "./claude.js";
import { buildPlanComment } from "./markers.js";
import { STATE_LABELS, TRIGGER_LABELS } from "../shared/labels.js";
import { logger } from "../shared/logger.js";

function buildPlanPrompt(title: string, body: string): string {
  return [
    "Tu es un agent d'ingénierie qui prépare un plan d'implémentation, en lecture seule.",
    "Analyse l'issue GitHub ci-dessous ainsi que le code du dépôt (déjà cloné dans le répertoire courant).",
    "Ne modifie aucun fichier : contente-toi de lire et d'analyser.",
    "",
    `Titre de l'issue: ${title}`,
    "Description:",
    body || "(aucune description)",
    "",
    "Produis, en markdown:",
    "1. Un plan d'implémentation détaillé, étape par étape, citant les fichiers concernés.",
    "2. Une section finale '## Questions' listant les points à clarifier avant implémentation (vide si aucune).",
  ].join("\n");
}

export async function runPlanTask(): Promise<void> {
  const octokit = createOctokit();
  const { repoOwner: owner, repoName: repo, issueNumber } = runnerEnv;

  await transitionLabels(octokit, owner, repo, issueNumber, {
    add: [STATE_LABELS.planning],
    remove: [TRIGGER_LABELS.plan, STATE_LABELS.planReady],
  });

  try {
    const repoDir = join(runnerEnv.workspace, "repo");
    await cloneRepo(owner, repo, repoDir);
    const config = await loadBotConfig(repoDir);

    const { data: issue } = await octokit.issues.get({ owner, repo, issue_number: issueNumber });

    logger.info("génération du plan", { owner, repo, issueNumber });
    const result = await runClaude({
      cwd: repoDir,
      prompt: buildPlanPrompt(issue.title, issue.body ?? ""),
      permissionMode: "plan",
      allowedTools: ["Read", "Grep", "Glob"],
      maxTurns: config.maxTurns,
      model: config.model,
    });

    if (result.isError) {
      throw new Error(result.text);
    }

    await postComment(octokit, owner, repo, issueNumber, buildPlanComment(result.text));
    await transitionLabels(octokit, owner, repo, issueNumber, {
      add: [STATE_LABELS.planReady],
      remove: [STATE_LABELS.planning],
    });
  } catch (error) {
    await markFailed(octokit, owner, repo, issueNumber, STATE_LABELS.planning, String(error));
    throw error;
  }
}

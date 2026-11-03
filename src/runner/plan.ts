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
    "Tu es un agent d'ingénierie qui prépare un plan d'implémentation, en lecture seule.",
    "Analyse l'issue GitHub ci-dessous ainsi que le code du dépôt (déjà cloné dans le répertoire courant).",
    "Ne modifie, ne crée ni ne supprime aucun fichier du dépôt lui-même : contente-toi de lire et d'analyser.",
    "",
    `Titre de l'issue: ${title}`,
    "Description:",
    body || "(aucune description)",
    "",
    "Produis le plan en markdown, avec :",
    "1. Un plan d'implémentation détaillé, étape par étape, citant les fichiers concernés.",
    "2. Une section finale '## Questions' listant les points à clarifier avant implémentation (vide si aucune).",
    "",
    `Écris ce plan intégralement dans un unique fichier nommé exactement "${PLAN_OUTPUT_FILENAME}" à la racine du dépôt (le seul fichier que tu es autorisé à créer/écrire) ; ne le découpe pas et ne te contente pas d'un résumé dans ta réponse.`,
  ].join("\n");
}

/** Relit le plan écrit par l'agent dans PLAN_OUTPUT_FILENAME ; retombe sur le texte de la réponse si le fichier est absent. */
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

    logger.info("génération du plan", { owner, repo, issueNumber });
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

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
    "Tu es un agent d'ingénierie chargé d'implémenter le plan validé ci-dessous dans le dépôt cloné (répertoire courant).",
    "Utilise uniquement les outils et commandes autorisés. Commits et push sont gérés par un autre processus : toi, modifie juste les fichiers.",
    "Ce run est entièrement automatisé, sans personne pour te répondre : ne pose aucune question, ne demande aucune confirmation, ne propose pas d'étape suivante à valider. Va jusqu'au bout du plan toi-même.",
    "",
    `Titre de l'issue: ${title}`,
    "Description originale:",
    body || "(aucune description)",
    "",
    "Plan approuvé à implémenter:",
    plan || "(aucun plan trouvé, implémente directement la demande ci-dessus avec prudence)",
    "",
    `Une fois l'implémentation terminée, écris dans un unique fichier nommé exactement "${SUMMARY_OUTPUT_FILENAME}" à la racine du dépôt un résumé fini, destiné à la description de la pull request : ce qui a changé et pourquoi, en 3-4 phrases maximum. Pas de narration de processus ("je vais faire...", "étape suivante..."), pas de question, juste le résultat final.`,
  ].join("\n");
}

/** Relit le résumé écrit par l'agent dans SUMMARY_OUTPUT_FILENAME ; retombe sur le texte de la réponse si le fichier est absent. */
async function readSummaryOutput(repoDir: string, fallback: string): Promise<string> {
  try {
    const content = await readFile(join(repoDir, SUMMARY_OUTPUT_FILENAME), "utf8");
    return content.trim().length > 0 ? content : fallback;
  } catch {
    return fallback;
  }
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

    logger.info("implémentation du plan", { owner, repo, issueNumber });
    const result = await runAgent({
      cwd: repoDir,
      prompt: buildImplementPrompt(issue.title, issue.body ?? "", planComment?.body ?? ""),
      mode: "implement",
      model: config.model,
    });

    if (!(await hasChanges(repoDir))) {
      throw new Error("L'agent n'a produit aucune modification de fichier.");
    }

    const summary = await readSummaryOutput(repoDir, result.text);

    await commitAll(repoDir, `ai-bot: implémente la demande de l'issue #${issueNumber}`);
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

    await postComment(octokit, owner, repo, issueNumber, `✅ Pull request ouverte : ${pr.html_url}`);
    await transitionLabels(octokit, owner, repo, issueNumber, {
      add: [STATE_LABELS.prOpened],
      remove: [STATE_LABELS.implementing, STATE_LABELS.planReady],
    });
  } catch (error) {
    await markFailed(octokit, owner, repo, issueNumber, STATE_LABELS.implementing, String(error));
    throw error;
  }
}

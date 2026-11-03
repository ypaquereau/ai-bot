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
import { writeCursorPermissions } from "./cursor-permissions.js";
import { findLatestPlanComment } from "./markers.js";
import { STATE_LABELS, TRIGGER_LABELS } from "../shared/labels.js";
import { logger } from "../shared/logger.js";

function buildImplementPrompt(title: string, body: string, plan: string): string {
  return [
    "Tu es un agent d'ingénierie chargé d'implémenter le plan validé ci-dessous dans le dépôt cloné (répertoire courant).",
    "Utilise uniquement les outils et commandes autorisés. Commits et push sont gérés par un autre processus : toi, modifie juste les fichiers.",
    "",
    `Titre de l'issue: ${title}`,
    "Description originale:",
    body || "(aucune description)",
    "",
    "Plan approuvé à implémenter:",
    plan || "(aucun plan trouvé, implémente directement la demande ci-dessus avec prudence)",
    "",
    "Termine ta réponse par un résumé concis des changements effectués, destiné à la description de la pull request.",
  ].join("\n");
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
      body: `Closes #${issueNumber}\n\n${result.text}`,
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

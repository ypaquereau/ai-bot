import { Webhooks } from "@octokit/webhooks";
import type { IssuesLabeledEvent, IssueCommentCreatedEvent } from "@octokit/webhooks-types";
import { serverEnv, assertAllowedOwner } from "./env.js";
import { isBotSender, hasWriteAccess } from "./permissions.js";
import { installationOctokit } from "./github-app.js";
import { dispatchAgentTask } from "./dispatch.js";
import { TRIGGER_LABELS, STATE_LABELS } from "../shared/labels.js";
import { logger } from "../shared/logger.js";
import type { AgentTask } from "../shared/types.js";

export const webhooks = new Webhooks({ secret: serverEnv.githubWebhookSecret });

webhooks.on("issues.labeled", async ({ id, payload }) => {
  await handleIssuesLabeled(id, payload as IssuesLabeledEvent);
});

webhooks.on("issue_comment.created", async ({ id, payload }) => {
  await handleIssueComment(id, payload as IssueCommentCreatedEvent);
});

webhooks.onError((event) => {
  logger.error("échec du traitement d'un webhook", { errors: event.errors.map(String) });
});

async function handleIssuesLabeled(deliveryId: string, payload: IssuesLabeledEvent): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const labelName = payload.label?.name;

  if (isBotSender(payload.sender)) return;
  if (!assertAllowedOwner(owner)) {
    logger.warn("owner non autorisé, webhook ignoré", { owner, repo });
    return;
  }

  let task: AgentTask["task"] | undefined;
  if (labelName === TRIGGER_LABELS.plan) {
    task = "plan";
  } else if (labelName === TRIGGER_LABELS.approved) {
    task = "implement";
  } else {
    return;
  }

  await dispatchAgentTask({
    task,
    owner,
    repo,
    issueNumber: payload.issue.number,
    installationId: payload.installation!.id,
    deliveryId,
    isReplan: false,
  });
}

async function handleIssueComment(deliveryId: string, payload: IssueCommentCreatedEvent): Promise<void> {
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  if (isBotSender(payload.sender)) return;
  if (!assertAllowedOwner(owner)) return;
  if (!("pull_request" in payload.issue) || payload.issue.pull_request) return; // commentaires de PR ignorés

  const hasPlanReady = payload.issue.labels?.some((l) => l.name === STATE_LABELS.planReady) ?? false;
  if (!hasPlanReady) return;

  const installationId = payload.installation!.id;
  const octokit = await installationOctokit(installationId);
  const authorized = await hasWriteAccess(octokit, owner, repo, payload.comment.user.login);
  if (!authorized) {
    logger.info("commentaire ignoré: auteur sans droit write", {
      owner,
      repo,
      user: payload.comment.user.login,
    });
    return;
  }

  await dispatchAgentTask({
    task: "plan",
    owner,
    repo,
    issueNumber: payload.issue.number,
    installationId,
    deliveryId,
    isReplan: true,
  });
}

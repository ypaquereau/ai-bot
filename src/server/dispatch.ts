import { serverEnv } from "./env.js";
import { mintRepoScopedInstallationToken } from "./github-app.js";
import { batchApi, coreApi } from "./k8s.js";
import { buildJobManifest, buildSecretManifest, jobName, tokenSecretName } from "./job-spec.js";
import { hasActiveJobForIssue } from "./dedupe.js";
import { logger } from "../shared/logger.js";
import type { AgentTask } from "../shared/types.js";

/**
 * Creates the runner Job for the given task, after a deduplication check.
 * The Secret holding the installation token is created *after* the Job and
 * attached to it via ownerReference, so it's garbage-collected
 * automatically once the Job expires (ttlSecondsAfterFinished).
 */
export async function dispatchAgentTask(task: AgentTask): Promise<"dispatched" | "duplicate"> {
  if (await hasActiveJobForIssue(task.owner, task.repo, task.issueNumber)) {
    logger.info("task ignored: a job is already in flight for this issue", {
      owner: task.owner,
      repo: task.repo,
      issueNumber: task.issueNumber,
    });
    return "duplicate";
  }

  const { token } = await mintRepoScopedInstallationToken(task.installationId, task.owner, task.repo);

  const name = jobName(task);
  const secretName = tokenSecretName(name);

  const { body: createdJob } = await batchApi.createNamespacedJob(
    serverEnv.agentsNamespace,
    buildJobManifest(task, name, secretName),
  );

  if (!createdJob.metadata?.uid) {
    throw new Error(`Job ${name} created without a UID, cannot attach the Secret`);
  }

  await coreApi.createNamespacedSecret(
    serverEnv.agentsNamespace,
    buildSecretManifest(secretName, token, serverEnv.cursorApiKey, {
      apiVersion: "batch/v1",
      kind: "Job",
      name,
      uid: createdJob.metadata.uid,
      controller: true,
      blockOwnerDeletion: true,
    }),
  );

  logger.info("runner job created", {
    job: name,
    task: task.task,
    owner: task.owner,
    repo: task.repo,
    issueNumber: task.issueNumber,
  });

  return "dispatched";
}

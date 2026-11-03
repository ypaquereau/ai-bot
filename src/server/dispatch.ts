import { serverEnv } from "./env.js";
import { mintRepoScopedInstallationToken } from "./github-app.js";
import { batchApi, coreApi } from "./k8s.js";
import { buildJobManifest, buildSecretManifest, jobName, tokenSecretName } from "./job-spec.js";
import { hasActiveJobForIssue } from "./dedupe.js";
import { logger } from "../shared/logger.js";
import type { AgentTask } from "../shared/types.js";

/**
 * Crée le Job runner pour la tâche donnée, après vérification de
 * dédoublonnage. Le Secret contenant le token d'installation est créé
 * *après* le Job et rattaché à celui-ci via ownerReference, afin d'être
 * garbage-collecté automatiquement quand le Job expire (ttlSecondsAfterFinished).
 */
export async function dispatchAgentTask(task: AgentTask): Promise<"dispatched" | "duplicate"> {
  if (await hasActiveJobForIssue(task.owner, task.repo, task.issueNumber)) {
    logger.info("tâche ignorée: un job est déjà en cours pour cette issue", {
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
    throw new Error(`Job ${name} créé sans UID, impossible de rattacher le Secret`);
  }

  await coreApi.createNamespacedSecret(
    serverEnv.agentsNamespace,
    buildSecretManifest(secretName, token, serverEnv.anthropicApiKey, {
      apiVersion: "batch/v1",
      kind: "Job",
      name,
      uid: createdJob.metadata.uid,
      controller: true,
      blockOwnerDeletion: true,
    }),
  );

  logger.info("job runner créé", {
    job: name,
    task: task.task,
    owner: task.owner,
    repo: task.repo,
    issueNumber: task.issueNumber,
  });

  return "dispatched";
}

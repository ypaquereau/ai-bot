import { serverEnv } from "./env.js";
import { batchApi, isJobActive, jobLabelSelector } from "./k8s.js";
import { logger } from "../shared/logger.js";

/**
 * true si un Job runner est déjà en cours (non terminé) pour cette issue,
 * quelle que soit la tâche (plan ou implement) : on évite ainsi deux agents
 * concurrents sur la même issue.
 */
export async function hasActiveJobForIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  const labelSelector = jobLabelSelector(owner, repo, issueNumber);

  try {
    const { body } = await batchApi.listNamespacedJob(
      serverEnv.agentsNamespace,
      undefined,
      undefined,
      undefined,
      undefined,
      labelSelector,
    );

    return body.items.some((job) => isJobActive(job.status));
  } catch (error) {
    logger.error("échec de la vérification de dédoublonnage, on bloque par prudence", {
      owner,
      repo,
      issueNumber,
      error: String(error),
    });
    // En cas de doute (API k8s indisponible), on préfère ne pas lancer de job
    // en double plutôt que de risquer deux agents concurrents.
    return true;
  }
}

import { serverEnv } from "./env.js";
import { batchApi, isJobActive, jobLabelSelector } from "./k8s.js";
import { logger } from "../shared/logger.js";

/**
 * true if a runner Job is already in flight (not finished) for this issue,
 * regardless of task (plan or implement): this avoids two concurrent
 * agents on the same issue.
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
    logger.error("deduplication check failed, blocking out of caution", {
      owner,
      repo,
      issueNumber,
      error: String(error),
    });
    // When in doubt (k8s API unavailable), we'd rather not launch a
    // duplicate job than risk two concurrent agents.
    return true;
  }
}

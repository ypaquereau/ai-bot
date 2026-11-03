import { BatchV1Api, CoreV1Api, KubeConfig } from "@kubernetes/client-node";

const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();

export const batchApi = kubeConfig.makeApiClient(BatchV1Api);
export const coreApi = kubeConfig.makeApiClient(CoreV1Api);

export function jobLabelSelector(owner: string, repo: string, issueNumber: number): string {
  return `app=ai-bot-runner,owner=${owner},repo=${repo},issue=${issueNumber}`;
}

/** Un Job est considéré "en vol" tant qu'il n'a pas de date de complétion. */
export function isJobActive(status: { completionTime?: Date | string } | undefined): boolean {
  return !status?.completionTime;
}

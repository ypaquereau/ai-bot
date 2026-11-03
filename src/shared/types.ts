export type TaskType = "plan" | "implement";

/**
 * Description of a task to run on a runner pod.
 * Serialized into the k8s Job's environment variables.
 */
export interface AgentTask {
  readonly task: TaskType;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly installationId: number;
  /** Delivery id of the webhook that triggered the task (traceability + dedup). */
  readonly deliveryId: string;
  /** true if the task is a re-plan requested via a comment. */
  readonly isReplan: boolean;
}

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** Schema of `.github/ai-bot.yml`, as read from the target repo. */
export interface BotConfig {
  readonly model?: string;
  readonly draftPullRequest: boolean;
  readonly branchPrefix: string;
  readonly baseBranch?: string;
  readonly allowedBashCommands: readonly string[];
  readonly gitIdentity: GitIdentity;
}

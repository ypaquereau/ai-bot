export type TaskType = "plan" | "implement";

/**
 * Description d'une tâche à exécuter par un pod runner.
 * Sérialisée dans les variables d'environnement du Job k8s.
 */
export interface AgentTask {
  readonly task: TaskType;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly installationId: number;
  /** Identifiant de livraison du webhook ayant déclenché la tâche (traçabilité + dédoublonnage). */
  readonly deliveryId: string;
  /** true si la tâche est une re-planification demandée par commentaire. */
  readonly isReplan: boolean;
}

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** Schéma de `.github/ai-bot.yml`, tel que lu depuis le dépôt cible. */
export interface BotConfig {
  readonly model?: string;
  readonly draftPullRequest: boolean;
  readonly branchPrefix: string;
  readonly baseBranch?: string;
  readonly allowedBashCommands: readonly string[];
  readonly gitIdentity: GitIdentity;
}

/** Labels qui déclenchent une action côté serveur. */
export const TRIGGER_LABELS = {
  plan: "ai:plan",
  approved: "ai:approved",
} as const;

/** Labels d'état, posés uniquement par le runner. */
export const STATE_LABELS = {
  planning: "ai:planning",
  planReady: "ai:plan-ready",
  implementing: "ai:implementing",
  prOpened: "ai:pr-opened",
  failed: "ai:failed",
} as const;

export const ALL_BOT_LABELS = [
  TRIGGER_LABELS.plan,
  TRIGGER_LABELS.approved,
  STATE_LABELS.planning,
  STATE_LABELS.planReady,
  STATE_LABELS.implementing,
  STATE_LABELS.prOpened,
  STATE_LABELS.failed,
] as const;

export type BotLabel = (typeof ALL_BOT_LABELS)[number];

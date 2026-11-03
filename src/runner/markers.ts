export const PLAN_COMMENT_MARKER = "<!-- ai-bot:plan -->";

export function buildPlanComment(planText: string): string {
  return `${PLAN_COMMENT_MARKER}\n\n${planText}`;
}

export function findLatestPlanComment<T extends { body?: string | null }>(comments: readonly T[]): T | undefined {
  return [...comments].reverse().find((c) => c.body?.includes(PLAN_COMMENT_MARKER));
}

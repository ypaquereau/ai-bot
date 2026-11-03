import { parse } from "yaml";
import type { BotConfig } from "./types.js";

export const DEFAULT_CONFIG: BotConfig = {
  draftPullRequest: true,
  branchPrefix: "ai-bot/",
  allowedBashCommands: ["npm install", "npm test", "npm run build", "npm run lint"],
  gitIdentity: {
    name: "ai-bot[bot]",
    email: "ai-bot[bot]@users.noreply.github.com",
  },
};

/**
 * Parse `.github/ai-bot.yml`. Les champs absents retombent sur DEFAULT_CONFIG ;
 * un fichier absent ou vide produit la config par défaut.
 */
export function parseBotConfig(yamlText: string | undefined): BotConfig {
  if (!yamlText || yamlText.trim().length === 0) {
    return DEFAULT_CONFIG;
  }

  const raw = parse(yamlText) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    return DEFAULT_CONFIG;
  }

  const allowedBashCommands = Array.isArray(raw.allowedBashCommands)
    ? raw.allowedBashCommands.filter((c): c is string => typeof c === "string")
    : DEFAULT_CONFIG.allowedBashCommands;

  const gitIdentityRaw = raw.gitIdentity as Record<string, unknown> | undefined;

  return {
    model: typeof raw.model === "string" ? raw.model : undefined,
    draftPullRequest:
      typeof raw.draftPullRequest === "boolean" ? raw.draftPullRequest : DEFAULT_CONFIG.draftPullRequest,
    branchPrefix: typeof raw.branchPrefix === "string" ? raw.branchPrefix : DEFAULT_CONFIG.branchPrefix,
    baseBranch: typeof raw.baseBranch === "string" ? raw.baseBranch : undefined,
    allowedBashCommands,
    gitIdentity: {
      name:
        typeof gitIdentityRaw?.name === "string" ? gitIdentityRaw.name : DEFAULT_CONFIG.gitIdentity.name,
      email:
        typeof gitIdentityRaw?.email === "string"
          ? gitIdentityRaw.email
          : DEFAULT_CONFIG.gitIdentity.email,
    },
  };
}

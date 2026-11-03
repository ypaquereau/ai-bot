import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseBotConfig } from "../shared/config-schema.js";
import type { BotConfig } from "../shared/types.js";

export async function loadBotConfig(repoDir: string): Promise<BotConfig> {
  try {
    const text = await readFile(join(repoDir, ".github", "ai-bot.yml"), "utf8");
    return parseBotConfig(text);
  } catch {
    return parseBotConfig(undefined);
  }
}

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTaskMode } from "./agent.js";

/**
 * Règles refusées quelle que soit la tâche : secrets et clés privées, qu'on
 * ne veut jamais voir lus (et exfiltrés dans la réponse de l'agent) ni
 * écrasés. Ce sont elles qui comptent vraiment en mode `implement`, où
 * `--force` rend la liste `allow` non bloquante pour tout le reste.
 */
const SECRET_DENY_RULES = [
  "Read(.env*)",
  "Read(**/*.pem)",
  "Write(**/.env*)",
  "Write(**/*.key)",
  "Write(**/*.pem)",
] as const;

/** Commandes de lecture sans risque, utiles à l'agent pour explorer le code pendant la planification. */
const PLAN_READONLY_SHELL = ["Shell(ls)", "Shell(git)", "Shell(cat)", "Shell(grep)", "Shell(find)"] as const;

function shellRuleFor(command: string): string {
  const [head, ...rest] = command.trim().split(/\s+/);
  if (!head) {
    throw new Error("commande vide dans allowedBashCommands");
  }
  return rest.length > 0 ? `Shell(${head}:${rest.join(" ")}*)` : `Shell(${head})`;
}

/**
 * Écrit `.cursor/cli.json` (permissions au niveau projet, lues par `agent`)
 * dans le dépôt cloné. Appeler `excludeLocalPath` avant tout commit pour ne
 * pas que ce fichier soit capturé par `git add -A`.
 */
export async function writeCursorPermissions(
  repoDir: string,
  mode: AgentTaskMode,
  allowedBashCommands: readonly string[],
): Promise<void> {
  const permissions =
    mode === "plan"
      ? { allow: ["Read(**)", ...PLAN_READONLY_SHELL], deny: [...SECRET_DENY_RULES, "Write(**)"] }
      : {
          allow: ["Read(**)", "Write(**)", ...allowedBashCommands.map(shellRuleFor)],
          deny: [...SECRET_DENY_RULES],
        };

  const dir = join(repoDir, ".cursor");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cli.json"), JSON.stringify({ permissions }, null, 2));
}

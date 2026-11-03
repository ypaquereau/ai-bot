import { spawn } from "node:child_process";

export type AgentTaskMode = "plan" | "implement";

export interface AgentRunOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly mode: AgentTaskMode;
  readonly model?: string;
}

export interface AgentRunResult {
  readonly text: string;
}

/**
 * Environnement volontairement restreint passé au process `agent` : ni le
 * token GitHub ni GIT_ASKPASS n'y figurent, pour que l'agent ne puisse jamais
 * lire ou exfiltrer le token (le push se fait avant/après l'appel, depuis
 * notre propre code). CURSOR_API_KEY, lui, reste présent : l'agent en a
 * besoin pour s'authentifier.
 */
function restrictedEnv(): NodeJS.ProcessEnv {
  const { GITHUB_TOKEN_FILE, GIT_ASKPASS, ...rest } = process.env;
  return rest;
}

/**
 * Lance la CLI Cursor (`agent -p`) en mode headless.
 *
 * - `plan` : pas de `--force`, donc l'agent ne fait que *proposer* des
 *   changements sans jamais écrire sur disque (comportement documenté par
 *   défaut de la CLI) ; la planification reste donc en lecture seule même
 *   si `.cursor/cli.json` (écrit par src/runner/cursor-permissions.ts)
 *   autorise quelques commandes de lecture.
 * - `implement` : `--force` autorise les actions non explicitement
 *   refusées à s'exécuter sans confirmation interactive (qui bloquerait
 *   indéfiniment en headless). Dans ce mode, la vraie frontière de
 *   sécurité est la liste `permissions.deny` de `.cursor/cli.json`, pas la
 *   liste `allow` : `--force` la rend non bloquante pour tout ce qui n'est
 *   pas explicitement refusé.
 * - `--trust` : nécessaire en headless car chaque pod clone un dépôt neuf,
 *   que la CLI considérerait sinon comme un espace de travail non
 *   approuvé et demanderait une confirmation interactive impossible ici.
 */
export function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const args = ["-p", "--output-format", "json", "--trust", "--workspace", options.cwd];

  if (options.mode === "plan") {
    args.push("--mode", "plan");
  } else {
    args.push("--force");
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  args.push(options.prompt);

  return new Promise((resolve, reject) => {
    const child = spawn("agent", args, { cwd: options.cwd, env: restrictedEnv() });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`agent a échoué avec le code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(parseAgentOutput(stdout));
    });
  });
}

function parseAgentOutput(stdout: string): AgentRunResult {
  try {
    const parsed = JSON.parse(stdout) as { result?: string };
    return { text: parsed.result ?? stdout };
  } catch {
    return { text: stdout };
  }
}

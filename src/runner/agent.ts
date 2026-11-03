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
 * - `plan` : pas de `--mode plan` ni de `--force`. `--mode plan` s'est avéré
 *   taillé pour un usage interactif : en headless, il s'arrête après avoir
 *   annoncé son intention au lieu de produire l'analyse complète attendue
 *   dans le commentaire GitHub. Le mode agent par défaut, toujours sans
 *   `--force`, documente le même comportement en écriture ("ne fait que
 *   proposer des changements, n'écrit jamais sur disque") tout en rendant
 *   une réponse texte complète — la planification reste donc en lecture
 *   seule même si `.cursor/cli.json` (écrit par
 *   src/runner/cursor-permissions.ts) autorise quelques commandes de lecture.
 * - `implement` : `--force` autorise les actions non explicitement
 *   refusées à s'exécuter sans confirmation interactive (qui bloquerait
 *   indéfiniment en headless). Dans ce mode, la vraie frontière de
 *   sécurité est la liste `permissions.deny` de `.cursor/cli.json`, pas la
 *   liste `allow` : `--force` la rend non bloquante pour tout ce qui n'est
 *   pas explicitement refusé.
 * - `--trust` : nécessaire en headless car chaque pod clone un dépôt neuf,
 *   que la CLI considérerait sinon comme un espace de travail non
 *   approuvé et demanderait une confirmation interactive impossible ici.
 * - `--output-format stream-json` plutôt que `json` : avec `json`, le champ
 *   `.result` ne contient que le tout dernier message de l'agent — or les
 *   skills internes qu'il invoque (writing-plans, etc.) produisent souvent
 *   plusieurs segments de texte avant de conclure par une phrase de
 *   narration courte ("je finalise le plan"), sans jamais livrer le
 *   contenu dans ce dernier segment. `stream-json` expose chaque évènement
 *   NDJSON, ce qui permet de concaténer tous les segments `assistant`
 *   plutôt que de ne garder que le dernier. (Pour le mode `plan`, le vrai
 *   contenu du plan est de toute façon récupéré séparément en relisant
 *   PLAN_OUTPUT_FILENAME, voir plan.ts — ce flux sert surtout de filet pour
 *   le résumé de `implement`.)
 */
export function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const args = ["-p", "--output-format", "stream-json", "--trust", "--workspace", options.cwd];

  if (options.mode === "implement") {
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

interface AssistantEvent {
  readonly type: "assistant";
  readonly message: { readonly content: readonly { readonly type: string; readonly text?: string }[] };
}

interface ResultEvent {
  readonly type: "result";
  readonly subtype: string;
  readonly is_error?: boolean;
  readonly result?: string;
}

type StreamEvent = AssistantEvent | ResultEvent | { readonly type: string };

/**
 * Reconstruit le texte de la réponse à partir du flux NDJSON de
 * `--output-format stream-json` : concatène tous les segments de texte
 * `assistant` (pas seulement le dernier), puis retombe sur le `result`
 * final, puis sur la sortie brute.
 */
function parseAgentOutput(stdout: string): AgentRunResult {
  const events: StreamEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as StreamEvent);
    } catch {
      // ligne non-JSON (ex: sortie d'erreur mélangée) : ignorée.
    }
  }

  if (events.length === 0) {
    return { text: stdout };
  }

  const assistantText = events
    .filter((e): e is AssistantEvent => e.type === "assistant")
    .flatMap((e) => e.message.content)
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n\n");

  if (assistantText.trim().length > 0) {
    return { text: assistantText };
  }

  const resultEvent = events.find((e): e is ResultEvent => e.type === "result");
  return { text: resultEvent?.result ?? stdout };
}

import { spawn } from "node:child_process";

export type PermissionMode = "plan" | "acceptEdits";

export interface ClaudeRunOptions {
  readonly cwd: string;
  readonly prompt: string;
  readonly permissionMode: PermissionMode;
  readonly allowedTools: readonly string[];
  readonly maxTurns: number;
  readonly model?: string;
}

export interface ClaudeRunResult {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * Environnement volontairement restreint passé au process `claude` : ni le
 * token GitHub ni GIT_ASKPASS n'y figurent, pour que l'agent ne puisse jamais
 * lire ou exfiltrer le token (le push se fait avant/après l'appel à claude,
 * depuis notre propre code).
 */
function restrictedEnv(): NodeJS.ProcessEnv {
  const { GITHUB_TOKEN_FILE, GIT_ASKPASS, ...rest } = process.env;
  return rest;
}

/** Lance Claude Code en mode headless (`claude -p`) et récupère sa réponse finale. */
export function runClaude(options: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--permission-mode",
    options.permissionMode,
    "--max-turns",
    String(options.maxTurns),
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(" "));
  }

  args.push(options.prompt);

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd: options.cwd, env: restrictedEnv() });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`claude a échoué avec le code ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(parseClaudeOutput(stdout));
    });
  });
}

function parseClaudeOutput(stdout: string): ClaudeRunResult {
  try {
    const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
    return { text: parsed.result ?? stdout, isError: Boolean(parsed.is_error) };
  } catch {
    return { text: stdout, isError: false };
  }
}

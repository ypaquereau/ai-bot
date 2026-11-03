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
 * Deliberately restricted environment passed to the `agent` process: neither
 * the GitHub token nor GIT_ASKPASS appear in it, so the agent can never read
 * or exfiltrate the token (the push happens before/after the call, from our
 * own code). CURSOR_API_KEY stays present: the agent needs it to authenticate.
 */
function restrictedEnv(): NodeJS.ProcessEnv {
  const { GITHUB_TOKEN_FILE, GIT_ASKPASS, ...rest } = process.env;
  return rest;
}

/**
 * Runs the Cursor CLI (`agent -p`) in headless mode.
 *
 * - `plan`: no `--mode plan` and no `--force`. `--mode plan` turned out to be
 *   built for interactive use: in headless mode it stops after announcing
 *   its intent instead of producing the full analysis expected in the
 *   GitHub comment. The default agent mode, still without `--force`,
 *   documents the same write behavior ("only proposes changes, never
 *   writes to disk") while returning a complete text response — planning
 *   therefore stays read-only even though `.cursor/cli.json` (written by
 *   src/runner/cursor-permissions.ts) allows a few read commands.
 * - `implement`: `--force` lets actions that aren't explicitly denied run
 *   without an interactive confirmation (which would block forever in
 *   headless mode). In this mode the real security boundary is
 *   `.cursor/cli.json`'s `permissions.deny` list, not `allow`: `--force`
 *   makes the allow list non-blocking for everything else.
 * - `--trust`: needed in headless mode because each pod clones a fresh
 *   repo, which the CLI would otherwise treat as an untrusted workspace
 *   and prompt for confirmation — impossible here.
 * - `--output-format stream-json` instead of `json`: with `json`, the
 *   `.result` field only contains the agent's very last message — but the
 *   internal skills it invokes (writing-plans, etc.) often produce several
 *   text segments before wrapping up with a short narration sentence ("I'm
 *   finalizing the plan"), never delivering the actual content in that
 *   last segment. `stream-json` exposes every NDJSON event, which lets us
 *   concatenate all `assistant` segments instead of keeping only the last
 *   one. (For `plan` mode, the real plan content is fetched separately by
 *   re-reading PLAN_OUTPUT_FILENAME, see plan.ts — this stream mostly
 *   serves as a safety net for `implement`'s summary.)
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
        reject(new Error(`agent exited with code ${code}: ${stderr || stdout}`));
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
 * Reconstructs the response text from the NDJSON stream of
 * `--output-format stream-json`: concatenates every `assistant` text
 * segment (not just the last one), then falls back to the final `result`,
 * then to the raw output.
 */
function parseAgentOutput(stdout: string): AgentRunResult {
  const events: StreamEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as StreamEvent);
    } catch {
      // Non-JSON line (e.g. stray stderr output mixed in): ignored.
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

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTaskMode } from "./agent.js";

/**
 * Rules denied regardless of task: secrets and private keys, which we never
 * want read (and exfiltrated into the agent's response) or overwritten.
 * These are the ones that actually matter in `implement` mode, where
 * `--force` makes the `allow` list non-blocking for everything else.
 */
const SECRET_DENY_RULES = [
  "Read(.env*)",
  "Read(**/*.pem)",
  "Write(**/.env*)",
  "Write(**/*.key)",
  "Write(**/*.pem)",
] as const;

/** Safe read-only commands, useful for the agent to explore the code while planning. */
const PLAN_READONLY_SHELL = ["Shell(ls)", "Shell(git)", "Shell(cat)", "Shell(grep)", "Shell(find)"] as const;

/**
 * Name of the scratch file the agent writes its plan to in `plan` mode. The
 * agent's internal skills (writing-plans, ...) deliver their substantial
 * content via a file write rather than in their final response (see
 * src/runner/agent.ts); rather than block all writes and lose that content,
 * it's explicitly allowed for this one file, which the runner reads back
 * afterwards (see plan.ts) and excludes from the git repo.
 */
export const PLAN_OUTPUT_FILENAME = "ai-bot-plan.md";

/**
 * Same observation in `implement` mode: the agent's execution skill
 * (executing-plans) ends its response with conversational process
 * narration ("tell me if I should continue...") addressed to a human who
 * isn't there in headless mode, not a finished summary usable as a pull
 * request body. It's explicitly asked (see implement.ts) to write that
 * summary to this file instead of relying on the response text. Unlike
 * PLAN_OUTPUT_FILENAME, no dedicated permission rule is needed: `implement`
 * already has Write(**).
 */
export const SUMMARY_OUTPUT_FILENAME = "ai-bot-summary.md";

function shellRuleFor(command: string): string {
  const [head, ...rest] = command.trim().split(/\s+/);
  if (!head) {
    throw new Error("empty command in allowedBashCommands");
  }
  return rest.length > 0 ? `Shell(${head}:${rest.join(" ")}*)` : `Shell(${head})`;
}

/**
 * Writes `.cursor/cli.json` (project-level permissions, read by `agent`)
 * into the cloned repo. Call `excludeLocalPath` before any commit so this
 * file is never picked up by `git add -A`.
 */
export async function writeCursorPermissions(
  repoDir: string,
  mode: AgentTaskMode,
  allowedBashCommands: readonly string[],
): Promise<void> {
  const permissions =
    mode === "plan"
      ? {
          allow: ["Read(**)", ...PLAN_READONLY_SHELL, `Write(${PLAN_OUTPUT_FILENAME})`],
          deny: [...SECRET_DENY_RULES],
        }
      : {
          allow: ["Read(**)", "Write(**)", ...allowedBashCommands.map(shellRuleFor)],
          deny: [...SECRET_DENY_RULES],
        };

  const dir = join(repoDir, ".cursor");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cli.json"), JSON.stringify({ permissions }, null, 2));
}

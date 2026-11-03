import { spawn } from "node:child_process";
import { appendFile, chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runnerEnv } from "./env.js";
import type { GitIdentity } from "../shared/types.js";

function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} a échoué avec le code ${code}`));
    });
  });
}

/**
 * Écrit un script GIT_ASKPASS qui lit le token depuis le fichier monté par
 * k8s. Le token n'est ainsi jamais passé en argument de commande ni exposé
 * dans l'environnement du process `agent` (qui ne reçoit pas GIT_ASKPASS).
 */
async function writeAskPassScript(): Promise<string> {
  const scriptPath = join(runnerEnv.workspace, ".git-askpass.sh");
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    '  Username*) echo "x-access-token" ;;',
    `  Password*) cat "${runnerEnv.githubTokenFile}" ;;`,
    "esac",
    "",
  ].join("\n");
  await writeFile(scriptPath, script, { mode: 0o700 });
  await chmod(scriptPath, 0o700);
  return scriptPath;
}

async function gitEnv(): Promise<NodeJS.ProcessEnv> {
  return {
    ...process.env,
    GIT_ASKPASS: await writeAskPassScript(),
    GIT_TERMINAL_PROMPT: "0",
  };
}

export async function cloneRepo(owner: string, repo: string, destDir: string): Promise<void> {
  const env = await gitEnv();
  await run("git", ["clone", "--depth", "1", `https://github.com/${owner}/${repo}.git`, destDir], { env });
}

/**
 * Exclut `pattern` du dépôt via `.git/info/exclude` (jamais commité, local
 * au clone). Utilisé pour que `.cursor/cli.json`, écrit par le runner pour
 * piloter les permissions de l'agent, n'atterrisse jamais dans un commit.
 */
export async function excludeLocalPath(repoDir: string, pattern: string): Promise<void> {
  await appendFile(join(repoDir, ".git", "info", "exclude"), `\n${pattern}\n`);
}

export async function checkoutNewBranch(repoDir: string, branch: string): Promise<void> {
  await run("git", ["checkout", "-b", branch], { cwd: repoDir });
}

export async function configureIdentity(repoDir: string, identity: GitIdentity): Promise<void> {
  await run("git", ["config", "user.name", identity.name], { cwd: repoDir });
  await run("git", ["config", "user.email", identity.email], { cwd: repoDir });
}

export async function hasChanges(repoDir: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["status", "--porcelain"], { cwd: repoDir });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(output.trim().length > 0);
      else reject(new Error(`git status a échoué avec le code ${code}`));
    });
  });
}

export async function commitAll(repoDir: string, message: string): Promise<void> {
  await run("git", ["add", "-A"], { cwd: repoDir });
  await run("git", ["commit", "-m", message], { cwd: repoDir });
}

export async function pushBranch(repoDir: string, branch: string): Promise<void> {
  const env = await gitEnv();
  await run("git", ["push", "-u", "origin", branch], { cwd: repoDir, env });
}

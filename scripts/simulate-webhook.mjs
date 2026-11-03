#!/usr/bin/env node
// Builds a GitHub-shaped webhook payload, signs it with the same HMAC
// scheme GitHub uses (x-hub-signature-256), and POSTs it to a running
// server — no tunnel, no real GitHub delivery needed. See README.md >
// Testing locally. The target issue must exist for real on GitHub: the
// runner it triggers calls the real GitHub API to comment/label/open a PR.
import { createHmac, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

const USAGE = `Usage:
  node scripts/simulate-webhook.mjs <issues.labeled|issue_comment.created> \\
    --owner <org> --repo <name> --issue <number> --installation <id> \\
    [--label ai:plan] [--sender <login>] [--body <text>] \\
    [--url http://localhost:3000/webhook] [--secret <webhook-secret>]

--secret defaults to $GITHUB_WEBHOOK_SECRET, --url to $WEBHOOK_URL or
http://localhost:3000/webhook.`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    owner: { type: "string" },
    repo: { type: "string" },
    issue: { type: "string" },
    installation: { type: "string" },
    label: { type: "string", default: "ai:plan" },
    sender: { type: "string", default: "octocat" },
    body: { type: "string", default: "please re-plan" },
    url: { type: "string", default: process.env.WEBHOOK_URL ?? "http://localhost:3000/webhook" },
    secret: { type: "string", default: process.env.GITHUB_WEBHOOK_SECRET },
  },
});

const event = positionals[0];
if (event !== "issues.labeled" && event !== "issue_comment.created") {
  console.error(USAGE);
  process.exit(1);
}
for (const name of ["owner", "repo", "issue", "installation"]) {
  if (!values[name]) {
    console.error(`Missing --${name}\n\n${USAGE}`);
    process.exit(1);
  }
}
if (!values.secret) {
  console.error(`Missing --secret (or $GITHUB_WEBHOOK_SECRET)\n\n${USAGE}`);
  process.exit(1);
}

const common = {
  repository: { name: values.repo, owner: { login: values.owner } },
  sender: { login: values.sender, type: "User" },
  installation: { id: Number(values.installation) },
};

let githubEvent;
let payload;
if (event === "issues.labeled") {
  githubEvent = "issues";
  payload = {
    action: "labeled",
    issue: { number: Number(values.issue), labels: [{ name: values.label }] },
    label: { name: values.label },
    ...common,
  };
} else {
  githubEvent = "issue_comment";
  payload = {
    action: "created",
    // The server only reacts to comments on an issue currently labeled
    // ai:plan-ready — mirror that here regardless of which label this run
    // is nominally "about".
    issue: { number: Number(values.issue), labels: [{ name: "ai:plan-ready" }] },
    comment: { user: { login: values.sender }, body: values.body },
    ...common,
  };
}

const raw = JSON.stringify(payload);
const signature = `sha256=${createHmac("sha256", values.secret).update(raw).digest("hex")}`;

const response = await fetch(values.url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-github-event": githubEvent,
    "x-github-delivery": randomUUID(),
    "x-hub-signature-256": signature,
  },
  body: raw,
});

console.log(`${response.status} ${response.statusText}`);
console.log(await response.text());

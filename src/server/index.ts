import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { EmitterWebhookEvent } from "@octokit/webhooks";
import { serverEnv } from "./env.js";
import { webhooks } from "./webhook.js";
import { logger } from "../shared/logger.js";

const app = new Hono();

app.get("/healthz", (c) => c.text("ok"));

app.post("/webhook", async (c) => {
  const signature = c.req.header("x-hub-signature-256");
  const deliveryId = c.req.header("x-github-delivery");
  const eventName = c.req.header("x-github-event");
  const rawBody = await c.req.text();

  if (!signature || !deliveryId || !eventName) {
    return c.text("missing headers", 400);
  }

  const valid = await webhooks.verify(rawBody, signature);
  if (!valid) {
    logger.warn("invalid webhook signature", { deliveryId, eventName });
    return c.text("invalid signature", 401);
  }

  const payload = JSON.parse(rawBody) as unknown;

  // We respond right away; creating the k8s Job (which involves a call to
  // the GitHub API for the installation token, then to the k8s API)
  // continues in the background to stay under GitHub's webhook timeout.
  const event = {
    id: deliveryId,
    name: eventName,
    payload,
  } as EmitterWebhookEvent;

  queueMicrotask(() => {
    webhooks.receive(event).catch((error) => {
      logger.error("async webhook processing failed", {
        deliveryId,
        eventName,
        error: String(error),
      });
    });
  });

  return c.body(null, 202);
});

serve({ fetch: app.fetch, port: serverEnv.port }, (info) => {
  logger.info("webhook server started", { port: info.port });
});

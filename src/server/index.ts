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
    return c.text("en-têtes manquants", 400);
  }

  const valid = await webhooks.verify(rawBody, signature);
  if (!valid) {
    logger.warn("signature de webhook invalide", { deliveryId, eventName });
    return c.text("signature invalide", 401);
  }

  const payload = JSON.parse(rawBody) as unknown;

  // On répond tout de suite ; la création du Job k8s (qui implique un appel à
  // l'API GitHub pour le token d'installation puis à l'API k8s) se poursuit
  // en arrière-plan pour rester sous le délai de timeout des webhooks GitHub.
  const event = {
    id: deliveryId,
    name: eventName,
    payload,
  } as EmitterWebhookEvent;

  queueMicrotask(() => {
    webhooks.receive(event).catch((error) => {
      logger.error("échec du traitement asynchrone du webhook", {
        deliveryId,
        eventName,
        error: String(error),
      });
    });
  });

  return c.body(null, 202);
});

serve({ fetch: app.fetch, port: serverEnv.port }, (info) => {
  logger.info("serveur webhook démarré", { port: info.port });
});

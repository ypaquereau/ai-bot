import { runnerEnv } from "./env.js";
import { runPlanTask } from "./plan.js";
import { runImplementTask } from "./implement.js";
import { logger } from "../shared/logger.js";

async function main(): Promise<void> {
  logger.info("démarrage du runner", {
    task: runnerEnv.task,
    owner: runnerEnv.repoOwner,
    repo: runnerEnv.repoName,
    issueNumber: runnerEnv.issueNumber,
    isReplan: runnerEnv.isReplan,
  });

  switch (runnerEnv.task) {
    case "plan":
      await runPlanTask();
      break;
    case "implement":
      await runImplementTask();
      break;
    default:
      throw new Error(`Tâche inconnue: ${runnerEnv.task satisfies never}`);
  }
}

main()
  .then(() => {
    logger.info("tâche terminée avec succès");
    process.exit(0);
  })
  .catch((error) => {
    logger.error("tâche terminée en échec", { error: String(error) });
    process.exit(1);
  });

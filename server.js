const PORT = process.env.PORT || env.port || 8080;
import express from "express";
import { env } from "./config/env.js";
import routes from "./routes/routes.js";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler.js";
import { startCleanupCron } from "./services/cronService.js";
import { logger } from "./services/logger.js";

const app = express();

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Token");
    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }
    next();
});

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(routes);
app.use(notFoundHandler);
app.use(errorHandler);

if (env.runWorkerInApi) {
    // Optional fallback for single-service deployments (for example, one Railway service).
    import("./workers/emailWorker.js")
        .then(() => {
            logger.info("Embedded email worker started (RUN_WORKER_IN_API=true)");
        })
        .catch((error) => {
            logger.error("Failed to start embedded email worker", { error: error.message });
        });
}

app.listen(PORT,"0.0.0.0" ,() => {
    logger.info(`API server started on port ${env.port}`);
    startCleanupCron();
});
import express from "express";
import cors from "cors";
import { checkDatabaseHealth } from "./config/database";
import { env } from "./config/env";
import { amcRouter } from "./modules/amc/amc.routes";
import { authRouter } from "./modules/auth/auth.routes";
import { clientsRouter } from "./modules/clients/clients.routes";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes";
import { expensesRouter } from "./modules/expenses/expenses.routes";
import { procurementRouter } from "./modules/procurement/procurement.routes";
import { projectsRouter } from "./modules/projects/projects.routes";
import { rolesRouter } from "./modules/roles/roles.routes";
import { usersRouter } from "./modules/users/users.routes";
import { errorHandler, notFoundHandler } from "./shared/errors";

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/** Builds the Express application without starting a listener, so tests can drive it directly. */
export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  // Only the configured web origins may call the API from a browser (CORS_ORIGIN in .env).
  app.use(cors({ origin: env.corsOrigins }));
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      success: true,
      message: "STSLV AMC API is running",
    });
  });

  app.get("/api/health/database", async (_req, res) => {
    try {
      const health = await checkDatabaseHealth();

      res.json({
        success: true,
        message: "Database connected",
        database: health.databaseName,
      });
    } catch (error) {
      // Log the reason server-side only; the response stays generic.
      console.error(`Database health check failed: ${describeError(error)}`);

      res.status(503).json({
        success: false,
        message: "Database connection failed",
      });
    }
  });

  app.use("/api/auth", authRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/clients", clientsRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/roles", rolesRouter);
  app.use("/api/amc", amcRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/procurement", procurementRouter);
  app.use("/api/expenses", expensesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

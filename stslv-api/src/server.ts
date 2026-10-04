import "dotenv/config";
import { createApp, describeError } from "./app";
import { checkDatabaseHealth, isDatabasePasswordSet } from "./config/database";

const app = createApp();

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`STSLEV AMC API running on http://localhost:${PORT}`);

  if (!isDatabasePasswordSet) {
    console.warn("DB_PASSWORD is blank in .env. Database connections will fail until it is set.");
  }

  // Report database connectivity at startup without stopping the API.
  checkDatabaseHealth()
    .then((health) => {
      console.log(`Database connected: ${health.databaseName}`);
    })
    .catch((error) => {
      console.error(`Database connection failed at startup: ${describeError(error)}`);
    });
});

import app from "./app.js";
import knex from "./config/knex.js";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT;

async function init() {
  try {
    console.log("Running Migrations...");
    await knex.migrate.latest();
    console.log("Migrations completed.");

    const server = app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });

    const shutdown = async () => {
        console.log("Shutting down server...");
        server.close(async () => {});
        await knex.destroy();
        console.log("Server shut down complete.");
        process.exit(0);
    }

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error("Error during server initialization:", error);
    process.exit(1);
  }
}

init();
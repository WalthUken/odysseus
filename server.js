"use strict";

const express = require("express");
const packageMetadata = require("./package.json");

function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      status: "ok",
      service: packageMetadata.name,
      version: packageMetadata.version,
      timestamp: new Date().toISOString(),
    });
  });

  app.use("/api", (_request, response) => {
    response.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "The requested API resource was not found.",
      },
    });
  });

  app.use((error, _request, response, _next) => {
    const malformedJson = error instanceof SyntaxError && "body" in error;
    response.status(malformedJson ? 400 : 500).json({
      error: {
        code: malformedJson ? "INVALID_JSON" : "INTERNAL_ERROR",
        message: malformedJson
          ? "The request body must contain valid JSON."
          : "The request could not be completed.",
      },
    });
  });

  return app;
}

async function start() {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const server = app.listen(port, host, () => {
    console.log(`Odysseus listening at http://${host}:${port}`);
  });

  const close = () => {
    server.close((error) => {
      if (error) {
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return server;
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Odysseus failed to start:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  createApp,
  start,
};

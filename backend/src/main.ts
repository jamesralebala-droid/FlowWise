import "reflect-metadata";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as express from "express";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { env } from "./env.js";

/**
 * Production hosting (Phase 8): the API serves the built web dashboard
 * (dashboard + POS + supplier portal) as static files on the SAME origin, so
 * one deploy hosts everything and the browser never needs CORS. Client-side
 * routes fall back to index.html; /v1/* is never intercepted.
 */
function webDistDir(): string | null {
  const candidates = [
    env.webDist,
    join(process.cwd(), "web", "dist"),
    join(process.cwd(), "..", "web", "dist"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.setGlobalPrefix("v1");
  app.enableCors();

  const webDist = webDistDir();
  if (webDist) {
    app.use(express.static(webDist));
    // SPA fallback: /pos, /supplier, /reports … all serve the dashboard shell.
    app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (req.method !== "GET" || req.path.startsWith("/v1/")) return next();
      res.sendFile(join(webDist, "index.html"));
    });
    console.log(`[flowwise] serving web dashboard from ${webDist}`);
  }

  await app.listen(env.port, "0.0.0.0");
  console.log(
    `[flowwise] API listening on http://0.0.0.0:${env.port} (${env.databaseUrl ? "PostgreSQL" : "embedded PGlite"})`,
  );
}

void bootstrap();

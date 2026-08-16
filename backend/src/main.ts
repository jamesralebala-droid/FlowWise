import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { env } from "./env.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("v1");
  app.enableCors();
  await app.listen(env.port, "0.0.0.0");
  console.log(
    `[flowwise] API listening on http://0.0.0.0:${env.port} (${env.databaseUrl ? "PostgreSQL" : "embedded PGlite"})`,
  );
}

void bootstrap();

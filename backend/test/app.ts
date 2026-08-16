import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AppModule } from "../src/app.module.js";
import { DB_TOKEN } from "../src/db/constants.js";
import type { Fixtures } from "./setup.js";

export async function createTestApp(fx: Fixtures): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DB_TOKEN)
    .useValue(fx.db)
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  app.setGlobalPrefix("v1");
  await app.init();
  return app;
}

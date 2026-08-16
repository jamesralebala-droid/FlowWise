import "reflect-metadata";
import { createHash, randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";

const b64urlSha256 = (s: string) => Buffer.from(createHash("sha256").update(s).digest()).toString("base64url");

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: b64urlSha256(verifier) };
}

export interface LoginResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export async function login(
  app: INestApplication,
  username: string,
  password = "Password123!",
  deviceId?: string,
): Promise<LoginResult> {
  const { verifier, challenge } = pkce();
  const auth = await request(app.getHttpServer())
    .post("/v1/oauth/authorize")
    .send({ username, password, clientId: "flowwise-app", codeChallenge: challenge, codeChallengeMethod: "S256" });
  if (auth.status !== 201) throw new Error(`authorize failed: ${auth.status} ${JSON.stringify(auth.body)}`);
  const { code } = auth.body as { code: string };
  const body: Record<string, unknown> = {
    grantType: "authorization_code",
    code,
    codeVerifier: verifier,
    clientId: "flowwise-app",
  };
  if (deviceId) body.deviceId = deviceId;
  const token = await request(app.getHttpServer()).post("/v1/oauth/token").send(body);
  if (token.status !== 200) throw new Error(`token failed: ${token.status} ${JSON.stringify(token.body)}`);
  return token.body as LoginResult;
}


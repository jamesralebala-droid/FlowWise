// Centralised, typed environment access. Bun loads .env automatically.
const DEV_JWT_SECRET = "flowwise-dev-only-secret-change-me-0123456789abcdef";

export interface Env {
  databaseUrl?: string;
  jwtSecret: string;
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  port: number;
  autoMigrate: boolean;
  oauthClientId: string;
  /** Brute-force protection on /v1/oauth/authorize (Phase 4 hardening). */
  authMaxFailedAttempts: number;
  authAttemptWindowSeconds: number;
  /** Resend API key for eReceipts (Phase 5). Absent → emails are 'skipped'. */
  resendApiKey?: string;
  /** From-address for receipt emails (must be a verified sender on Resend). */
  receiptEmailFrom: string;
}

export function loadEnv(): Env {
  const jwtSecret = process.env.JWT_SECRET ?? DEV_JWT_SECRET;
  if (process.env.NODE_ENV === "production" && !process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET must be set in production");
  }
  if (process.env.JWT_SECRET && jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters");
  }
  return {
    databaseUrl: process.env.DATABASE_URL || undefined,
    jwtSecret,
    issuer: process.env.JWT_ISSUER ?? "flowwise",
    audience: process.env.JWT_AUDIENCE ?? "flowwise-app",
    accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
    refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 2592000),
    port: Number(process.env.PORT ?? 4000),
    autoMigrate: (process.env.AUTO_MIGRATE ?? "true") !== "false",
    oauthClientId: process.env.OAUTH_CLIENT_ID ?? "flowwise-app",
    authMaxFailedAttempts: Number(process.env.AUTH_MAX_FAILED_ATTEMPTS ?? 5),
    authAttemptWindowSeconds: Number(process.env.AUTH_ATTEMPT_WINDOW_SECONDS ?? 900),
    resendApiKey: process.env.RESEND_API_KEY || undefined,
    receiptEmailFrom: process.env.RECEIPT_EMAIL_FROM ?? "FlowWise Receipts <onboarding@resend.dev>",
  };
}

export const env: Env = loadEnv();

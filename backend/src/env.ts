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
  /** Mobile-money provider (Phase 6): 'mock' (default, auto-confirms) or 'dodo'. */
  mobileMoneyProvider: "mock" | "dodo";
  /** Dodo Payments API key (Phase 6). Absent → provider falls back to mock behaviour. */
  dodoApiKey?: string;
  /** Dodo webhook secret used to verify /v1/mobile-money/webhook signatures. */
  dodoWebhookSecret?: string;
  /** Supplier-portal access-token lifetime (Phase 7). */
  supplierTokenTtlSeconds: number;
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
    mobileMoneyProvider: process.env.MOBILE_MONEY_PROVIDER === "dodo" ? "dodo" : "mock",
    dodoApiKey: process.env.DODO_API_KEY || undefined,
    dodoWebhookSecret: process.env.DODO_WEBHOOK_SECRET || undefined,
    supplierTokenTtlSeconds: Number(process.env.SUPPLIER_TOKEN_TTL_SECONDS ?? 86400),
  };
}

export const env: Env = loadEnv();

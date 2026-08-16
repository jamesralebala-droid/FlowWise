// FlowWise — smoke load test (Phase 4 "load testing").
//
//   bun run load:test
//   LOAD_WORKERS=16 LOAD_ITERATIONS=50 bun run load:test
//
// Boots the full Nest app against embedded PostgreSQL (PGlite) on an
// ephemeral port, then runs `workers` concurrent till sessions. Each worker
// logs in once (authorize + token) and completes `iterations` sales — the
// busiest server path: server pricing, FEFO allocation, ledger writes, audit.
// Exits non-zero if ANY request fails, so it is CI-gateable.
//
// Caveat: PGlite serializes transactions in-process, so absolute numbers are
// a smoke signal, not a production benchmark. Run against a real PostgreSQL
// (DATABASE_URL set) for representative throughput.

import "reflect-metadata";
import { performance } from "node:perf_hooks";
import { createTestDb, type Fixtures } from "../test/setup.js";
import { createTestApp } from "../test/app.js";
import { pkce } from "../test/helpers.js";
import { env } from "../src/env.js";

const WORKERS = Number(process.env.LOAD_WORKERS ?? 8);
const ITERATIONS = Number(process.env.LOAD_ITERATIONS ?? 20);

async function login(base: string): Promise<string> {
  const { verifier, challenge } = pkce();
  const auth = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "cashier@flowwise.demo",
      password: "Password123!",
      clientId: "flowwise-app",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    }),
  });
  if (!auth.ok) throw new Error(`authorize ${auth.status}`);
  const { code } = (await auth.json()) as { code: string };
  const token = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grantType: "authorization_code", code, codeVerifier: verifier, clientId: "flowwise-app" }),
  });
  if (!token.ok) throw new Error(`token ${token.status}`);
  return ((await token.json()) as { access_token: string }).access_token;
}

async function createSale(base: string, bearer: string, fx: Fixtures, opId: string): Promise<void> {
  const res = await fetch(`${base}/sales`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      clientOperationId: opId,
      branchId: fx.branchA1,
      lines: [{ variantId: fx.variantA, quantity: "1" }],
      tenders: [{ tenderType: "cash", amount: "8.55" }],
    }),
  });
  if (res.status !== 201) throw new Error(`sale ${res.status}: ${await res.text()}`);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function main(): Promise<void> {
  const fx = await createTestDb();
  const app = await createTestApp(fx);
  await app.listen(0);
  const port = (app.getHttpServer() as { address(): { port: number } }).address().port;
  const base = `http://127.0.0.1:${port}/v1`;

  console.log(`load test: ${WORKERS} workers x ${ITERATIONS} sales each -> ${base} (db: ${env.databaseUrl ? "PostgreSQL" : "embedded PGlite"})`);
  const started = performance.now();
  const saleLatencies: number[] = [];
  let errors = 0;

  await Promise.all(
    Array.from({ length: WORKERS }, async (_, w) => {
      const bearer = await login(base); // one login per till session
      for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        try {
          await createSale(base, bearer, fx, `load-${w}-${i}`);
          saleLatencies.push(performance.now() - t0);
        } catch (err) {
          errors += 1;
          console.error(`worker ${w} iteration ${i}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }),
  );

  const elapsedMs = performance.now() - started;
  const total = WORKERS * ITERATIONS;
  const sorted = [...saleLatencies].sort((a, b) => a - b);
  console.log(
    `done: ${total} sales in ${(elapsedMs / 1000).toFixed(2)}s — ` +
      `${((total * 1000) / elapsedMs).toFixed(1)} sales/s\n` +
      `sale latency ms — p50: ${percentile(sorted, 50).toFixed(1)}, p95: ${percentile(sorted, 95).toFixed(1)}, ` +
      `p99: ${percentile(sorted, 99).toFixed(1)}, max: ${sorted.length ? sorted[sorted.length - 1].toFixed(1) : "n/a"}\n` +
      `errors: ${errors}`,
  );

  await app.close();
  await fx.db.close();
  // Explicit exit: PGlite teardown otherwise surfaces Bun's exit-99 quirk.
  process.exit(errors > 0 ? 1 : 0);
}

void main();

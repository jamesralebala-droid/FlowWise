// FlowWise API client for the web dashboard. Same OAuth2 Authorization Code
// + PKCE flow the Android app uses: the backend's /oauth/authorize is a
// native-client JSON endpoint (no browser redirect), so this is a straight
// two-call exchange. Tokens live in sessionStorage (browser session only).

export const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:4000/v1";

const CLIENT_ID = "flowwise-app";

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  orgId: string;
  defaultBranchId: string | null;
}

const SESSION_KEY = "flowwise.session";

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Async(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return b64url(new Uint8Array(digest));
}

/** Random 43-char PKCE verifier (RFC 7636). The S256 challenge is derived at use. */
function pkceVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

async function postJson(path: string, body: Record<string, unknown>, token?: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  return { status: res.status, json };
}

export interface LoginResult {
  session: Session;
  me: Record<string, unknown>;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const verifier = pkceVerifier();
  const challengeHash = await sha256Async(verifier);
  const auth = await postJson("/oauth/authorize", {
    username,
    password,
    clientId: CLIENT_ID,
    codeChallenge: challengeHash,
    codeChallengeMethod: "S256",
  });
  if (auth.status !== 201) {
    throw new Error(apiMessage(auth.json, "Login failed — check your credentials"));
  }
  const code = (auth.json as { code: string }).code;
  const token = await postJson("/oauth/token", {
    grantType: "authorization_code",
    code,
    codeVerifier: verifier,
    clientId: CLIENT_ID,
  });
  if (token.status !== 200) {
    throw new Error(apiMessage(token.json, "Could not exchange the login code"));
  }
  const t = token.json as { access_token: string; refresh_token: string; expires_in?: number };
  const me = await authedGet("/me", t.access_token);
  const org = (me as { org?: Record<string, unknown> }).org ?? {};
  const session: Session = {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in ?? 900) * 1000,
    orgId: String(org.id ?? ""),
    defaultBranchId: ((me as { defaultBranch?: { id?: string } | null }).defaultBranch?.id as string) ?? null,
  };
  saveSession(session);
  return { session, me: me as Record<string, unknown> };
}

async function authedGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(API_BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(apiMessage(await res.json().catch(() => null), `Request failed (${res.status})`));
  return res.json();
}

async function refreshSession(): Promise<Session | null> {
  const current = loadSession();
  if (!current) return null;
  const res = await fetch(API_BASE + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grantType: "refresh_token",
      refreshToken: current.refreshToken,
      clientId: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    clearSession();
    return null;
  }
  const t = (await res.json()) as { access_token: string; refresh_token: string; expires_in?: number };
  const next: Session = {
    ...current,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in ?? 900) * 1000,
  };
  saveSession(next);
  return next;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Authenticated fetch with one refresh-and-retry on 401. */
export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  let session = loadSession();
  if (!session) throw new ApiError(401, "Not signed in");

  const doFetch = (token: string): Promise<Response> =>
    fetch(API_BASE + path, {
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

  let res = await doFetch(session.accessToken);
  if (res.status === 401 && session.refreshToken) {
    const refreshed = await refreshSession();
    if (refreshed) {
      session = refreshed;
      res = await doFetch(session.accessToken);
    }
  }
  if (res.status === 401) {
    clearSession();
    window.location.href = "/login";
    throw new ApiError(401, "Session expired — sign in again");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, body?.message ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export function apiMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return fallback;
}

export function fmtMoney(amount: unknown): string {
  const n = Number(amount ?? 0);
  return "P " + n.toLocaleString("en-BW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtPct(value: unknown): string {
  const n = Number(value ?? 0);
  return (n * 100).toFixed(1) + "%";
}

export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

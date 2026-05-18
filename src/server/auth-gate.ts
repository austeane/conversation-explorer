/**
 * Server-only passphrase gate.
 *
 * Cookie value = HMAC-SHA256(SITE_SECRET, SITE_PASSPHRASE).
 * The passphrase itself is never stored client-side.
 * Rotating either env var invalidates all sessions.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import {
  getCookie,
  setCookie,
  deleteCookie,
} from "@tanstack/react-start/server";

export const SESSION_COOKIE = "conversation_session";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Paths that bypass the gate. Everything else must be authed.
 *
 * - `/auth` and `/_serverFn/...` for the gate itself (the auth form posts via a
 *   server function, which Start routes through `/_serverFn/...`)
 * - `/_build/...`, `/_assets/...`, `/_serverFn/...` and friends — Vite/Nitro/Start
 *   internals. We use a prefix match on `/_` to cover all generated paths.
 * - `/favicon.ico`, `/robots.txt` — common conveniences.
 */
const ALLOWLIST_EXACT = new Set<string>([
  "/auth",
  "/favicon.ico",
  "/robots.txt",
]);
const ALLOWLIST_PREFIXES: ReadonlyArray<string> = [
  "/_", // /_build/, /_assets/, /_serverFn/, /__tanstack_router_devtools__/...
  "/@", // vite client modules in dev (e.g. /@vite/client, /@id/...)
  "/node_modules/", // dev-only vite re-exports
  "/src/", // dev-only direct module loads
];

export function isAllowlistedPath(pathname: string): boolean {
  if (ALLOWLIST_EXACT.has(pathname)) return true;
  for (const prefix of ALLOWLIST_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  return false;
}

function getEnv(): { passphrase: string; secret: string } {
  const passphrase = process.env.SITE_PASSPHRASE;
  const secret = process.env.SITE_SECRET;
  if (!passphrase || !secret) {
    // Fail closed. We do NOT want a silent permit when env is missing.
    throw new Error(
      "conversation explorer: SITE_PASSPHRASE and SITE_SECRET must both be set",
    );
  }
  return { passphrase, secret };
}

/** HMAC-SHA256 hex of the passphrase under the secret. */
function signedToken(): string {
  const { passphrase, secret } = getEnv();
  return createHmac("sha256", secret).update(passphrase).digest("hex");
}

export function verifyPassphrase(supplied: string): boolean {
  const { passphrase } = getEnv();
  // Equal-length compare to avoid throwing on mismatched lengths.
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(passphrase, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isAuthedFromCookie(): boolean {
  const cookieValue = getCookie(SESSION_COOKIE);
  if (!cookieValue) return false;
  const expected = signedToken();
  if (cookieValue.length !== expected.length) return false;
  return timingSafeEqual(
    Buffer.from(cookieValue, "utf8"),
    Buffer.from(expected, "utf8"),
  );
}

export function setAuthCookie(): void {
  setCookie(SESSION_COOKIE, signedToken(), {
    httpOnly: true,
    sameSite: "lax",
    // `Secure` breaks plain-http localhost during dev. Production deploys
    // under HTTPS so we re-enable there.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

export function clearAuthCookie(): void {
  deleteCookie(SESSION_COOKIE, { path: "/" });
}

import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieState = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("@tanstack/react-start/server", () => ({
  getCookie: () => cookieState.value,
  setCookie: (_name: string, value: string) => {
    cookieState.value = value;
  },
  deleteCookie: () => {
    cookieState.value = undefined;
  },
}));

import {
  clearAuthCookie,
  isAllowlistedPath,
  isAuthedFromCookie,
  setAuthCookie,
  verifyPassphrase,
} from "~/server/auth-gate";

describe("passphrase gate", () => {
  beforeEach(() => {
    process.env.SITE_PASSPHRASE = "codex-local";
    process.env.SITE_SECRET = "test-secret";
    cookieState.value = undefined;
  });

  it("does not allowlist sensitive routes", () => {
    expect(isAllowlistedPath("/auth")).toBe(true);
    expect(isAllowlistedPath("/_build/client.js")).toBe(true);
    expect(isAllowlistedPath("/attachments/example.jpg")).toBe(false);
    expect(isAllowlistedPath("/desire")).toBe(false);
  });

  it("verifies the configured passphrase without accepting partial matches", () => {
    expect(verifyPassphrase("codex-local")).toBe(true);
    expect(verifyPassphrase("codex")).toBe(false);
    expect(verifyPassphrase("wrong-value")).toBe(false);
  });

  it("authenticates only with the signed session cookie", () => {
    expect(isAuthedFromCookie()).toBe(false);

    cookieState.value = "codex-local";
    expect(isAuthedFromCookie()).toBe(false);

    setAuthCookie();
    expect(isAuthedFromCookie()).toBe(true);

    clearAuthCookie();
    expect(isAuthedFromCookie()).toBe(false);
  });
});

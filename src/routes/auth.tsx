import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";
import { useRuntimeIdentity } from "~/lib/conversation/runtime-identity";

const submitInput = z.object({
  passphrase: z.string().min(1).max(512),
  next: z.string().optional(),
});

// `createServerOnlyFn` ensures `~/server/auth-gate` (and its `node:crypto`
// import) never reaches the client bundle, even via dynamic import / chunking.
const verifyAndSign = createServerOnlyFn(
  async (passphrase: string): Promise<boolean> => {
    const { verifyPassphrase, setAuthCookie } = await import(
      "~/server/auth-gate"
    );
    if (!verifyPassphrase(passphrase)) return false;
    setAuthCookie();
    return true;
  },
);

/**
 * POST /_serverFn/... — validates the passphrase, sets the signed cookie,
 * and tells the client where to bounce next.
 */
export const submitPassphrase = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => submitInput.parse(input))
  .handler(async ({ data }) => {
    const ok = await verifyAndSign(data.passphrase);
    if (!ok) {
      // Generic error — don't leak whether the passphrase was *almost* right.
      throw new Error("Incorrect passphrase.");
    }
    // Sanitize `next`: only allow same-origin paths starting with "/".
    const safeNext =
      data.next && data.next.startsWith("/") && !data.next.startsWith("//")
        ? data.next
        : "/";
    return { ok: true as const, next: safeNext };
  });

const searchSchema = z.object({ next: z.string().optional() });

export const Route = createFileRoute("/auth")({
  validateSearch: (raw): z.infer<typeof searchSchema> =>
    searchSchema.parse(raw),
  head: () => ({
    meta: [{ title: "Sign in" }],
  }),
  component: AuthPage,
});

function AuthPage() {
  const identity = useRuntimeIdentity();
  const search = Route.useSearch();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const form = event.currentTarget;
    const passphrase = (form.elements.namedItem("passphrase") as HTMLInputElement)
      .value;
    try {
      const result = await submitPassphrase({
        data: { passphrase, next: search.next },
      });
      // Hard-navigate so SSR re-runs with the fresh cookie. router.navigate
      // would do client-side, which is fine, but reload guarantees the gate
      // sees the cookie on the very next request.
      window.location.assign(result.next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
      // Make sure router sees the new state if we ever switch to inline render.
      void router.invalidate();
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-kicker">Private archive</div>
        <h1 className="auth-title">{identity.brand}</h1>
        <p className="auth-copy">Enter the passphrase to continue.</p>

        <label
          className="auth-label"
          htmlFor="passphrase"
        >
          Passphrase
        </label>
        <input
          className="auth-input"
          id="passphrase"
          name="passphrase"
          type="password"
          autoComplete="current-password"
          required
          disabled={busy}
        />

        {error ? (
          <div className="auth-error" role="alert">
            {error}
          </div>
        ) : null}

        <button
          className="auth-submit"
          type="submit"
          disabled={busy}
        >
          {busy ? "Signing in…" : "Continue"}
        </button>
      </form>
    </div>
  );
}

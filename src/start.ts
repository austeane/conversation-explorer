/**
 * TanStack Start global configuration. This file is auto-loaded by Start —
 * declaring `createStart` here registers the global request middleware that
 * enforces our passphrase gate on every server request.
 *
 * The server-only auth-gate module is dynamically imported inside `.server()`
 * so its `node:crypto` reach never lands in the client bundle.
 *
 * https://tanstack.com/start/latest/docs/framework/react/middleware
 */
import { createStart, createMiddleware } from "@tanstack/react-start";

const passphraseGate = createMiddleware().server(
  async ({ request, pathname, next }) => {
    const { isAllowlistedPath, isAuthedFromCookie } = await import(
      "~/server/auth-gate"
    );

    if (isAllowlistedPath(pathname)) {
      return next();
    }

    if (isAuthedFromCookie()) {
      return next();
    }

    // Build the redirect target. Preserve the original pathname + search so the
    // /auth page can bounce the user back after a successful submission.
    const url = new URL(request.url);
    const next_ = `${pathname}${url.search}`;
    const location = `/auth?next=${encodeURIComponent(next_)}`;

    return new Response(null, {
      status: 302,
      headers: { Location: location },
    });
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [passphraseGate],
}));

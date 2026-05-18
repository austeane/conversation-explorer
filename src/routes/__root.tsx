import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { GlobalFilters } from "~/components/GlobalFilters";
import { ModeNav } from "~/components/ModeNav";
import { RuntimeIdentityContext } from "~/lib/conversation/runtime-identity";
import { getPhaseOptions } from "~/server/phase-queries";
import { getRuntimeIdentity } from "~/server/runtime-identity";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  loader: async () => ({
    phaseOptions: await getPhaseOptions(),
    identity: await getRuntimeIdentity(),
  }),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Conversation Explorer" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { phaseOptions, identity } = Route.useLoaderData();

  return (
    <RuntimeIdentityContext.Provider value={identity}>
      <div className="shell">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="topbar">
          <div className="topbar-inner">
            <Link to="/" className="brand">
              <span className="brand-title">{identity.brand}</span>
              <span className="brand-sub">{identity.subtitle}</span>
            </Link>
            <ModeNav />
          </div>
        </header>
        <GlobalFilters phases={phaseOptions} />
        <main id="main" className="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </RuntimeIdentityContext.Provider>
  );
}

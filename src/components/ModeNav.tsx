import { Link, useLocation } from "@tanstack/react-router";
import type { RouteMeta } from "~/routes/_meta";
import { MODES, modeForPath, primaryRouteForMode, routeForPath, routesForMode } from "~/routes/_meta";

const PRIMARY_SUBNAV_PATHS = new Set([
  "/insights",
  "/",
  "/comparisons",
  "/methods",
  "/browse",
  "/ask",
  "/attachments",
  "/conversations",
  "/vocabulary",
  "/phrases",
  "/echoes",
  "/dynamics",
  "/gestures",
  "/repair",
  "/open-loops",
  "/forecasts",
  "/weather",
  "/atlas",
  "/lifecycles",
  "/rhythms",
  "/desire",
]);

export function ModeNav() {
  const location = useLocation();
  const activeMode = modeForPath(location.pathname);
  const activeRoute = routeForPath(location.pathname);
  const activeRoutes = routesForMode(activeMode);
  const primaryRoutes = activeRoutes.filter((route) => PRIMARY_SUBNAV_PATHS.has(route.path));
  const overflowRoutes = activeRoutes.filter((route) => !PRIMARY_SUBNAV_PATHS.has(route.path));
  const overflowActive = overflowRoutes.some((route) => activeRoute?.path === route.path);

  return (
    <nav className="mode-nav" aria-label="Primary navigation">
      <div className="mode-nav-primary" role="list">
        {MODES.map((mode) => {
          const primary = primaryRouteForMode(mode.id);
          const isActive = activeMode === mode.id;
          return (
            <Link
              key={mode.id}
              to={primary.path as any}
              className={isActive ? "mode-pill active" : "mode-pill"}
              aria-current={isActive ? "true" : undefined}
            >
              <span>{mode.label}</span>
              {mode.id === "sensitive" && <em>Private</em>}
            </Link>
          );
        })}
      </div>

      <div className="mode-nav-secondary" aria-label={`${activeMode} routes`}>
        {primaryRoutes.map((route) => (
          <SubnavLink key={route.path} route={route} active={activeRoute?.path === route.path} />
        ))}
        {overflowRoutes.length > 0 && (
          <details className="subnav-more">
            <summary className={overflowActive ? "subnav-link active" : "subnav-link"}>
              <span>More</span>
            </summary>
            <div className="subnav-more-menu">
              {overflowRoutes.map((route) => (
                <SubnavLink key={route.path} route={route} active={activeRoute?.path === route.path} />
              ))}
            </div>
          </details>
        )}
      </div>

      <details className="mode-nav-mobile">
        <summary>
          <span>{activeRoute?.label ?? "Navigate"}</span>
          <small>{MODES.find((mode) => mode.id === activeMode)?.label}</small>
        </summary>
        <div className="mode-nav-mobile-panel">
          {MODES.map((mode) => (
            <div key={mode.id} className="mobile-mode-group">
              <div className="mobile-mode-title">{mode.label}</div>
              {routesForMode(mode.id).map((route) => (
                <Link key={route.path} to={route.path as any} className="mobile-route-link">
                  {route.label}
                </Link>
              ))}
            </div>
          ))}
        </div>
      </details>
    </nav>
  );
}

function SubnavLink({ route, active }: { route: RouteMeta; active: boolean }) {
  return (
    <Link
      to={route.path as any}
      className={active ? "subnav-link active" : "subnav-link"}
      aria-current={active ? "page" : undefined}
    >
      <span>{route.label}</span>
      {route.addedRoute && <em>New</em>}
    </Link>
  );
}

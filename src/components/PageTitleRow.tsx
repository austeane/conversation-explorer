import { Link } from "@tanstack/react-router";
import { modeForPath, routesForMode, type RouteMeta } from "~/routes/_meta";

export function PageTitleRow({ activePath }: { activePath: string }) {
  const mode = modeForPath(activePath);
  const routes = routesForMode(mode);
  const active = routes.find((route) => route.path === activePath);
  if (!active) return <h1 className="page-title">{activePath}</h1>;

  return (
    <h1 className="page-title page-title-row" aria-label={`${active.label}, one of ${routes.length} ${mode} views`}>
      {routes.map((route, index) => {
        const isActive = route.path === active.path;
        return (
          <span key={route.path} className="page-title-row-item">
            {index > 0 && (
              <span className="page-title-row-sep" aria-hidden="true">
                ·
              </span>
            )}
            {isActive ? (
              <span className="page-title-row-active" aria-current="page">
                {route.label}
              </span>
            ) : (
              <SiblingLink route={route} />
            )}
          </span>
        );
      })}
    </h1>
  );
}

function SiblingLink({ route }: { route: RouteMeta }) {
  return (
    <Link to={route.path as any} className="page-title-row-link">
      {route.label}
    </Link>
  );
}

import type { Route } from "next";

/**
 * Narrows a path built at runtime (an id in the URL, a query string) to the router's typed
 * route. Static paths in the app are written inline and checked by `typedRoutes`; this
 * is the one escape hatch for the dynamic ones. The double assertion keeps the same code
 * valid whether or not Next has generated the route types yet (as in a fresh CI checkout).
 */
export function route(path: string): Route {
  return path as unknown as Route;
}

import { createBrowserRouter } from "react-router";
import { syncAccess } from "./lib/session.ts";
import { scopeLinks } from "./lib/timelineScope.ts";
import { routes } from "./appRoutes.tsx";

export const router = createBrowserRouter(routes);

// The timeline scope (?tl=) follows every navigation (the root route's
// middleware) and every link's href, so a copied or new-tab link keeps it too.
scopeLinks(router);

// Caches follow who is signed in, here and in other tabs (lib/session.ts).
syncAccess(router);

import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { lazy, Suspense, type ComponentType } from "react";

import { RootShell } from "./components/Shell.js";
import { ErrorState, LoadingState } from "./components/States.js";

function lazyPage(loader: () => Promise<{ default: ComponentType }>) {
  const Component = lazy(loader);
  return function LazyPage() {
    return (
      <Suspense fallback={<LoadingState />}>
        <Component />
      </Suspense>
    );
  };
}

const rootRoute = createRootRoute({
  component: RootShell,
  errorComponent: ({ error }) => <ErrorState detail={error.message} />,
  notFoundComponent: () => (
    <ErrorState title="화면을 찾을 수 없습니다" detail="요청한 운영 화면이 등록되어 있지 않습니다." />
  ),
});

const routes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: lazyPage(() => import("./pages/OverviewPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: lazyPage(() => import("./pages/LoginPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/organization",
    component: lazyPage(() => import("./pages/OrganizationPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/works/$workId",
    component: lazyPage(() => import("./pages/WorkPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/works",
    component: lazyPage(() => import("./pages/WorksPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/rooms/$roomId",
    component: lazyPage(() => import("./pages/RoomPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/approvals",
    component: lazyPage(() => import("./pages/ApprovalsPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/audit",
    component: lazyPage(() => import("./pages/AuditPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/memory",
    component: lazyPage(() => import("./pages/MemoryPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/extensions",
    component: lazyPage(() => import("./pages/ExtensionsPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/access",
    component: lazyPage(() => import("./pages/AccessPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/subscriptions",
    component: lazyPage(() => import("./pages/SubscriptionsPage.js")),
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/optimization",
    component: lazyPage(() => import("./pages/OptimizationPage.js")),
  }),
] as const;

const routeTree = rootRoute.addChildren(routes);
export const router = createRouter({ routeTree, defaultPreload: "intent", defaultPreloadStaleTime: 30_000 });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

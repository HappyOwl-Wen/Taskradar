import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Radar, RefreshCw, ServerCrash } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { AppShell, type RouteHandle } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/menu";
import { LoadingRows } from "@/components/ui/states";
import { rememberLanguage } from "@/i18n";
import { ApiError, loadSession } from "@/lib/api";
import { setTheme, useTheme } from "@/lib/theme";
import NotFoundPage, { RouteError } from "@/pages/NotFoundPage";

const DashboardPage = lazy(() => import("@/pages/DashboardPage"));
const InboxPage = lazy(() => import("@/pages/InboxPage"));
const TasksPage = lazy(() => import("@/pages/TasksPage"));
const TaskDetailPage = lazy(() => import("@/pages/TaskDetailPage"));
const SourcesPage = lazy(() => import("@/pages/SourcesPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const InsightsPage = lazy(() => import("@/pages/InsightsPage"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // Local backend: network errors mean the service is down, so retry only briefly.
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

function page(element: React.ReactNode) {
  return <Suspense fallback={<LoadingRows rows={5} className="p-4" />}>{element}</Suspense>;
}

const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: page(<DashboardPage />) },
      { path: "inbox", element: page(<InboxPage />), handle: { fullHeight: true } satisfies RouteHandle },
      { path: "tasks", element: page(<TasksPage />) },
      { path: "tasks/:id", element: page(<TaskDetailPage />) },
      { path: "sources", element: page(<SourcesPage />) },
      { path: "settings", element: page(<SettingsPage />) },
      { path: "insights", element: page(<InsightsPage />) },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <Radar className="size-8 animate-pulse text-primary" aria-label="TaskRadar" />
    </div>
  );
}

function BackendDown({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="grid min-h-dvh place-items-center p-6">
      <div className="grid max-w-md justify-items-center gap-3 text-center">
        <ServerCrash className="size-8 text-destructive" />
        <h1 className="text-lg font-semibold">{t("app.backendDown")}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("app.backendDownHint")}</p>
        <Button variant="outline" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={retrying ? "animate-spin" : undefined} /> {t("app.retry")}
        </Button>
      </div>
    </div>
  );
}

/** Loads the per-process CSRF token and the saved language/theme before rendering the app. */
function SessionGate() {
  const { i18n } = useTranslation();
  const [theme] = useTheme();
  const session = useQuery({ queryKey: ["session"], queryFn: loadSession, retry: 1, staleTime: Infinity });

  useEffect(() => {
    const s = session.data;
    if (!s) return;
    if (s.language !== i18n.language) {
      void i18n.changeLanguage(s.language);
      rememberLanguage(s.language);
    }
    if (s.theme !== theme) setTheme(s.theme);
    // Only apply the server preferences once per session load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.data]);

  if (session.isLoading) return <Splash />;
  if (session.error) return <BackendDown onRetry={() => void session.refetch()} retrying={session.isFetching} />;
  return <RouterProvider router={router} />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <SessionGate />
        <Toaster richColors closeButton position="bottom-right" toastOptions={{ className: "whitespace-pre-line" }} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

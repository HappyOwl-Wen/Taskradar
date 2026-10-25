import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Radar, RefreshCw, ServerCrash } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { TimerAlarm } from "@/components/timers/TimerAlarm";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/menu";
import { LiquidGlassEffects } from "@/components/ui/LiquidGlassEffects";
import { LiquidSelectionEffects } from "@/components/ui/LiquidSelectionEffects";
import { PopupTriggerEffects } from "@/components/ui/PopupTriggerEffects";
import { LoadingRows } from "@/components/ui/states";
import { rememberLanguage } from "@/i18n";
import { ApiError, loadSession } from "@/lib/api";
import { reportAppearance, setDesktopApp } from "@/lib/desktop";
import { setTheme, useTheme } from "@/lib/theme";
import NotFoundPage, { RouteError } from "@/pages/NotFoundPage";

const DashboardPage = lazy(() => import("@/pages/DashboardPage"));
const TasksPage = lazy(() => import("@/pages/TasksPage"));
const TaskDetailPage = lazy(() => import("@/pages/TaskDetailPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const FocusPage = lazy(() => import("@/pages/FocusPage"));
const CountdownsPage = lazy(() => import("@/pages/CountdownsPage"));
const CalendarPage = lazy(() => import("@/pages/CalendarPage"));
const TrashPage = lazy(() => import("@/pages/TrashPage"));

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
      { path: "tasks", element: page(<TasksPage />) },
      { path: "tasks/:id", element: page(<TaskDetailPage />) },
      { path: "trash", element: page(<TrashPage />) },
      { path: "focus", element: page(<FocusPage />), handle: { fullHeight: true } },
      { path: "timers", element: page(<CountdownsPage />) },
      { path: "calendar", element: page(<CalendarPage />) },
      { path: "settings", element: page(<SettingsPage />), handle: { fullHeight: true } },
      // Pages of removed features (review queue, importing, processing figures): old links land somewhere useful.
      { path: "inbox", element: <Navigate to="/tasks" replace /> },
      { path: "sources", element: <Navigate to="/" replace /> },
      { path: "insights", element: <Navigate to="/settings?section=system" replace /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

/** Keeps the desktop window's title bar and start screen in the page's colours and language. */
function DesktopSync() {
  const { i18n } = useTranslation();
  useEffect(() => {
    const root = document.documentElement;
    const send = () => reportAppearance(root.classList.contains("dark") ? "dark" : "light", i18n.language);
    send();
    const observer = new MutationObserver(send);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    i18n.on("languageChanged", send);
    return () => {
      observer.disconnect();
      i18n.off("languageChanged", send);
    };
  }, [i18n]);
  return null;
}

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center bg-frame">
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
    setDesktopApp(Boolean(s.desktop));
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
  return (
    <>
      {session.data?.desktop ? <DesktopSync /> : null}
      <RouterProvider router={router} />
      <TimerAlarm desktop={Boolean(session.data?.desktop)} />
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <LiquidGlassEffects />
        <LiquidSelectionEffects />
        <PopupTriggerEffects />
        <SessionGate />
        <Toaster
          closeButton
          position="bottom-right"
          // The app's own surfaces: a quiet panel with a coloured icon, and the action as an indigo button.
          style={
            {
              "--normal-bg": "var(--glass-menu)",
              "--normal-text": "var(--popover-foreground)",
              "--normal-border": "var(--glass-stroke)",
            } as React.CSSProperties
          }
          // Above an action bar at the bottom of the screen (see keepToastsClear), so the next decision stays reachable.
          offset={{ bottom: "calc(24px + var(--toast-clearance, 0px))" }}
          mobileOffset={{ bottom: "calc(16px + var(--toast-clearance, 0px))" }}
          toastOptions={{
            className: "glass-toast whitespace-pre-line rounded-2xl! font-sans!",
            classNames: {
              title: "font-medium! leading-snug!",
              description: "text-muted-foreground!",
              actionButton:
                "bg-primary! text-primary-foreground! h-7! rounded-md! px-2.5! text-[13px]! font-medium! transition-colors hover:bg-primary-hover!",
              cancelButton: "bg-secondary! text-secondary-foreground! h-7! rounded-md! px-2.5! text-[13px]!",
              closeButton: "bg-popover! text-muted-foreground! border-border! hover:text-foreground!",
              success: "[&_[data-icon]]:text-success",
              error: "[&_[data-icon]]:text-destructive",
              warning: "[&_[data-icon]]:text-urgent",
              info: "[&_[data-icon]]:text-primary",
            },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

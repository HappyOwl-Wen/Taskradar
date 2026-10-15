import { FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useMatches } from "react-router";
import { useTranslation } from "react-i18next";
import { useUpload } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { Sidebar } from "./Sidebar";
import { SyncWatcher } from "./SyncWatcher";
import { TopBar } from "./TopBar";

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/** Drop files anywhere on the window to import them. */
function DropOverlay() {
  const { t } = useTranslation();
  const { mutate: upload } = useUpload();
  const [visible, setVisible] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setVisible(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setVisible(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setVisible(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) upload(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [upload]);

  if (!visible) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-background/80 p-6 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary bg-card px-12 py-10 text-center shadow-xl">
        <FileUp className="size-8 text-primary" />
        <p className="text-lg font-semibold">{t("app.dropToImport")}</p>
        <p className="text-sm text-muted-foreground">{t("app.dropHint")}</p>
      </div>
    </div>
  );
}

/** Route `handle` flag for pages that manage their own scrolling (list + detail side by side). */
export interface RouteHandle {
  fullHeight?: boolean;
}

/**
 * App frame: the sidebar and top bar stay in place and the page area is the only scroll container,
 * so there is never a page scrollbar next to an inner one. Full-height pages (the review inbox) get
 * the whole area and scroll their panes themselves.
 */
export function AppShell() {
  const matches = useMatches();
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const fullHeight = matches.some((m) => (m.handle as RouteHandle | undefined)?.fullHeight);

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main
          ref={main}
          id="main"
          tabIndex={-1}
          className={cn("min-h-0 flex-1 outline-none", fullHeight ? "overflow-hidden" : "scroll-stable overflow-y-auto")}
        >
          {fullHeight ? (
            <Outlet />
          ) : (
            <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
              <Outlet />
            </div>
          )}
        </main>
      </div>
      <DropOverlay />
      <SyncWatcher />
    </div>
  );
}

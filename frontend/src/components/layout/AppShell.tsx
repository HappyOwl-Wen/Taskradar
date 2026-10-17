import { FileUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useMatches } from "react-router";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useUpload } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { AgentModeChip, Brand, Sidebar, SidebarNav } from "./Sidebar";
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
    <div className="pointer-events-none fixed inset-0 z-[60] grid animate-[tr-fade-in_var(--duration-normal)_var(--ease-out)] place-items-center bg-background/80 p-6 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-primary bg-card px-12 py-10 text-center shadow-[0_24px_64px_-12px_rgb(0_0_0/0.25)]">
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

/** The full navigation as a drawer: on phones from the top bar, on medium windows from the rail. */
function NavDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        motion="drawer"
        className="top-0 left-0 flex h-dvh max-h-dvh w-72 max-w-72 translate-x-0 translate-y-0 flex-col gap-4 rounded-none rounded-r-xl border-y-0 border-l-0 bg-frame p-3"
      >
        <DialogTitle className="sr-only">{t("nav.mainNav")}</DialogTitle>
        <div className="flex h-10 items-center px-2">
          <Brand />
        </div>
        <SidebarNav onNavigate={() => onOpenChange(false)} />
        <div className="mt-auto grid">
          <AgentModeChip />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * App frame, as in Windows 11 apps: the navigation pane and the top bar form a grey frame; the page lies on a
 * white layer with a rounded corner and is the only scroll container, so there is never a page scrollbar next to
 * an inner one. Full-height pages (the review inbox) get the whole layer and scroll their panes themselves.
 * Opening another page fades it in from slightly below.
 */
export function AppShell() {
  const matches = useMatches();
  const { pathname } = useLocation();
  const main = useRef<HTMLElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const fullHeight = matches.some((m) => (m.handle as RouteHandle | undefined)?.fullHeight);

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="flex h-dvh overflow-hidden bg-frame">
      <Sidebar onOpenDrawer={() => setDrawerOpen(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onOpenDrawer={() => setDrawerOpen(true)} />
        <main
          ref={main}
          id="main"
          tabIndex={-1}
          className={cn(
            "min-h-0 flex-1 border-t bg-background outline-none md:rounded-tl-xl md:border-l",
            fullHeight ? "overflow-hidden" : "scroll-stable overflow-y-auto",
          )}
        >
          {fullHeight ? (
            <div key={pathname} className="motion-page h-full">
              <Outlet />
            </div>
          ) : (
            <div key={pathname} className="motion-page mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 2xl:max-w-[96rem]">
              <Outlet />
            </div>
          )}
        </main>
      </div>
      <NavDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />
      <DropOverlay />
      <SyncWatcher />
    </div>
  );
}

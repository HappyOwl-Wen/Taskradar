import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useMatches } from "react-router";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useFocusView } from "@/lib/focusView";
import { cn } from "@/lib/utils";
import { Brand, SettingsNav, Sidebar, SidebarNav } from "./Sidebar";
import { TopBar } from "./TopBar";

/** Route `handle` flag for pages that manage their own scrolling. */
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
          <SettingsNav onNavigate={() => onOpenChange(false)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * App frame, as in Windows 11 apps: the navigation pane and the top bar form a grey frame; the page lies on a
 * white layer with a rounded corner and is the only scroll container, so there is never a page scrollbar next to
 * an inner one. Full-height pages get the whole layer and scroll their panes themselves.
 * Opening another page fades it in from slightly below.
 */
export function AppShell() {
  const matches = useMatches();
  const { pathname } = useLocation();
  const { compact } = useFocusView();
  const compactFocus = pathname === "/focus" && compact;
  const main = useRef<HTMLElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const fullHeight = matches.some((m) => (m.handle as RouteHandle | undefined)?.fullHeight);

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="flex h-dvh overflow-hidden bg-frame">
      <div className={compactFocus ? "hidden" : "contents"}>
        <Sidebar onOpenDrawer={() => setDrawerOpen(true)} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={compactFocus ? "hidden" : "contents"}>
          <TopBar onOpenDrawer={() => setDrawerOpen(true)} />
        </div>
        <main
          ref={main}
          id="main"
          tabIndex={-1}
          className={cn(
            "min-h-0 flex-1 bg-background outline-none",
            !compactFocus && "border-t md:rounded-tl-xl md:border-l",
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
    </div>
  );
}

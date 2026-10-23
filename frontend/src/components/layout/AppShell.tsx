import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation, useMatches } from "react-router";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useFocusView } from "@/lib/focusView";
import { cn } from "@/lib/utils";
import { Brand, SettingsNav, Sidebar, SidebarNav } from "./Sidebar";
import { TopBar } from "./TopBar";
import { AgentSidebar } from "@/components/agent/AgentSidebar";

/** Route `handle` flag for pages that manage their own scrolling. */
export interface RouteHandle {
  fullHeight?: boolean;
}

/** The full navigation as a drawer: on phones from the top bar, on medium windows from the rail. */
function NavDrawer({ open, onOpenChange, onRestoreFocus }: { open: boolean; onOpenChange: (open: boolean) => void; onRestoreFocus: () => void }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        motion="drawer"
        surface="navigation"
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus(); }}
        className="top-2 left-2 flex h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-72 max-w-[calc(100vw-1rem)] translate-x-0 translate-y-0 flex-col overflow-hidden p-0"
      >
        <DialogTitle className="sr-only">{t("nav.mainNav")}</DialogTitle>
        <div className="nav-drawer-body flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3" data-selection-scope="navigation">
          <div className="flex h-10 shrink-0 items-center px-2 pr-10">
            <Brand />
          </div>
          <SidebarNav onNavigate={() => onOpenChange(false)} />
          <div className="mt-auto grid">
            <SettingsNav onNavigate={() => onOpenChange(false)} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Floating glass surfaces share one ambient backdrop; each page keeps its own scrolling behavior. */
export function AppShell() {
  const matches = useMatches();
  const { pathname } = useLocation();
  const { hideFrame } = useFocusView();
  const compactFocus = pathname === "/focus" && hideFrame;
  const main = useRef<HTMLElement>(null);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const fullHeight = matches.some((m) => (m.handle as RouteHandle | undefined)?.fullHeight);
  const openDrawer = () => {
    drawerTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDrawerOpen(true);
  };
  const restoreDrawerFocus = () => {
    drawerTrigger.current?.focus();
    if (document.activeElement !== drawerTrigger.current) main.current?.focus();
  };

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div
      className={cn("app-shell flex h-dvh overflow-hidden", compactFocus && "app-shell-focus")}
      data-navigation-overlay={drawerOpen ? "open" : undefined}
      inert={drawerOpen || undefined}
    >
      <div className={compactFocus ? "hidden" : "contents"}>
        <Sidebar onOpenDrawer={openDrawer} />
      </div>
      <div className="app-workspace flex min-w-0 flex-1 flex-col">
        <div className={compactFocus ? "hidden" : "contents"}>
          <TopBar onOpenDrawer={openDrawer} agentOpen={agentOpen} onToggleAgent={() => setAgentOpen((value) => !value)} />
        </div>
        <main
          ref={main}
          id="main"
          tabIndex={-1}
          className={cn(
            "app-page min-h-0 flex-1 outline-none",
            fullHeight ? "overflow-hidden" : "scroll-stable overflow-y-auto",
          )}
        >
          {fullHeight ? (
            <div key={pathname} className="motion-page h-full">
              <Outlet />
            </div>
          ) : (
            <div key={pathname} className="page-content motion-page mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8 2xl:max-w-[96rem]">
              <Outlet />
            </div>
          )}
        </main>
      </div>
      <NavDrawer open={drawerOpen} onOpenChange={setDrawerOpen} onRestoreFocus={restoreDrawerFocus} />
      <AgentSidebar open={agentOpen && !compactFocus} onOpenChange={setAgentOpen} />
    </div>
  );
}

import { Check, Ellipsis, Languages, LoaderCircle, Menu, Monitor, Moon, Plus, Search, Sun, Upload } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/form";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tip,
} from "@/components/ui/menu";
import { LANGUAGES, rememberLanguage, type Language } from "@/i18n";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useTheme, type Theme } from "@/lib/theme";
import { ACCEPTED_FILES, useUpload } from "@/lib/upload";
import { TaskEditDialog } from "@/components/tasks/TaskEditDialog";
import { NotificationsMenu } from "./Notifications";
import { AgentModeChip, Brand, SidebarNav } from "./Sidebar";

const THEMES: { value: Theme; icon: typeof Sun; key: "themeSystem" | "themeLight" | "themeDark" }[] = [
  { value: "system", icon: Monitor, key: "themeSystem" },
  { value: "light", icon: Sun, key: "themeLight" },
  { value: "dark", icon: Moon, key: "themeDark" },
];

function persist(changes: { language?: Language; theme?: Theme }) {
  api.updateSettings({ general: changes }).catch((error: unknown) => toast.error(errorMessage(error)));
}

export function UploadButton({ variant = "outline", compact = true }: { variant?: "default" | "outline"; compact?: boolean }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const upload = useUpload();
  const label = upload.isPending ? t("topbar.uploading") : t("topbar.upload");
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) upload.mutate(files);
        }}
      />
      {/* The label stays the accessible name when only the icon is shown (phones). */}
      <Button variant={variant} size="sm" className="touch-target relative" onClick={() => input.current?.click()} disabled={upload.isPending} aria-label={label}>
        {upload.isPending ? <LoaderCircle className="animate-spin" /> : <Upload />}
        <span className={compact ? "hidden sm:inline" : undefined}>{label}</span>
      </Button>
    </>
  );
}

/** The user's own to-dos, available on every page. */
function NewTodoButton() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="sm" className="touch-target relative" onClick={() => setOpen(true)}>
        <Plus />
        {t("newTask.button")}
      </Button>
      <TaskEditDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function TopBar() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The task list has its own search (one search per screen); elsewhere this one searches all tasks.
  const onTasks = pathname === "/tasks";
  const [theme, setTheme] = useTheme();
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const ThemeIcon = THEMES.find((x) => x.value === theme)?.icon ?? Monitor;

  const search = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    navigate(q ? `/tasks?view=all&q=${encodeURIComponent(q)}` : "/tasks");
    setQuery("");
  };

  const changeLanguage = (lang: Language) => {
    void i18n.changeLanguage(lang);
    rememberLanguage(lang);
    persist({ language: lang });
  };

  const changeTheme = (next: Theme) => {
    setTheme(next);
    persist({ theme: next });
  };

  return (
    <header className="z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-card px-4 sm:px-6">
      <Button variant="ghost" size="icon" className="touch-target relative lg:hidden" onClick={() => setMenuOpen(true)} aria-label={t("topbar.openMenu")}>
        <Menu />
      </Button>
      <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
        <DialogContent className="top-0 left-0 h-dvh max-h-dvh w-72 max-w-72 translate-x-0 translate-y-0 content-start gap-6 rounded-none rounded-r-xl p-4">
          <DialogTitle className="sr-only">{t("nav.mainNav")}</DialogTitle>
          <Brand />
          <SidebarNav onNavigate={() => setMenuOpen(false)} />
          <AgentModeChip />
        </DialogContent>
      </Dialog>

      {onTasks ? (
        <div className="flex-1" />
      ) : (
        <>
          <form onSubmit={search} className="relative hidden max-w-md flex-1 sm:block" role="search">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("topbar.search")}
              aria-label={t("topbar.search")}
              className="h-8 bg-muted/50 pl-8"
            />
          </form>
          {/* Phones: the search lives on the task list; this opens it. */}
          <Button variant="ghost" size="icon" className="touch-target relative sm:hidden" asChild>
            <Link to="/tasks?view=all&search=1" aria-label={t("topbar.search")}>
              <Search />
            </Link>
          </Button>
          <div className="flex-1 sm:hidden" />
        </>
      )}

      <div className="ml-auto flex items-center gap-1">
        <NewTodoButton />
        <UploadButton />
        <NotificationsMenu />
        {/* Phones: theme and language are rarely changed, so they share one menu. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="touch-target relative sm:hidden" aria-label={t("topbar.more")}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t("topbar.theme")}</DropdownMenuLabel>
            {THEMES.map(({ value, icon: Icon, key }) => (
              <DropdownMenuItem key={value} onSelect={() => changeTheme(value)}>
                <Icon />
                <span className="flex-1">{t(`topbar.${key}`)}</span>
                {theme === value ? <Check className="text-foreground!" /> : null}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("topbar.language")}</DropdownMenuLabel>
            {LANGUAGES.map(({ value, label }) => (
              <DropdownMenuItem key={value} onSelect={() => changeLanguage(value)}>
                <span className="flex-1">{label}</span>
                {i18n.language === value ? <Check className="text-foreground!" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <Tip content={t("topbar.theme")}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("topbar.theme")} className="hidden sm:inline-flex">
                <ThemeIcon />
              </Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t("topbar.theme")}</DropdownMenuLabel>
            {THEMES.map(({ value, icon: Icon, key }) => (
              <DropdownMenuItem key={value} onSelect={() => changeTheme(value)}>
                <Icon />
                <span className="flex-1">{t(`topbar.${key}`)}</span>
                {theme === value ? <Check className="text-foreground!" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <Tip content={t("topbar.language")}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("topbar.language")} className="hidden sm:inline-flex">
                <Languages />
              </Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t("topbar.language")}</DropdownMenuLabel>
            {LANGUAGES.map(({ value, label }) => (
              <DropdownMenuItem key={value} onSelect={() => changeLanguage(value)}>
                <span className="flex-1">{label}</span>
                {i18n.language === value ? <Check className="text-foreground!" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

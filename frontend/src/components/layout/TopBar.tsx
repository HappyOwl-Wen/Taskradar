import { Check, Ellipsis, Menu, Monitor, Moon, Plus, Search, Sun, Upload } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
      <Button
        variant={variant}
        size={compact ? "sm" : "default"}
        className="touch-target relative"
        onClick={() => input.current?.click()}
        loading={upload.isPending}
        aria-label={label}
      >
        <Upload />
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

/** Theme and language: changed rarely, so they share one menu instead of taking two places in the bar. */
function MoreMenu() {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useTheme();

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
    <DropdownMenu>
      <Tip content={t("topbar.appearance")}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="touch-target relative" aria-label={t("topbar.more")}>
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel>{t("topbar.theme")}</DropdownMenuLabel>
        {THEMES.map(({ value, icon: Icon, key }) => (
          <DropdownMenuItem key={value} onSelect={() => changeTheme(value)}>
            <Icon />
            <span className="flex-1">{t(`topbar.${key}`)}</span>
            {theme === value ? <Check className="text-primary!" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("topbar.language")}</DropdownMenuLabel>
        {LANGUAGES.map(({ value, label }) => (
          <DropdownMenuItem key={value} onSelect={() => changeLanguage(value)}>
            <span className="flex-1">{label}</span>
            {i18n.language === value ? <Check className="text-primary!" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The bar above the page, part of the window frame: search on the left; on the right adding (a to-do or files),
 * notifications and the "more" menu. On phones its menu button opens the navigation.
 */
export function TopBar({ onOpenDrawer }: { onOpenDrawer?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // The task list has its own search (one search per screen); elsewhere this one searches all tasks.
  const onTasks = pathname === "/tasks";
  // "Add content" has importing as its own main button; a second one up here would only repeat it.
  const onSources = pathname === "/sources";
  const [query, setQuery] = useState("");

  const search = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    navigate(q ? `/tasks?view=all&q=${encodeURIComponent(q)}` : "/tasks");
    setQuery("");
  };

  return (
    <header className="z-30 flex h-12 shrink-0 items-center gap-2 bg-frame px-3 sm:px-4">
      <Button variant="ghost" size="icon" className="touch-target relative md:hidden" onClick={onOpenDrawer} aria-label={t("topbar.openMenu")}>
        <Menu />
      </Button>

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
              className="h-8 border-transparent bg-card pl-8 hover:border-border focus-visible:border-ring dark:bg-accent"
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

      <div className="ml-auto flex items-center gap-1.5">
        <NewTodoButton />
        {onSources ? null : <UploadButton />}
        <NotificationsMenu />
        <MoreMenu />
      </div>
    </header>
  );
}

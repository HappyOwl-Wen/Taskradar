import { Check, Languages, LoaderCircle, Menu, Monitor, Moon, Search, Sun, Upload } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/form";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, Tip } from "@/components/ui/menu";
import { LANGUAGES, rememberLanguage, type Language } from "@/i18n";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useTheme, type Theme } from "@/lib/theme";
import { ACCEPTED_FILES, useUpload } from "@/lib/upload";
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

export function UploadButton({ variant = "default" }: { variant?: "default" | "outline" }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const upload = useUpload();
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
      <Button variant={variant} size="sm" onClick={() => input.current?.click()} disabled={upload.isPending}>
        {upload.isPending ? <LoaderCircle className="animate-spin" /> : <Upload />}
        <span className="hidden sm:inline">{upload.isPending ? t("topbar.uploading") : t("topbar.upload")}</span>
      </Button>
    </>
  );
}

export function TopBar() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const ThemeIcon = THEMES.find((x) => x.value === theme)?.icon ?? Monitor;

  const search = (e: FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    navigate(q ? `/tasks?view=all&q=${encodeURIComponent(q)}` : "/tasks");
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
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/85 px-4 backdrop-blur sm:px-6">
      <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMenuOpen(true)} aria-label={t("topbar.openMenu")}>
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

      <form onSubmit={search} className="relative max-w-md flex-1" role="search">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("topbar.search")}
          aria-label={t("topbar.search")}
          className="h-8 bg-muted/50 pl-8"
        />
      </form>

      <div className="ml-auto flex items-center gap-1">
        <UploadButton />
        <NotificationsMenu />
        <DropdownMenu>
          <Tip content={t("topbar.theme")}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={t("topbar.theme")}>
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
              <Button variant="ghost" size="icon" aria-label={t("topbar.language")}>
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

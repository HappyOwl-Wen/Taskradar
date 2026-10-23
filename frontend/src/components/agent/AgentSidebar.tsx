import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, Bot, Check, Ellipsis, Info, Lightbulb, LoaderCircle, Pencil, Plus, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/form";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { translateKey } from "@/i18n";
import { agentApi, agentKeys, useAgentConfig, useAgentModels, type AgentConfig, type AgentHistory, type AgentTurn } from "@/lib/agent";
import { errorMessage } from "@/lib/errors";
import { useMediaQuery } from "@/lib/hooks";
import { refreshAll } from "@/lib/queries";
import { useAgentPanelWidth } from "@/lib/useAgentPanelWidth";
import { AgentChanges } from "./AgentChanges";
import { AgentControls } from "./AgentControls";
import { AgentMarkdown } from "./AgentMarkdown";
import { AgentUsage } from "./AgentUsage";

const CURRENT_CHAT = "taskradar.agent.conversation";
function rememberedChat(): string | undefined {
  try { return localStorage.getItem(CURRENT_CHAT) ?? undefined; } catch { return undefined; }
}
function working(turn: AgentTurn): boolean {
  return turn.status === "running" || turn.options?.phase === "applying" || turn.options?.phase === "finishing";
}

/** Kept outside route content: changing pages or closing the panel does not interrupt a chat. */
export function AgentSidebar({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const wide = useMediaQuery("(min-width: 1280px)");
  const panel = useAgentPanelWidth(wide);
  const config = useAgentConfig(open);
  const models = useAgentModels(config.data, open);
  const conversations = useQuery({ queryKey: agentKeys.conversations, queryFn: agentApi.conversations, enabled: open });
  const [selection, setSelection] = useState<string | null | undefined>(rememberedChat);
  const selectedExists = conversations.data?.items.some((item) => item.id === selection);
  const currentId = selection === null ? null : selectedExists ? selection! : conversations.data?.items[0]?.id ?? null;
  const history = useQuery({ queryKey: agentKeys.history(currentId), queryFn: () => agentApi.history(currentId!), enabled: open && Boolean(currentId),
    refetchInterval: (query) => query.state.data?.items.some(working) ? 2000 : false });
  const [draft, setDraft] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [manualSuggestions, setManualSuggestions] = useState<{ id: string; items: string[] } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const choose = (id: string | null) => {
    setSelection(id);
    try { if (id) localStorage.setItem(CURRENT_CHAT, id); else localStorage.removeItem(CURRENT_CHAT); } catch { /* optional preference */ }
  };
  const updateTurn = (turn: AgentTurn) => {
    queryClient.setQueryData<AgentHistory>(agentKeys.history(turn.conversation_id), (previous) => ({
      items: previous?.items.some((item) => item.id === turn.id) ? previous.items.map((item) => item.id === turn.id ? turn : item) : [...(previous?.items ?? []), turn], has_more: previous?.has_more ?? false,
    }));
  };
  const preferences = useMutation({
    mutationFn: (values: Partial<Pick<AgentConfig, "model" | "reasoning_effort" | "execution_mode" | "prompt_suggestions">>) => agentApi.preferences(values),
    onSuccess: (data) => queryClient.setQueryData(agentKeys.config, data),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const detect = useMutation({
    mutationFn: () => agentApi.models(true),
    onSuccess: (data) => queryClient.setQueryData(agentKeys.models(config.data), data),
    onError: (error) => toast.error(errorMessage(error)),
  });
  const extras = useMutation({
    mutationFn: async (values: { id: string; action: "title" | "rename" | "suggestions"; title?: string }) => {
      if (values.action === "suggestions") return { action: "suggestions" as const, id: values.id, items: (await agentApi.suggestions(values.id)).items };
      const conversation = values.action === "rename" ? await agentApi.rename(values.id, values.title!) : await agentApi.generateTitle(values.id);
      return { action: values.action, conversation };
    },
    onSuccess: (data, variables) => {
      if (data.action === "suggestions") setManualSuggestions({ id: data.id, items: data.items });
      else {
        setRenameOpen(false);
        toast.success(t(data.action === "title" ? "agent.titles.generated" : "agent.titles.renamed"));
        void queryClient.invalidateQueries({ queryKey: agentKeys.conversations });
      }
      if (variables.action !== "rename") void queryClient.invalidateQueries({ queryKey: agentKeys.history(variables.id) });
    },
    onError: (error, variables) => { toast.error(errorMessage(error)); void queryClient.invalidateQueries({ queryKey: agentKeys.history(variables.id) }); },
  });
  const send = useMutation({
    mutationFn: async ({ text, requestId, conversationId }: { text: string; requestId: string; conversationId: string | null }) => {
      let id = conversationId;
      if (!id) {
        const conversation = await agentApi.newConversation();
        id = conversation.id;
        queryClient.setQueryData<{ items: typeof conversation[] }>(agentKeys.conversations, (previous) => ({ items: [conversation, ...(previous?.items ?? [])] }));
        choose(id);
      }
      return agentApi.chat(id, text, requestId);
    },
    onSuccess: (turn) => {
      updateTurn(turn);
      void queryClient.invalidateQueries({ queryKey: agentKeys.conversations });
      if (turn.changes.some((item) => item.status === "applied" || item.status === "error")) void refreshAll(queryClient);
      if (turn.options?.title_error) toast.warning(t("agent.titles.failed"));
    },
    onError: (error, variables) => { setDraft(variables.text); toast.error(errorMessage(error)); },
  });
  const change = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "apply" | "discard" }) => action === "apply" ? agentApi.apply(id) : agentApi.discard(id),
    onSuccess: (turn, variables) => {
      updateTurn(turn);
      if (variables.action === "apply" && turn.changes.every((item) => item.status !== "error")) toast.success(t("agent.appliedToast"));
      void refreshAll(queryClient);
    },
    onError: (error) => { toast.error(errorMessage(error)); void refreshAll(queryClient); },
  });
  const remove = useMutation({
    mutationFn: () => agentApi.deleteConversation(currentId!),
    onSuccess: () => { setDeleteOpen(false); choose(null); void queryClient.invalidateQueries({ queryKey: agentKeys.conversations }); },
    onError: (error) => toast.error(errorMessage(error)),
  });
  const serverRunning = history.data?.items.some(working) ?? false;
  const busy = send.isPending || change.isPending || remove.isPending || preferences.isPending || extras.isPending || serverRunning;
  const ready = Boolean(config.data?.configured);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || busy || !ready || history.isError) return;
    setDraft("");
    setManualSuggestions(null);
    send.mutate({ text, requestId: crypto.randomUUID(), conversationId: currentId });
  };

  useEffect(() => {
    if (open) bottom.current?.scrollIntoView?.({ block: "end", behavior: "smooth" });
  }, [open, history.data, send.isPending]);

  const currentConversation = conversations.data?.items.find((item) => item.id === currentId);
  const lastTurn = history.data?.items.filter((turn) => turn.status === "completed").at(-1);
  const modelSuggestions = manualSuggestions?.id === currentId ? manualSuggestions.items : lastTurn?.options?.suggestions ?? [];
  const suggestionMode = config.data?.prompt_suggestions ?? "presets";
  const suggested = suggestionMode === "model" ? modelSuggestions : [t("agent.prompts.plan"), t("agent.prompts.summary"), t("agent.prompts.chat")].filter((_, index) => config.data?.workspace_access || index > 0);
  const ongoing = history.data?.items.find(working)?.options?.phase;
  const handle = <div role="separator" tabIndex={0} aria-label={t("agent.resize")} title={t("agent.resizeHint")}
    aria-orientation="vertical" aria-valuemin={panel.minimum} aria-valuemax={panel.maximum} aria-valuenow={panel.width} aria-controls="agent-panel"
    className="absolute top-0 bottom-0 left-0 z-10 w-2 cursor-col-resize touch-none border-l-2 border-transparent outline-none transition-colors hover:border-primary/60 focus-visible:border-primary active:border-primary after:absolute after:top-1/2 after:left-0 after:h-8 after:w-1 after:-translate-y-1/2 after:rounded-full after:bg-border hover:after:bg-primary/60 focus-visible:after:bg-primary"
    {...panel.handle} />;

  const promptOptions = <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={t("agent.prompts.options")} title={t("agent.prompts.options")} disabled={busy || !config.data}><Lightbulb className="size-3.5" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="start">{(["off", "presets", "model"] as const).map((mode) => <DropdownMenuItem key={mode} onSelect={() => preferences.mutate({ prompt_suggestions: mode })}><span className="flex-1">{t(`agent.preferences.${mode === "off" ? "suggestionsOff" : mode === "presets" ? "suggestionsPresets" : "suggestionsModel"}`)}</span>{suggestionMode === mode ? <Check /> : null}</DropdownMenuItem>)}</DropdownMenuContent>
  </DropdownMenu>;

  const body = <div className="flex h-full min-h-0 min-w-0 flex-col bg-card">
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary"><Bot className="size-[18px]" /></span>
      <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{t("agent.title")}</h2><p className="truncate text-[11px] text-muted-foreground">{t("agent.subtitle")}</p></div>
      <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t("agent.settings")} asChild><Link to="/settings?section=agent" onClick={() => { if (!wide) onOpenChange(false); }}><Settings2 className="size-4" /></Link></Button>
      <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t("agent.close")} onClick={() => onOpenChange(false)}><X className="size-4" /></Button>
    </header>
    <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-2">
      <select aria-label={t("agent.history")} className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring" value={currentId ?? ""} disabled={busy}
        onChange={(e) => { choose(e.target.value || null); setDraft(""); }}>
        <option value="">{t("agent.untitled")}</option>
        {conversations.data?.items.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title || t("agent.untitled")}</option>)}
      </select>
      <Button variant="ghost" size="icon" className="size-8" aria-label={t("agent.newChat")} disabled={busy} onClick={() => { choose(null); setDraft(""); input.current?.focus(); }}><Plus className="size-4" /></Button>
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={t("agent.titles.menu")} disabled={busy || !currentId}><Ellipsis className="size-4" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => { setTitleDraft(currentConversation?.title ?? ""); setRenameOpen(true); }}><Pencil />{t("agent.titles.rename")}</DropdownMenuItem>
          <DropdownMenuItem disabled={!ready || !history.data?.items.length} onSelect={() => extras.mutate({ id: currentId!, action: "title" })}><Sparkles />{t("agent.titles.generate")}</DropdownMenuItem>
          <DropdownMenuLabel className="max-w-64 truncate text-[10px]">{t("agent.titles.using", { model: config.data?.title_model || config.data?.model })}</DropdownMenuLabel>
          <DropdownMenuSeparator /><DropdownMenuItem onSelect={() => setDeleteOpen(true)}><Trash2 />{t("agent.deleteChat")}</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4" aria-label={t("agent.history")}>
      {config.isLoading || conversations.isLoading || (currentId && history.isLoading) ? <LoadingRows rows={3} /> : null}
      {config.error || conversations.error || history.error ? <ErrorState error={config.error ?? conversations.error ?? history.error} onRetry={() => { void config.refetch(); void conversations.refetch(); if (currentId) void history.refetch(); }} /> : null}
      {config.data && !ready ? <div className="my-6 grid justify-items-start gap-3 rounded-xl bg-subtle p-4"><Bot className="size-7 text-primary" /><h3 className="font-semibold">{t("agent.setup")}</h3><p className="text-sm leading-relaxed text-muted-foreground">{t("agent.setupHint")}</p><Button size="sm" asChild><Link to="/settings?section=agent" onClick={() => { if (!wide) onOpenChange(false); }}>{t("agent.configure")}</Link></Button></div> : null}
      {ready && !history.isLoading && !(history.data?.items.length && currentId) && !send.isPending ? <div className="grid gap-3 py-6">
        <Bot className="size-9 text-primary" /><h3 className="font-semibold">{t("agent.welcome")}</h3><p className="text-sm leading-relaxed text-muted-foreground">{t("agent.welcomeHint")}</p>
        {suggestionMode !== "off" ? <div className="mt-2 grid gap-2">{(["examplePlan", "exampleTask", "exampleChat"] as const).filter((key) => config.data?.workspace_access || key === "exampleChat").map((key) => <button key={key} type="button" className="rounded-lg border p-3 text-left text-xs leading-relaxed transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { setDraft(t(`agent.${key}`)); input.current?.focus(); }}>{t(`agent.${key}`)}</button>)}</div> : null}
      </div> : null}
      <div className="grid gap-5" role="log" aria-live="polite" aria-relevant="additions text">
        {currentId ? history.data?.items.map((turn) => <div key={turn.id} className="grid min-w-0 gap-3">
          <p className="ml-6 whitespace-pre-wrap rounded-xl rounded-tr-sm bg-primary/10 px-3 py-2.5 text-sm leading-relaxed break-words">{turn.user_text}</p>
          {turn.assistant_text ? <><p className="text-[10px] text-muted-foreground">{turn.model}{turn.options?.reasoning_effort ? ` · ${t(`agent.controls.${turn.options.reasoning_effort}`)}` : ""}{turn.options?.execution_mode ? ` · ${t(`agent.controls.${turn.options.execution_mode}`)}` : ""}</p><AgentMarkdown>{turn.assistant_text}</AgentMarkdown></> : null}
          {turn.error ? <div role="alert" className="rounded-lg bg-destructive/6 p-3 text-xs leading-relaxed text-destructive">{translateKey(`agent.errors.${turn.error}`, turn.error)}<Button variant="ghost" size="sm" className="mt-1 h-auto px-0 text-xs" disabled={busy} onClick={() => { setDraft(turn.user_text); input.current?.focus(); }}>{t("agent.retryMessage")}</Button></div> : null}
          {turn.changes.length ? <AgentChanges turn={turn} busy={busy} applying={change.isPending && change.variables.id === turn.id && change.variables.action === "apply"}
            onApply={() => change.mutate({ id: turn.id, action: "apply" })} onDiscard={() => change.mutate({ id: turn.id, action: "discard" })} /> : null}
          {turn.options?.suggestions_error ? <p className="text-xs text-muted-foreground">{t("agent.prompts.failed")}</p> : null}
          <AgentUsage turn={turn} />
        </div>) : null}
        {send.isPending && !history.data?.items.some((turn) => turn.id === send.variables.requestId) ? <p className="ml-6 whitespace-pre-wrap rounded-xl rounded-tr-sm bg-primary/10 px-3 py-2.5 text-sm leading-relaxed break-words">{send.variables.text}</p> : null}
        {send.isPending || serverRunning ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t(ongoing === "applying" ? "agent.controls.phaseApplying" : ongoing === "finishing" ? "agent.controls.phaseFinishing" : "agent.thinking")}</p> : null}
        {send.error ? <p role="alert" className="text-xs text-destructive">{errorMessage(send.error)}</p> : null}
        {history.data?.has_more ? <p className="text-xs text-muted-foreground">{t("agent.historyLimit")}</p> : null}
      </div>
      {lastTurn && suggestionMode !== "off" ? <section aria-label={t("agent.prompts.label")} className="mt-4 grid gap-2">
        <p className="text-[10px] text-muted-foreground">{t("agent.prompts.label")}</p>
        {suggested.map((text) => <button key={text} type="button" disabled={busy} aria-label={t("agent.prompts.applySuggestion", { text })}
          className="rounded-lg border px-3 py-2 text-left text-xs leading-relaxed hover:bg-accent disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => { setDraft(text); input.current?.focus(); }}>{text}</button>)}
        {suggestionMode === "model" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => extras.mutate({ id: currentId!, action: "suggestions" })}><Sparkles />{t("agent.prompts.generate")}</Button> : null}
      </section> : null}
      <div ref={bottom} />
    </div>
    <footer className="grid shrink-0 gap-1 border-t px-3 pt-3 pb-2">
      <form onSubmit={submit} className="min-w-0 rounded-2xl border bg-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
        <Textarea ref={input} aria-label={t("agent.inputLabel")} placeholder={t("agent.placeholder")} value={draft} onChange={(e) => setDraft(e.target.value)}
          maxLength={8000} rows={2} className="max-h-48 min-h-20 resize-y border-0 bg-transparent shadow-none! focus-visible:ring-0" disabled={!ready || busy}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); submit(); } }} />
        <div role="toolbar" aria-label={t("agent.controls.composerTools")} className="flex min-w-0 items-center gap-1 px-2 pb-2">
          {config.data ? <AgentControls config={config.data} catalog={models.data} error={models.error} scanning={models.isFetching} refreshing={detect.isPending} busy={busy || !ready}
            onRefresh={() => detect.mutate()} onChange={(values) => preferences.mutate(values)}>{promptOptions}</AgentControls> : <div className="min-w-0 flex-1">{promptOptions}</div>}
          <Button type="submit" size="icon" className="size-8 rounded-full" aria-label={t("agent.send")} disabled={!draft.trim() || !ready || busy || history.isError}><ArrowUp className="size-4" /></Button>
        </div>
      </form>
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <p>{t("agent.enterHint")}</p>
        <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon" className="size-6 text-muted-foreground" aria-label={t("agent.controls.privacyInfo")} title={t("agent.controls.privacyInfo")}><Info className="size-3" /></Button></PopoverTrigger>
          <PopoverContent side="top" aria-label={t("agent.controls.privacyInfo")} className="w-72 max-w-[calc(100vw-2rem)] p-3 text-xs leading-relaxed"><p>{t("agent.privacy")}</p></PopoverContent>
        </Popover>
      </div>
    </footer>
  </div>;

  return <>
    {wide ? open ? <aside id="agent-panel" aria-label={t("agent.title")} style={{ width: panel.width }} className="relative shrink-0 overflow-hidden border-l">{handle}{body}</aside> : null : <Dialog open={open} onOpenChange={onOpenChange}><DialogContent showClose={false} motion="drawer" aria-describedby={undefined} style={{ width: panel.width }}
      className="top-0 right-0 left-auto flex h-dvh max-h-dvh max-w-full translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-y-0 border-r-0 p-0 sm:max-w-none">
      <DialogTitle className="sr-only">{t("agent.title")}</DialogTitle>{handle}<div id="agent-panel" className="h-full min-h-0 w-full">{body}</div>
    </DialogContent></Dialog>}
    <ConfirmDialog open={deleteOpen} onOpenChange={setDeleteOpen} title={t("agent.deleteTitle")} description={t("agent.deleteHint")}
      confirmLabel={t("agent.deleteChat")} cancelLabel={t("common.cancel")} onConfirm={() => remove.mutate()} pending={remove.isPending} destructive />
    <Dialog open={renameOpen} onOpenChange={setRenameOpen}><DialogContent>
      <DialogTitle>{t("agent.titles.rename")}</DialogTitle><DialogDescription>{t("agent.titles.using", { model: config.data?.title_model || config.data?.model })}</DialogDescription>
      <Field label={t("agent.titles.title")} htmlFor="agent-chat-title"><Input id="agent-chat-title" value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} maxLength={100} /></Field>
      <Button disabled={!titleDraft.trim() || extras.isPending} loading={extras.isPending} onClick={() => extras.mutate({ id: currentId!, action: "rename", title: titleDraft.trim() })}>{t("agent.titles.save")}</Button>
    </DialogContent></Dialog>
  </>;
}

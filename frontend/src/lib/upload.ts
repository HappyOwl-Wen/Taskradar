import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { translateKey } from "@/i18n";
import { api } from "./api";
import { errorMessage } from "./errors";
import { refreshAll } from "./queries";
import type { ImportResult } from "./types";

const BATCH = 20; // backend limit per request
const STORAGE_KEY = "taskradar.lastImport";

export const ACCEPTED_FILES = ".pdf,.png,.jpg,.jpeg,.webp,.eml,application/pdf,image/png,image/jpeg,image/webp,message/rfc822";

/** The most recent import, kept for this browser tab so its result stays reachable after the toast. */
export interface LastImport {
  at: string;
  results: ImportResult[];
}

function readStored(): LastImport | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as LastImport) : null;
  } catch {
    return null;
  }
}

let lastImport: LastImport | null = typeof window === "undefined" ? null : readStored();
const listeners = new Set<() => void>();

function setLastImport(value: LastImport | null) {
  lastImport = value;
  try {
    if (value) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage may be unavailable; the result then lives until the page is reloaded.
  }
  listeners.forEach((listener) => listener());
}

export function useLastImport(): [LastImport | null, () => void] {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => lastImport,
  );
  return [value, () => setLastImport(null)];
}

/** Remember what an import produced, so the result stays reachable after the toast. */
export function recordImport(results: ImportResult[]) {
  setLastImport({ at: new Date().toISOString(), results });
}

/** One file of the last import was processed again: show its new result in place of the old one. */
export function replaceImportResult(index: number, result: ImportResult) {
  if (!lastImport) return;
  setLastImport({ ...lastImport, results: lastImport.results.map((r, i) => (i === index ? result : r)) });
}

export function importTotals(results: ImportResult[]) {
  const sum = (key: "tasks_created" | "duplicates_merged" | "suggestions_created" | "tasks_updated") => results.reduce((n, r) => n + (r[key] ?? 0), 0);
  return {
    created: sum("tasks_created"),
    merged: sum("duplicates_merged"),
    suggestions: sum("suggestions_created"),
    updated: sum("tasks_updated"),
    failed: results.filter((r) => r.status === "failed").length,
  };
}

/** Upload files (in batches) and say what came of them, with the way to the tasks that were found. */
export function useUpload() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const upload = useMutation({
    mutationFn: async (files: File[]): Promise<ImportResult[]> => {
      const results: ImportResult[] = [];
      for (let i = 0; i < files.length; i += BATCH) {
        const response = await api.upload(files.slice(i, i + BATCH));
        results.push(...response.results);
      }
      return results;
    },
    onMutate: (files) => {
      // Scans and screenshots need text recognition, which can take a few seconds per page.
      toast.loading(t("upload.working", { count: files.length }), { id: "upload", description: t("upload.workingHint") });
    },
    onSuccess: (results) => {
      recordImport(results);
      const totals = importTotals(results);
      const failed = results.filter((r) => r.status === "failed");
      const lines = [
        totals.created + totals.suggestions > 0 ? t("upload.found", { count: totals.created + totals.suggestions }) : t("upload.nothingFound"),
        ...failed.map((r) =>
          t("upload.failedFile", {
            name: r.filename,
            error: translateKey(`errors.${r.error_code ?? "parse_failed"}`, r.error_message ?? r.error_code ?? ""),
          }),
        ),
      ];
      const notify = failed.length === results.length ? toast.error : failed.length ? toast.warning : toast.success;
      notify(t("upload.result", { count: results.length }), {
        id: "upload",
        description: lines.join("\n"),
        duration: 10000,
        action:
          totals.created + totals.suggestions > 0
            ? { label: t("upload.review"), onClick: () => navigate("/inbox") }
            : { label: t("upload.details"), onClick: () => navigate("/sources") },
      });
    },
    onError: (error, files) => {
      // The request itself failed (connection, server): the same files can be sent again.
      toast.error(errorMessage(error), { id: "upload", action: { label: t("common.retry"), onClick: () => upload.mutate(files) } });
    },
    onSettled: () => {
      void refreshAll(queryClient);
    },
  });
  return upload;
}

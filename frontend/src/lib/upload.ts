import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { translateKey } from "@/i18n";
import { api } from "./api";
import { errorMessage } from "./errors";
import { refreshAll } from "./queries";
import type { ImportResult } from "./types";

const BATCH = 20; // backend limit per request

export const ACCEPTED_FILES = ".pdf,.png,.jpg,.jpeg,.webp,.eml,application/pdf,image/png,image/jpeg,image/webp,message/rfc822";

/** Upload files (in batches) and summarise what the agent did with them. */
export function useUpload() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (files: File[]): Promise<ImportResult[]> => {
      const results: ImportResult[] = [];
      for (let i = 0; i < files.length; i += BATCH) {
        const response = await api.upload(files.slice(i, i + BATCH));
        results.push(...response.results);
      }
      return results;
    },
    onSuccess: (results) => {
      const failed = results.filter((r) => r.status === "failed");
      const sum = (key: "tasks_created" | "duplicates_merged" | "suggestions_created") =>
        results.reduce((n, r) => n + (r[key] ?? 0), 0);
      const lines = [
        t("upload.summary", {
          created: sum("tasks_created"),
          merged: sum("duplicates_merged"),
          suggestions: sum("suggestions_created"),
          failed: failed.length,
        }),
        ...results
          .filter((r) => r.status !== "processed" && r.status !== "failed")
          .map((r) => `${r.filename}: ${translateKey(`importStatus.${r.status}`, r.status)}`),
        ...failed.map((r) =>
          t("upload.failedFile", {
            name: r.filename,
            error: translateKey(`errors.${r.error_code ?? "parse_failed"}`, r.error_message ?? r.error_code ?? ""),
          }),
        ),
      ];
      const notify = failed.length === results.length ? toast.error : failed.length ? toast.warning : toast.success;
      notify(t("upload.result", { count: results.length }), { description: lines.join("\n"), duration: 8000 });
    },
    onError: (error) => {
      toast.error(errorMessage(error));
    },
    onSettled: () => {
      void refreshAll(queryClient);
    },
  });
}

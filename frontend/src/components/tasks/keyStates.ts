import { CalendarClock, CalendarX2, CircleDashed, FlaskConical, type LucideIcon } from "lucide-react";
import type { TFunction } from "i18next";
import type { BadgeTone } from "@/components/ui/variants";
import type { Issue, IssueKind } from "@/lib/review";
import { ISSUE_ICON } from "./meta";

/** Problems that can change what the task is or when it is due are orange; doubts about quality stay neutral. */
export const ISSUE_TONE: Record<IssueKind, BadgeTone> = {
  date_conflict: "urgent",
  date_changed: "urgent",
  duplicate: "urgent",
  date_unclear: "urgent",
  content_unclear: "urgent",
  suspicious: "destructive",
  not_in_source: "urgent",
  marketing: "normal",
  optional: "normal",
  ocr_quality: "normal",
  low_certainty: "normal",
  split: "normal",
};

/** A short state shown in lists ("待确认", "截止日期冲突", "测试数据"); at most two are shown per row. */
export interface KeyState {
  key: string;
  tone: BadgeTone;
  label: string;
  icon?: LucideIcon;
  hint?: string;
}

export function issueStates(issues: Issue[], t: TFunction): KeyState[] {
  return issues.map((issue) => ({
    key: `issue:${issue.kind}`,
    tone: ISSUE_TONE[issue.kind],
    label: t(`issue.${issue.kind}.label`),
    icon: ISSUE_ICON[issue.kind],
    hint: t(`issue.${issue.kind}.hint`),
  }));
}

export function unconfirmedState(t: TFunction): KeyState {
  return { key: "unconfirmed", tone: "violet", label: t("status.candidate"), icon: CircleDashed, hint: t("taskItem.unconfirmedHint") };
}

export function sampleState(t: TFunction): KeyState {
  return { key: "sample", tone: "outline", label: t("sample.badge"), icon: FlaskConical, hint: t("sample.hint") };
}

export function conflictState(t: TFunction): KeyState {
  return { key: "conflict", tone: "urgent", label: t("issue.date_conflict.label"), icon: CalendarX2, hint: t("issue.date_conflict.hint") };
}

export function dateChangedState(t: TFunction): KeyState {
  return { key: "date_changed", tone: "urgent", label: t("issue.date_changed.label"), icon: CalendarClock, hint: t("issue.date_changed.hint") };
}

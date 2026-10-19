import { CalendarClock, CalendarX, CircleDashed, FlaskConical, type LucideIcon } from "lucide-react";
import type { TFunction } from "i18next";
import type { BadgeTone } from "@/components/ui/variants";
import type { TaskStatus } from "@/lib/types";
import { STATUS_ICON, STATUS_TONE } from "./meta";

/** A short state shown in lists ("进行中", "等待回复", "测试数据"); at most two are shown per row. */
export interface KeyState {
  key: string;
  tone: BadgeTone;
  label: string;
  icon?: LucideIcon;
  hint?: string;
}

/**
 * Where an open task stands, when that is more than "to do": being worked on, or waiting for someone else.
 * Shown in every list, so a status change is visible wherever the task appears.
 */
export function statusState(status: TaskStatus, t: TFunction): KeyState | null {
  if (status !== "in_progress" && status !== "waiting_for_reply") return null;
  return { key: `status:${status}`, tone: STATUS_TONE[status], label: t(`status.${status}`), icon: STATUS_ICON[status] };
}

export function unconfirmedState(t: TFunction): KeyState {
  return { key: "unconfirmed", tone: "tentative", label: t("status.candidate"), icon: CircleDashed, hint: t("taskItem.unconfirmedHint") };
}

export function sampleState(t: TFunction): KeyState {
  return { key: "sample", tone: "outline", label: t("sample.badge"), icon: FlaskConical, hint: t("sample.hint") };
}

/** A calendar event that needs the user (out of date or not written); a synced event is not a state. */
export function calendarState(status: string | null, t: TFunction): KeyState | null {
  if (status === "out_of_sync") {
    return { key: "calendar", tone: "urgent", label: t("taskItem.calendar.out_of_sync"), icon: CalendarClock, hint: t("taskItem.calendarHint.out_of_sync") };
  }
  if (status === "failed") {
    return { key: "calendar", tone: "destructive", label: t("taskItem.calendar.failed"), icon: CalendarX, hint: t("taskItem.calendarHint.failed") };
  }
  return null;
}

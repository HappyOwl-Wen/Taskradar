import {
  Ban,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  FlaskConical,
  Folder,
  GraduationCap,
  Hourglass,
  Landmark,
  Mail,
  PenLine,
  Plane,
  Tag,
  Upload,
  User,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { BadgeTone } from "@/components/ui/variants";
import type { Category, TaskStatus, Urgency } from "@/lib/types";

export const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  candidate: CircleDashed,
  confirmed: Circle,
  in_progress: CircleDot,
  waiting_for_reply: Hourglass,
  completed: CircleCheck,
  dismissed: Ban,
};

// Red for overdue, orange for "very soon"; a week ahead or later stays neutral.
export const URGENCY_TONE: Record<Urgency, BadgeTone> = {
  overdue: "overdue",
  urgent: "urgent",
  high: "urgent",
  upcoming: "normal",
  normal: "normal",
  no_deadline: "outline",
  inactive: "normal",
};

export const URGENCY_TEXT: Record<Urgency, string> = {
  overdue: "text-overdue",
  urgent: "text-urgent",
  high: "text-urgent",
  upcoming: "text-upcoming",
  normal: "text-muted-foreground",
  no_deadline: "text-muted-foreground",
  inactive: "text-muted-foreground",
};

export const CATEGORY_ICON: Record<Category, LucideIcon> = {
  academic: GraduationCap,
  administrative: Landmark,
  financial: Wallet,
  travel: Plane,
  personal: User,
  other: Tag,
};

export const SOURCE_ICON: Record<string, LucideIcon> = {
  gmail: Mail,
  demo_mail: FlaskConical,
  sample_upload: FlaskConical,
  upload: Upload,
  folder: Folder,
  manual: PenLine,
};

/**
 * One look per lifecycle status, used everywhere a status is shown: unconfirmed is tentative (neutral, dashed),
 * to do is neutral, being worked on blue, waiting for someone else amber, done green, dismissed grey.
 */
export const STATUS_TONE: Record<TaskStatus, BadgeTone> = {
  candidate: "tentative",
  confirmed: "neutral",
  in_progress: "progress",
  waiting_for_reply: "waiting",
  completed: "success",
  dismissed: "normal",
};

/** Text colour per status (status icons in lists and menus). */
export const STATUS_TEXT: Record<TaskStatus, string> = {
  candidate: "text-tentative",
  confirmed: "text-muted-foreground",
  in_progress: "text-progress",
  waiting_for_reply: "text-waiting",
  completed: "text-success",
  dismissed: "text-muted-foreground",
};

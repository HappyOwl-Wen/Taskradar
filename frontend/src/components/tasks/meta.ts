import {
  Ban,
  CalendarClock,
  CalendarX2,
  Circle,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleHelp,
  Copy,
  FileQuestion,
  FlaskConical,
  Folder,
  GraduationCap,
  HandHelping,
  Hourglass,
  Landmark,
  Mail,
  Megaphone,
  PenLine,
  Plane,
  ScanText,
  ShieldAlert,
  Split,
  Tag,
  TriangleAlert,
  Upload,
  User,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { BadgeTone } from "@/components/ui/variants";
import type { IssueKind } from "@/lib/review";
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
 * One colour per lifecycle status, used everywhere a status is shown: unconfirmed violet, the user's own
 * open work brand blue, done green; waiting and dismissed are neutral (nothing to do right now).
 */
export const STATUS_TONE: Record<TaskStatus, BadgeTone> = {
  candidate: "violet",
  confirmed: "primary",
  in_progress: "primary",
  waiting_for_reply: "normal",
  completed: "success",
  dismissed: "normal",
};

export const ISSUE_ICON: Record<IssueKind, LucideIcon> = {
  date_conflict: CalendarX2,
  date_changed: CalendarClock,
  duplicate: Copy,
  date_unclear: CircleHelp,
  content_unclear: FileQuestion,
  suspicious: ShieldAlert,
  not_in_source: ScanText,
  marketing: Megaphone,
  optional: HandHelping,
  ocr_quality: ScanText,
  low_certainty: TriangleAlert,
  split: Split,
};

/** Text colour per status (status icons in lists and menus). */
export const STATUS_TEXT: Record<TaskStatus, string> = {
  candidate: "text-violet",
  confirmed: "text-primary",
  in_progress: "text-primary",
  waiting_for_reply: "text-muted-foreground",
  completed: "text-success",
  dismissed: "text-muted-foreground",
};

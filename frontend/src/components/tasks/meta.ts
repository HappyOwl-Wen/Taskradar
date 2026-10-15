import {
  Ban,
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

export const URGENCY_TONE: Record<Urgency, BadgeTone> = {
  overdue: "overdue",
  urgent: "urgent",
  high: "high",
  upcoming: "upcoming",
  normal: "normal",
  no_deadline: "outline",
  inactive: "normal",
};

export const URGENCY_TEXT: Record<Urgency, string> = {
  overdue: "text-overdue",
  urgent: "text-urgent",
  high: "text-high",
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
  upload: Upload,
  folder: Folder,
  manual: PenLine,
};

/** One colour per lifecycle status, used everywhere a status is shown. */
export const STATUS_TONE: Record<TaskStatus, BadgeTone> = {
  candidate: "violet",
  confirmed: "primary",
  in_progress: "upcoming",
  waiting_for_reply: "high",
  completed: "success",
  dismissed: "normal",
};

export const ISSUE_ICON: Record<IssueKind, LucideIcon> = {
  date_conflict: CalendarX2,
  duplicate: Copy,
  date_unclear: CircleHelp,
  content_unclear: FileQuestion,
  suspicious: ShieldAlert,
  not_in_source: ScanText,
  marketing: Megaphone,
  ocr_quality: ScanText,
  low_certainty: TriangleAlert,
  split: Split,
};

/** Text colour per status (status icons in lists and menus). */
export const STATUS_TEXT: Record<TaskStatus, string> = {
  candidate: "text-violet",
  confirmed: "text-primary",
  in_progress: "text-upcoming",
  waiting_for_reply: "text-high",
  completed: "text-success",
  dismissed: "text-muted-foreground",
};

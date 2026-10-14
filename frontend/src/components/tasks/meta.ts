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

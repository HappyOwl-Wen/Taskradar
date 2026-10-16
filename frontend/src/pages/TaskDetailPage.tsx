import { ArrowLeft } from "lucide-react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { TaskDetailView } from "@/components/tasks/TaskDetailView";
import { Button } from "@/components/ui/button";

export default function TaskDetailPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  // Opened from "view" right after adding it: marked for a moment.
  const justAdded = Boolean((useLocation().state as { justAdded?: boolean } | null)?.justAdded);
  return (
    <div className="grid gap-4">
      <Button
        variant="ghost"
        size="sm"
        className="w-fit"
        onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/tasks"))}
      >
        <ArrowLeft /> {t("detail.back")}
      </Button>
      <div className={justAdded ? "-m-2 rounded-xl p-2 motion-safe:animate-[just-added_1.6s_ease-out]" : undefined}>
        <TaskDetailView key={id} taskId={id} />
      </div>
    </div>
  );
}

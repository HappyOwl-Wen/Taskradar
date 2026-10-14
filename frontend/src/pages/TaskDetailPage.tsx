import { ArrowLeft } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { TaskDetailView } from "@/components/tasks/TaskDetailView";
import { Button } from "@/components/ui/button";

export default function TaskDetailPage() {
  const { t } = useTranslation();
  const { id = "" } = useParams();
  const navigate = useNavigate();
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
      <TaskDetailView key={id} taskId={id} />
    </div>
  );
}

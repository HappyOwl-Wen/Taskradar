import { CircleAlert, SearchX } from "lucide-react";
import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";

export default function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={SearchX}
      title={t("app.notFound")}
      description={t("app.notFoundHint")}
      action={
        <Button variant="outline" size="sm" asChild>
          <Link to="/">{t("app.goHome")}</Link>
        </Button>
      }
    />
  );
}

/** Route-level error boundary: a rendering bug on one page must not blank the whole app. */
export function RouteError() {
  const { t } = useTranslation();
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : String(error);
  return (
    <div className="mx-auto grid max-w-xl gap-4 p-8">
      <EmptyState
        icon={CircleAlert}
        title={t("app.crashed")}
        description={message}
        action={
          <Button variant="outline" size="sm" onClick={() => window.location.assign("/")}>
            {t("app.goHome")}
          </Button>
        }
      />
    </div>
  );
}

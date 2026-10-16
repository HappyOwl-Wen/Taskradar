import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { UploadButton } from "@/components/layout/TopBar";
import { LastImportCard } from "@/components/sources/LastImport";
import { OcrBacklogNotice } from "@/components/sources/OcrBacklogNotice";
import { ProcessingRecords } from "@/components/sources/ProcessingRecords";
import { AddFolderForm, AddSourceMenu, DemoRow, FolderRows, GmailRow, SampleRow, UploadsRow } from "@/components/sources/SourceCards";
import { ErrorState, LoadingRows } from "@/components/ui/states";
import { useTimezone } from "@/lib/hooks";
import { useSources } from "@/lib/queries";

function SectionTitle({ id, title, hint, aside }: { id?: string; title: string; hint?: string; aside?: React.ReactNode }) {
  return (
    <div id={id} className="flex scroll-mt-4 flex-wrap items-end justify-between gap-2">
      <div className="grid gap-0.5">
        <h2 className="text-section font-semibold">{title}</h2>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {aside}
    </div>
  );
}

export default function SourcesPage() {
  const { t } = useTranslation();
  const timezone = useTimezone();
  const location = useLocation();
  const navigate = useNavigate();
  const { data, error, isLoading, refetch } = useSources();
  const [addingFolder, setAddingFolder] = useState(false);
  // "/sources#folders" (e.g. from the onboarding) opens the form directly.
  const adding = addingFolder || location.hash === "#folders";
  const closeForm = () => {
    setAddingFolder(false);
    if (location.hash === "#folders") navigate({ hash: "" }, { replace: true });
  };

  useEffect(() => {
    if (!location.hash || isLoading) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [location.hash, isLoading, adding]);

  const sources = data?.items ?? [];
  const demo = sources.find((s) => s.kind === "demo_mail");
  const uploads = sources.find((s) => s.kind === "upload");
  const testData = sources.find((s) => s.kind === "sample_upload");
  return (
    <div className="grid gap-6">
      {/* Adding something is what this page is for: importing is its main action. */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 flex-1 basis-72 gap-0.5">
          <h1 className="text-page font-semibold">{t("sources.title")}</h1>
          <p className="text-[13px] text-muted-foreground">{t("sources.description")}</p>
        </div>
        <UploadButton variant="default" compact={false} />
      </header>

      <LastImportCard />

      <section className="grid gap-2">
        <SectionTitle title={t("sources.connected")} aside={data ? <AddSourceMenu sources={sources} onAddFolder={() => setAddingFolder(true)} /> : null} />
        {isLoading ? <LoadingRows rows={3} /> : null}
        {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
        {data ? (
          <ul className="divide-y rounded-lg border bg-card">
            <GmailRow sources={sources} timezone={timezone} />
            {demo ? <DemoRow source={demo} timezone={timezone} /> : null}
            <FolderRows sources={sources} timezone={timezone} />
            {adding ? <AddFolderForm onDone={closeForm} /> : null}
            <UploadsRow count={(uploads?.documents ?? 0) + (uploads?.messages ?? 0)} />
            {testData ? <SampleRow source={testData} /> : null}
          </ul>
        ) : null}
      </section>

      <OcrBacklogNotice />

      <section className="grid gap-2">
        <SectionTitle id="records" title={t("records.title")} hint={t("records.hint")} />
        <ProcessingRecords timezone={timezone} />
      </section>
    </div>
  );
}

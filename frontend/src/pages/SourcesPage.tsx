import { CircleCheck, FileText, History, Mail } from "lucide-react";
import { useEffect } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { UploadButton } from "@/components/layout/TopBar";
import { JobItem } from "@/components/sources/JobItem";
import { OcrBacklogNotice } from "@/components/sources/OcrBacklogNotice";
import { DocumentsTable, MessagesTable } from "@/components/sources/RecordTables";
import { DemoCard, FoldersCard, GmailCard } from "@/components/sources/SourceCards";
import { EmptyState, ErrorState, LoadingRows, PageHeader } from "@/components/ui/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTimezone } from "@/lib/hooks";
import { useDocuments, useFailures, useJobs, useMessages, useSources } from "@/lib/queries";

function DocumentsTab({ timezone }: { timezone: string }) {
  const { t } = useTranslation();
  const { data, error, isLoading, refetch } = useDocuments();
  if (isLoading) return <LoadingRows rows={4} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data?.items.length) return <EmptyState icon={FileText} title={t("sources.documents.empty")} action={<UploadButton variant="outline" />} />;
  return <DocumentsTable documents={data.items} timezone={timezone} />;
}

function MessagesTab({ timezone }: { timezone: string }) {
  const { t } = useTranslation();
  const { data, error, isLoading, refetch } = useMessages();
  if (isLoading) return <LoadingRows rows={4} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data?.items.length) return <EmptyState icon={Mail} title={t("sources.messages.empty")} />;
  return <MessagesTable messages={data.items} timezone={timezone} />;
}

function JobsTab({ timezone }: { timezone: string }) {
  const { t } = useTranslation();
  const { data, error, isLoading, refetch } = useJobs();
  if (isLoading) return <LoadingRows rows={4} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data?.items.length) return <EmptyState icon={History} title={t("sources.jobs.empty")} />;
  return (
    <div className="grid gap-2">
      {data.items.map((job) => (
        <JobItem key={job.id} job={job} timezone={timezone} />
      ))}
    </div>
  );
}

function FailuresTab({ timezone }: { timezone: string }) {
  const { t } = useTranslation();
  const { data, error, isLoading, refetch } = useFailures();
  if (isLoading) return <LoadingRows rows={3} />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data || data.documents.length + data.messages.length + data.jobs.length === 0) {
    return <EmptyState icon={CircleCheck} title={t("sources.failures.empty")} />;
  }
  return (
    <div className="grid gap-6">
      {data.jobs.length ? (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">{t("sources.failures.jobs")}</h3>
          {data.jobs.map((job) => (
            <JobItem key={job.id} job={job} timezone={timezone} />
          ))}
        </section>
      ) : null}
      {data.documents.length ? (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">{t("sources.failures.documents")}</h3>
          <DocumentsTable documents={data.documents} timezone={timezone} />
        </section>
      ) : null}
      {data.messages.length ? (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">{t("sources.failures.messages")}</h3>
          <MessagesTable messages={data.messages.map((m) => ({ ...m, task_count: 0, content_type: null, skip_reason: null }))} timezone={timezone} />
        </section>
      ) : null}
    </div>
  );
}

const TABS = ["documents", "messages", "jobs", "failures"] as const;
type Tab = (typeof TABS)[number];

export default function SourcesPage() {
  const { t } = useTranslation();
  const timezone = useTimezone();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const { data, error, isLoading, refetch } = useSources();
  const { data: failures } = useFailures();
  const tab: Tab = TABS.includes(params.get("tab") as Tab) ? (params.get("tab") as Tab) : "documents";
  const failureCount = failures ? failures.documents.length + failures.messages.length + failures.jobs.length : 0;

  useEffect(() => {
    if (!location.hash || isLoading) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [location.hash, isLoading]);

  const sources = data?.items ?? [];
  return (
    <div className="grid gap-6">
      <PageHeader title={t("sources.title")} description={t("sources.description")} actions={<UploadButton />} />
      {isLoading ? <LoadingRows rows={3} /> : null}
      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}
      {data ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div id="gmail" className="scroll-mt-20">
            <GmailCard sources={sources} timezone={timezone} />
          </div>
          <div id="demo" className="scroll-mt-20">
            <DemoCard sources={sources} timezone={timezone} />
          </div>
          <div id="folders" className="scroll-mt-20">
            <FoldersCard sources={sources} timezone={timezone} />
          </div>
        </div>
      ) : null}
      <OcrBacklogNotice />
      <Tabs value={tab} onValueChange={(v) => setParams(v === "documents" ? {} : { tab: v }, { replace: true })}>
        <TabsList className="max-w-full overflow-x-auto">
          {TABS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {t(`sources.tabs.${key}`)}
              {key === "failures" && failureCount ? (
                <span className="rounded-full bg-destructive/15 px-1.5 text-xs text-destructive tabular-nums">{failureCount}</span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="documents" className="mt-4">
          <DocumentsTab timezone={timezone} />
        </TabsContent>
        <TabsContent value="messages" className="mt-4">
          <MessagesTab timezone={timezone} />
        </TabsContent>
        <TabsContent value="jobs" className="mt-4">
          <JobsTab timezone={timezone} />
        </TabsContent>
        <TabsContent value="failures" className="mt-4">
          <FailuresTab timezone={timezone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

import { beforeAll, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { buildRecords, matchesFilter, type Translate } from "./records";
import type { DocumentBrief, MessageListItem } from "./types";

const t = ((key: string, options?: Record<string, unknown>) => (i18n.t as unknown as Translate)(key, options)) as Translate;

function message(id: number, overrides: Partial<MessageListItem> = {}): MessageListItem {
  return {
    id,
    subject: `Mail ${id}`,
    sender: "Synthetic Sender <sender@example.org>",
    sent_at: `2026-10-${String(10 + id).padStart(2, "0")}T08:00:00+00:00`,
    web_link: null,
    source_kind: "gmail",
    status: "processed",
    thread_id: null,
    task_count: 0,
    content_type: "informational",
    skip_reason: null,
    error_code: null,
    ...overrides,
  };
}

function document(id: number, overrides: Partial<DocumentBrief> = {}): DocumentBrief {
  return {
    id,
    name: `file-${id}.pdf`,
    kind: "pdf",
    mime_type: "application/pdf",
    size_bytes: 2048,
    page_count: 1,
    extraction_method: "text",
    ocr_engine: null,
    language: "de",
    doc_date: null,
    status: "processed",
    error_code: null,
    error_message: null,
    warnings: [],
    sha256: "x",
    imported_at: "2026-10-12T08:00:00+00:00",
    processed_at: null,
    processing_ms: 10,
    source_kind: "upload",
    original_path: null,
    has_stored_copy: true,
    message_id: null,
    text_chars: 100,
    task_count: 0,
    ...overrides,
  };
}

describe("processing records", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("puts attachments under their mail instead of listing every signature image", () => {
    const mails = [message(1), message(2)];
    const docs = [1, 2].flatMap((m) => [document(10 * m, { name: "image001.png", kind: "image", message_id: m }), document(10 * m + 1, { message_id: m })]);
    const items = buildRecords(mails, [...docs, document(99)], t);
    expect(items.map((i) => i.key)).toEqual(["m:2", "d:99", "m:1"]);
    expect(items[0].attachments.map((a) => a.title)).toEqual(["image001.png", "file-21.pdf"]);
  });

  it("explains every outcome in words, never with a bare code", () => {
    const items = buildRecords(
      [
        message(1, { task_count: 2 }),
        message(2, { content_type: "marketing" }),
        message(3, { status: "skipped", skip_reason: "sent_or_draft" }),
        message(4, { status: "failed", error_code: "transient_error" }),
      ],
      [document(5, { kind: "image", extraction_method: "none", warnings: ["ocr_unavailable"] }), document(6, { status: "skipped", warnings: ["duplicate_content_of:5"] })],
      t,
    );
    const reason = (key: string) => items.find((i) => i.key === key)?.reason;
    expect(reason("m:1")).toBe("发现 2 项任务");
    expect(reason("m:2")).toBe("营销，没有需要处理的事项");
    expect(reason("m:3")).toBe("已发送邮件或草稿，不做分析");
    expect(reason("m:4")).toBe("外部服务暂时不可用，稍后会自动重试。");
    expect(reason("d:5")).toBe("图片中的文字未读取（当时未安装 OCR）");
    expect(reason("d:6")).toBe("与文件 #5 内容相同");
    for (const item of items) expect(item.reason ?? "").not.toMatch(/^(none|null|undefined)$/);
  });

  it("lists failures first, including a mail whose attachment failed", () => {
    const items = buildRecords([message(1), message(2)], [document(7, { message_id: 1, status: "failed", error_code: "ocr_failed" })], t);
    expect(items[0].key).toBe("m:1");
    expect(items[0].hasFailure).toBe(true);
    expect(matchesFilter(items[0], "failed")).toBe(true);
    expect(matchesFilter(items[1], "failed")).toBe(false);
  });
});

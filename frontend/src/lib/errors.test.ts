import { afterEach, expect, it } from "vitest";
import i18n from "@/i18n";
import { ApiError } from "./api";
import { errorMessage } from "./errors";

afterEach(async () => { await i18n.changeLanguage("zh-CN"); });

it.each(["zh-CN", "en"])("keeps Google's failure status and reason visible in %s", async language => {
  await i18n.changeLanguage(language);
  const detail = "Google Calendar API request failed (400 invalid)";
  const message = errorMessage(new ApiError(502, "permanent_error", detail, false));
  expect(message).toContain(detail);
  expect(message).toContain(i18n.t("errors.permanent_error"));
});

it("retains the reconnect guidance for authorization failures", () => {
  const message = errorMessage(new ApiError(502, "auth_required", "Stored credentials were rejected"));
  expect(message).toBe(i18n.t("errors.auth_required"));
});

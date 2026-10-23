import { translateKey } from "@/i18n";
import { ApiError } from "./api";

const DETAILED = new Set(["invalid_settings", "validation_error"]);

/** A user-facing, localised message for any error thrown by the API client. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code.startsWith("agent_")) return translateKey(`agent.errors.${error.code}`, error.message);
    const text = translateKey(`errors.${error.code}`, error.message);
    // Validation messages name the offending field, which the generic translation cannot.
    return DETAILED.has(error.code) && error.message && text !== error.message ? `${text} (${error.message})` : text;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code : null;
}

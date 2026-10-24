/** Module/CSS download failures need a fresh document, since React.lazy caches a rejected import. */
export function isPageLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(message);
}

export function reloadCurrentPage(): void {
  window.location.reload();
}

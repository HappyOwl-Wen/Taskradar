import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const session = (token: string) => ({ csrf_token: token, version: "0.1.0", language: "zh-CN", theme: "system", timezone: "Europe/Berlin" });

describe("api client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules(); // fresh module state (CSRF token cache) per test
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the CSRF token on state-changing requests", async () => {
    const { request } = await import("./api");
    fetchMock.mockResolvedValueOnce(json(200, session("tok-1"))).mockResolvedValueOnce(json(200, { ok: true }));
    await request("POST", "/api/tasks/batch", { body: { ids: ["a"], action: "confirm" } });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/tasks/batch");
    expect(init.headers["X-TaskRadar-CSRF"]).toBe("tok-1");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("does not attach the token to GET requests and encodes array queries", async () => {
    const { request } = await import("./api");
    fetchMock.mockResolvedValueOnce(json(200, { items: [], total: 0 }));
    await request("GET", "/api/tasks", { query: { status: ["candidate", "confirmed"], q: "", limit: 5 } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/tasks?status=candidate&status=confirmed&limit=5");
    expect(init.headers["X-TaskRadar-CSRF"]).toBeUndefined();
  });

  it("refreshes the token once after a server restart", async () => {
    const { request } = await import("./api");
    fetchMock
      .mockResolvedValueOnce(json(200, session("old")))
      .mockResolvedValueOnce(json(403, { error: { code: "csrf_failed", message: "bad token" } }))
      .mockResolvedValueOnce(json(200, session("new")))
      .mockResolvedValueOnce(json(200, { ok: true }));
    await expect(request("POST", "/api/notifications/read", { body: {} })).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[3][1].headers["X-TaskRadar-CSRF"]).toBe("new");
  });

  it("turns the error envelope into an ApiError", async () => {
    const { request, ApiError } = await import("./api");
    fetchMock.mockResolvedValueOnce(
      json(409, { error: { code: "calendar_not_connected", message: "Google Calendar is not connected", recoverable: true, details: {} } }),
    );
    const error = await request("GET", "/api/tasks/x/calendar/preview").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: "calendar_not_connected", recoverable: true });
  });

  it("reports an unreachable backend as a network error", async () => {
    const { request } = await import("./api");
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(request("GET", "/api/health")).rejects.toMatchObject({ code: "network_error", status: 0 });
  });
});

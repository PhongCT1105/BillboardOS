import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { modules } from "./test.setup";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("CREAO live runner", () => {
  test("uses the new role's scoped key and accepts only a matching complete JSON result", async () => {
    vi.stubEnv("CREAO_SCREEN_AUDIENCE_AGENT_ID", AGENT_ID);
    vi.stubEnv("CREAO_SCREEN_AUDIENCE_API_KEY", "capi_test_screen");
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.headers).toMatchObject({ Authorization: "Bearer capi_test_screen" });
      return new Response(JSON.stringify(init.method === "POST"
        ? { id: RUN_ID, status: "pending" }
        : { status: "completed", result: { text: JSON.stringify({ schemaVersion: 1, role: "screen_audience", traceId: "trace-1", status: "estimated" }) } }),
      { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const t = convexTest(schema, modules);
    const result = await t.action(internal.creaoLive.run, {
      role: "screen_audience", requestJson: JSON.stringify({ schemaVersion: 1, traceId: "trace-1" }),
    });
    expect(result).toMatchObject({ role: "screen_audience", traceId: "trace-1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://agent.creao.ai/api/v1/apps/${AGENT_ID}/runs`);
  });

  test("rejects a result from another trace", async () => {
    vi.stubEnv("CREAO_SCREEN_AUDIENCE_AGENT_ID", AGENT_ID);
    vi.stubEnv("CREAO_SCREEN_AUDIENCE_API_KEY", "capi_test_screen");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === "POST"
      ? { id: RUN_ID, status: "pending" }
      : { status: "completed", result: { text: JSON.stringify({ schemaVersion: 1, role: "screen_audience", traceId: "another-trace" }) } }),
    { status: 200, headers: { "content-type": "application/json" } })));
    const t = convexTest(schema, modules);
    await expect(t.action(internal.creaoLive.run, {
      role: "screen_audience", requestJson: JSON.stringify({ schemaVersion: 1, traceId: "trace-1" }),
    })).rejects.toThrow("identity does not match");
  });
});

import { afterEach, describe, expect, test, vi } from "vitest";
import { embedTexts, parseEmbeddingResponse } from "./lib/bitdeerEmbedding";

afterEach(() => vi.unstubAllGlobals());

describe("Bitdeer embedding response", () => {
  test("accepts ordered 1024-dimensional vectors", () => {
    const vector = Array(1024).fill(0.25);
    expect(parseEmbeddingResponse({ data: [{ index: 1, embedding: vector }, { index: 0, embedding: vector }] }, 2)).toEqual([vector, vector]);
  });
  test("rejects missing, wrong-sized and non-finite vectors", () => {
    expect(() => parseEmbeddingResponse({ data: [] }, 1)).toThrow();
    expect(() => parseEmbeddingResponse({ data: [{ index: 0, embedding: Array(1023).fill(0) }] }, 1)).toThrow();
    expect(() => parseEmbeddingResponse({ data: [{ index: 0, embedding: [...Array(1023).fill(0), Infinity] }] }, 1)).toThrow();
  });
  test("sends the selected model and preserves API errors without storing vectors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(embedTexts(["voice agent"], "test-key")).rejects.toThrow("HTTP 503");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api-inference.bitdeer.ai/v1/embeddings");
    expect(JSON.parse(init.body)).toEqual({ model: "BAAI/bge-m3", input: ["voice agent"] });
  });
});

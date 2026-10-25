export const EMBEDDING_MODEL = "BAAI/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;

export function parseEmbeddingResponse(value: unknown, count: number): number[][] {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data) || value.data.length !== count) {
    throw new Error("Bitdeer returned the wrong number of embeddings");
  }
  const vectors: number[][] = Array.from({ length: count });
  for (const item of value.data) {
    if (!item || typeof item !== "object" || !("index" in item) || !("embedding" in item) ||
      !Number.isInteger(item.index) || (item.index as number) < 0 || (item.index as number) >= count ||
      !Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIMENSIONS ||
      !item.embedding.every((n: unknown) => typeof n === "number" && Number.isFinite(n)) ||
      vectors[item.index as number]) throw new Error("Bitdeer returned an invalid embedding");
    vectors[item.index as number] = item.embedding as number[];
  }
  if (vectors.some((v) => !v)) throw new Error("Bitdeer omitted an embedding index");
  return vectors;
}

export async function embedTexts(texts: string[], key: string): Promise<number[][]> {
  if (!key) throw new Error("BITDEER_API_KEY is not configured");
  if (!texts.length || texts.length > 16 || texts.some((text) => !text.trim() || text.length > 6000)) {
    throw new Error("Embedding input must contain 1-16 nonempty texts of at most 6000 characters");
  }
  const response = await fetch("https://api-inference.bitdeer.ai/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Bitdeer embedding request failed (HTTP ${response.status})`);
  return parseEmbeddingResponse(await response.json(), texts.length);
}

import { pipeline } from "@huggingface/transformers";

export type Embedder = (texts: string[], kind: "query" | "passage") => Promise<Float32Array[]>;

const MODEL = "Xenova/multilingual-e5-small";
const BATCH = 16;

let extractor: Promise<any> | null = null;

/** Embeddings locales (384 dimensiones, normalizados). El modelo se descarga la primera vez. */
export const localEmbedder: Embedder = async (texts, kind) => {
  extractor ??= pipeline("feature-extraction", MODEL, { dtype: "q8" });
  const model = await extractor;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    // E5 espera el prefijo "query: " o "passage: " según qué lado de la comparación es.
    const batch = texts.slice(i, i + BATCH).map((t) => `${kind}: ${t.slice(0, 2000)}`);
    const tensor = await model(batch, { pooling: "mean", normalize: true });
    const [n, dim] = tensor.dims as [number, number];
    const data = tensor.data as Float32Array;
    for (let j = 0; j < n; j++) out.push(data.slice(j * dim, (j + 1) * dim));
  }
  return out;
};

/** Producto punto; con vectores normalizados es la similitud coseno. */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

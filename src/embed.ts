import { pipeline } from "@huggingface/transformers";

export type Embedder = (texts: string[], kind: "query" | "passage") => Promise<Float32Array[]>;

const MODEL = "Xenova/multilingual-e5-small";
// Medido con 200 avisos: lotes de 16 y textos de 2000 caracteres llegan a 1,4 GB de RAM; lotes de 4, textos de
// 1200 caracteres, un hilo y sin el arena de memoria de ONNX, a unos 730 MB, a cambio de tardar unos 80 ms por aviso.
// El droplet es compartido y sin swap, así que se prioriza la memoria. Un hilo además deja CPU libre a Vatio.
const BATCH = 4;
const MAX_CHARS = 1200;

let extractor: Promise<any> | null = null;

/** Embeddings locales (384 dimensiones, normalizados). El modelo se descarga la primera vez. */
export const localEmbedder: Embedder = async (texts, kind) => {
  extractor ??= pipeline("feature-extraction", MODEL, {
    dtype: "q8",
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, enableCpuMemArena: false },
  } as any);
  const model = await extractor;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    // E5 espera el prefijo "query: " o "passage: " según qué lado de la comparación es.
    const batch = texts.slice(i, i + BATCH).map((t) => `${kind}: ${t.slice(0, MAX_CHARS)}`);
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

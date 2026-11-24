import type { Job } from "../db.ts";

export type NewJob = Omit<Job, "first_seen_at">;

/**
 * `note`: algo que vale la pena ver en la corrida, como qué regiones se recorrieron o cuáles fallaron.
 * `listed`: si la fuente recorrió su listado entero, los ids que siguen publicados; los demás que tengamos de ella
 * se dejaron de publicar y no se ofrecen más.
 */
export type SourceResult = { jobs: NewJob[]; pages: number; invalid: number; note?: string; listed?: string[] };

/** Devuelve los avisos que `isKnown` todavía no conoce, del más nuevo al más viejo. */
export type Source = (opts: {
  maxPages: number;
  isKnown: (id: string) => boolean;
}) => Promise<SourceResult>;

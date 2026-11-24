import type { Job } from "../db.ts";

export type NewJob = Omit<Job, "first_seen_at">;

/** `note`: algo que vale la pena ver en la corrida, como qué regiones se recorrieron o cuáles fallaron. */
export type SourceResult = { jobs: NewJob[]; pages: number; invalid: number; note?: string };

/** Devuelve los avisos que `isKnown` todavía no conoce, del más nuevo al más viejo. */
export type Source = (opts: {
  maxPages: number;
  isKnown: (id: string) => boolean;
}) => Promise<SourceResult>;

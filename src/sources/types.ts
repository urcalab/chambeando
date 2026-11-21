import type { Job } from "../db.ts";

export type NewJob = Omit<Job, "first_seen_at">;

export type SourceResult = { jobs: NewJob[]; pages: number; invalid: number };

/** Devuelve los avisos que `isKnown` todavía no conoce, del más nuevo al más viejo. */
export type Source = (opts: {
  maxPages: number;
  isKnown: (id: string) => boolean;
}) => Promise<SourceResult>;

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Modality } from "./text.ts";

export type Job = {
  id: string;
  source: "laborum" | "trabajando";
  source_id: string;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  region: string | null;
  modality: Modality | null;
  job_type: string | null;
  salary: number | null;
  description: string;
  published_at: string | null;
  first_seen_at: string;
};

export type User = {
  phone: string;
  name: string | null;
  summary: string;
  roles: string[];
  regions: string[];
  modalities: Modality[];
  min_salary: number | null;
  exclude: string[];
  active: boolean;
  matched_until: string;
  last_template_at: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  region TEXT,
  modality TEXT,
  job_type TEXT,
  salary INTEGER,
  description TEXT NOT NULL,
  published_at TEXT,
  first_seen_at TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS jobs_first_seen ON jobs(first_seen_at);

CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT,
  summary TEXT NOT NULL,
  roles TEXT NOT NULL DEFAULT '[]',
  regions TEXT NOT NULL DEFAULT '[]',
  modalities TEXT NOT NULL DEFAULT '[]',
  min_salary INTEGER,
  exclude TEXT NOT NULL DEFAULT '[]',
  embedding BLOB,
  active INTEGER NOT NULL DEFAULT 1,
  matched_until TEXT NOT NULL,
  last_template_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Un aviso evaluado para un usuario: pending (por mandar), sent, o rejected (el modelo lo descartó).
CREATE TABLE IF NOT EXISTS deliveries (
  phone TEXT NOT NULL,
  job_id TEXT NOT NULL,
  score REAL,
  reason TEXT,
  status TEXT NOT NULL,
  useful INTEGER,
  feedback TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (phone, job_id)
);
CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(status);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Uint8Array): Float32Array {
  // Copia: el buffer que entrega SQLite puede no estar alineado a 4 bytes.
  return new Float32Array(b.slice().buffer);
}

type Row = Record<string, unknown>;

export function rowToUser(r: Row): User {
  return {
    phone: r.phone as string,
    name: (r.name as string | null) ?? null,
    summary: r.summary as string,
    roles: JSON.parse(r.roles as string),
    regions: JSON.parse(r.regions as string),
    modalities: JSON.parse(r.modalities as string),
    min_salary: (r.min_salary as number | null) ?? null,
    exclude: JSON.parse(r.exclude as string),
    active: r.active === 1,
    matched_until: r.matched_until as string,
    last_template_at: (r.last_template_at as string | null) ?? null,
  };
}

export function getUser(db: DatabaseSync, phone: string): User | null {
  const r = db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) as Row | undefined;
  return r ? rowToUser(r) : null;
}

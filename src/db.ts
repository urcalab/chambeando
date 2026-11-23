import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Country, JobKind, Modality } from "./text.ts";

export type Job = {
  id: string;
  /** El portal donde se publicó: laborum, bumeran, multitrabajos, konzerta, trabajando. */
  source: string;
  source_id: string;
  country: Country;
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
  country: Country;
  name: string | null;
  summary: string;
  /** Qué estudió o estudia, si lo dijo. */
  studies: string | null;
  /** true si busca su primer trabajo; null si no lo ha dicho. */
  first_job: boolean | null;
  /** Tipos de trabajo que acepta; vacío si le da lo mismo. */
  job_kinds: JobKind[];
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
  country TEXT NOT NULL,
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
  embedding BLOB,
  -- Huella del aviso (ver dedupeKey). Si otro aviso con la misma huella llegó antes,
  -- duplicate_of apunta a ese y este no se ofrece a nadie.
  dedupe_key TEXT,
  locality TEXT,
  duplicate_of TEXT
);
CREATE INDEX IF NOT EXISTS jobs_dedupe ON jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS jobs_country_seen ON jobs(country, first_seen_at);

CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  name TEXT,
  summary TEXT NOT NULL,
  studies TEXT,
  first_job INTEGER,
  job_kinds TEXT NOT NULL DEFAULT '[]',
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
  applied INTEGER,
  token TEXT,
  clicks INTEGER NOT NULL DEFAULT 0,
  first_click_at TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (phone, job_id)
);
CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(status);

-- Registro forense de cada llamada a la API (menos /health y la landing). El teléfono va como hash.
CREATE TABLE IF NOT EXISTS api_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  caller TEXT NOT NULL,
  ip TEXT,
  phone_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS api_log_at ON api_log(at);
-- Que nadie, ni el propio backend, edite el registro: solo se agregan filas o se borran las vencidas.
CREATE TRIGGER IF NOT EXISTS api_log_no_update BEFORE UPDATE ON api_log
BEGIN SELECT RAISE(ABORT, 'api_log es de solo agregar'); END;

-- Una fila por corrida horaria, con lo que trajo cada fuente, el match y los envíos.
CREATE TABLE IF NOT EXISTS ingest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  error TEXT
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Columnas agregadas después de la primera versión: se crean en bases que ya existían. */
const ADDED_COLUMNS: Array<[table: string, column: string, type: string]> = [
  ["jobs", "dedupe_key", "TEXT"],
  ["jobs", "locality", "TEXT"],
  ["jobs", "duplicate_of", "TEXT"],
  ["users", "studies", "TEXT"],
  ["users", "first_job", "INTEGER"],
  ["users", "job_kinds", "TEXT NOT NULL DEFAULT '[]'"],
  ["deliveries", "applied", "INTEGER"],
  ["deliveries", "token", "TEXT"],
  ["deliveries", "clicks", "INTEGER NOT NULL DEFAULT 0"],
  ["deliveries", "first_click_at", "TEXT"],
];

function migrate(db: DatabaseSync): void {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS deliveries_token ON deliveries(token)");
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
    country: r.country as Country,
    name: (r.name as string | null) ?? null,
    summary: r.summary as string,
    studies: (r.studies as string | null) ?? null,
    first_job: r.first_job === null || r.first_job === undefined ? null : r.first_job === 1,
    job_kinds: JSON.parse(r.job_kinds as string),
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

import { z } from "zod";
import { fetchText, sleep } from "./http.ts";
import { COMPUTRABAJO_SITES } from "./computrabajo.ts";
import { normalize, regionOf, stripHtml } from "../text.ts";
import type { NewJob, Source } from "./types.ts";

/**
 * Magneto (magneto365.com), el portal de empleo de Comfama, en Colombia. No tiene API pública: su buscador es una
 * página de Next.js que trae los avisos dentro del HTML, en el payload de React Server Components
 * (`self.__next_f.push`), con 20 avisos por página del más nuevo al más viejo. Cada aviso trae la descripción
 * completa, así que no se pide su detalle. Su robots.txt prohíbe las URLs con "?" salvo la paginación
 * (`?paginator[page]=N`), que es lo único que se pide.
 */
const LISTING = "https://www.magneto365.com/co/trabajos/buscar";
const PAGE_PAUSE_MS = 1500;

/** El texto del payload RSC que la página va empujando a `self.__next_f`. */
export function rscPayload(html: string): string {
  let out = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) out += JSON.parse(m[1]!) as string;
  return out;
}

/**
 * Los textos largos del payload, por id: filas `<id>:T<largo en hex>,<texto>`, sin fin de línea, con el largo en
 * bytes UTF-8. Las demás filas terminan en "\n". Los avisos apuntan a su descripción con "$<id>".
 */
export function rscTexts(payload: string): Map<string, string> {
  const buf = Buffer.from(payload, "utf8");
  const texts = new Map<string, string>();
  let pos = 0;
  while (pos < buf.length) {
    const colon = buf.indexOf(0x3a, pos);
    const id = colon < 0 ? "" : buf.toString("latin1", pos, colon);
    if (/^[0-9a-f]{1,8}$/.test(id) && buf[colon + 1] === 0x54) {
      const comma = buf.indexOf(0x2c, colon + 2);
      const length = Number.parseInt(buf.toString("latin1", colon + 2, comma), 16);
      if (comma > 0 && Number.isFinite(length)) {
        texts.set(id, buf.toString("utf8", comma + 1, comma + 1 + length));
        pos = comma + 1 + length;
        continue;
      }
    }
    const newline = buf.indexOf(0x0a, pos);
    if (newline < 0) break;
    pos = newline + 1;
  }
  return texts;
}

/** El arreglo JSON que sigue a `key` en el texto, respetando los strings. null si no está o está cortado. */
function jsonArrayAfter(text: string, key: string): unknown[] | null {
  const at = text.indexOf(key);
  if (at < 0) return null;
  const start = at + key.length - 1;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      if (--depth === 0) return JSON.parse(text.slice(start, i + 1)) as unknown[];
    }
  }
  return null;
}

const Row = z.object({
  id: z.number(),
  title: z.string().trim().min(1),
  jobSlug: z.string().min(1),
  cities: z.array(z.string()).nullish(),
  departments: z.array(z.string()).nullish(),
  salary: z.number().nullish(),
  minSalary: z.number().nullish(),
  maxSalary: z.number().nullish(),
  toAgree: z.boolean().nullish(),
  currencyCode: z.string().nullish(),
  description: z.string().nullish(),
  companyName: z.string().nullish(),
  confidential: z.boolean().nullish(),
  publishDate: z.string().nullish(),
  contractOrder: z.object({ name: z.string().nullish() }).nullish(),
  isRemote: z.boolean().nullish(),
  experienceMonthsNumber: z.number().nullish(),
  educationLevel: z.array(z.object({ name: z.string() })).nullish(),
});

/** Los avisos de una página del buscador, con la descripción ya resuelta. */
export function parsePage(html: string): unknown[] {
  const payload = rscPayload(html);
  const rows = jsonArrayAfter(payload, '"rows":[') ?? [];
  const texts = rscTexts(payload);
  return rows.map((row) => {
    const d = (row as { description?: unknown } | null)?.description;
    if (typeof d !== "string") return row;
    // "$26" apunta al texto 26; "$$..." es un "$" literal.
    const ref = /^\$([0-9a-f]+)$/.exec(d)?.[1];
    return { ...(row as object), description: ref ? (texts.get(ref) ?? "") : d.replace(/^\$\$/, "$") };
  });
}

// Departamentos que conocemos: los de Computrabajo, para que la región calce con la de sus avisos y la de los perfiles.
const KNOWN = new Set(COMPUTRABAJO_SITES["computrabajo-co"]?.regions.map((r) => regionOf("CO", r.name)));

const pesos = (n: number) => `$${n.toLocaleString("es-CO")}`;

/** "Medellín, Antioquia"; "Bogotá, D.C." sin repetir el departamento; varias ciudades, todas. */
function locationOf(cities: string[], departments: string[]): string | null {
  const department = departments[0];
  const place = cities.join(", ");
  const bare = (s: string) => normalize(s).replace(/ d c$/, "");
  if (!department || cities.some((c) => bare(c) === bare(department))) return place || null;
  return [place, department].filter(Boolean).join(", ");
}

export function toJob(raw: unknown): NewJob | null {
  const parsed = Row.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  const departments = r.departments ?? [];
  const min = r.minSalary || r.salary || 0;
  const max = r.maxSalary || 0;
  const paid = !r.toAgree && (r.currencyCode ?? "COP") === "COP" && min > 0;
  const contract = r.contractOrder?.name ?? null;
  const education = r.educationLevel?.map((e) => e.name) ?? [];
  const months = r.experienceMonthsNumber;
  const description = [
    // Un rango va como texto, que es lo que muestra el mensaje; `salary` queda con el tope, para el filtro.
    paid && max > min ? `Sueldo: ${pesos(min)} a ${pesos(max)}.` : null,
    // Magneto marca igual el trabajo remoto y el híbrido: se dice en el texto y la modalidad queda sin saber.
    r.isRemote ? "Modalidad: remoto o híbrido." : null,
    months === 0 ? "Sin experiencia." : months ? `Experiencia: ${months} ${months === 1 ? "mes" : "meses"}.` : null,
    education.length ? `Estudios: ${education.join(", ")}.` : null,
    stripHtml(r.description ?? ""),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    id: `magneto:${r.id}`,
    source: "magneto",
    source_id: String(r.id),
    country: "CO",
    url: `https://www.magneto365.com/co/empleos/${r.jobSlug}`,
    // Algunos títulos traen tabulaciones y códigos internos pegados: se dejan en una línea.
    title: r.title.replace(/\s+/g, " "),
    company: r.confidential || normalize(r.companyName ?? "") === "confidencial" ? null : (r.companyName?.trim() || null),
    location: locationOf(r.cities ?? [], departments),
    region: departments.map((d) => regionOf("CO", d)).find((d) => d && KNOWN.has(d)) ?? null,
    modality: null,
    // El contrato de aprendizaje (SENA) es la práctica en Colombia: se dice así para que jobKind lo lea.
    job_type: contract && /aprendizaje/i.test(contract) ? `Práctica (${contract})` : contract,
    salary: paid ? Math.max(min, max) : null,
    description,
    published_at: r.publishDate ?? null,
  };
}

/** Los avisos de Magneto, del más nuevo al más viejo, hasta la primera página sin nada nuevo. */
export function magneto(get: (url: string) => Promise<string> = fetchText): Source {
  return async ({ maxPages, isKnown }) => {
    const jobs: NewJob[] = [];
    let invalid = 0;
    let pages = 0;
    for (let page = 1; page <= maxPages; page++) {
      const url = `${LISTING}?paginator[page]=${page}`;
      const rows = parsePage(await get(url));
      pages++;
      // El buscador siempre tiene avisos: una página vacía es un cambio en la página o un bloqueo.
      if (page === 1 && rows.length === 0) throw new Error(`${url} no trae avisos (¿cambió la página?)`);
      let fresh = 0;
      for (const raw of rows) {
        const job = toJob(raw);
        if (!job) {
          invalid++;
          continue;
        }
        if (isKnown(job.id)) continue;
        jobs.push(job);
        fresh++;
      }
      if (fresh === 0 || rows.length === 0) break;
      await sleep(PAGE_PAUSE_MS);
    }
    return { jobs, pages, invalid };
  };
}

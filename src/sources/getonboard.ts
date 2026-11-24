import { z } from "zod";
import { fetchJson, sleep } from "./http.ts";
import { COMPUTRABAJO_SITES } from "./computrabajo.ts";
import { COUNTRIES, normalize, regionKey, regionOf, stripHtml, type Country, type Modality } from "../text.ts";
import type { NewJob, Source } from "./types.ts";

/**
 * Get on Board (getonbrd.com): avisos de tecnología en Latinoamérica, por su API pública, que no pide clave.
 * Sus términos (sección 7.1) piden mostrar "Get on Board" como fuente, enlazar cada aviso a su página, mandar a
 * postular allá, mostrar los datos sin cambios y refrescados al menos cada 24 horas, y no usarlos en un producto que
 * cobre a quien busca trabajo, revenderlos ni entrenar modelos con ellos.
 * El listado de un país es corto (cientos de avisos) y no viene ordenado por fecha: se recorre entero en cada corrida,
 * y lo que deja de aparecer se deja de ofrecer (`listed`).
 */
const API = "https://www.getonbrd.com/api/v0";
const EXPAND = encodeURIComponent(JSON.stringify(["company", "location_cities", "modality", "seniority"]));
const PAGE_PAUSE_MS = 1000;

const Named = z.object({ data: z.object({ attributes: z.object({ name: z.string() }).nullish() }).nullish() }).nullish();

const Posting = z.object({
  id: z.string().min(1),
  attributes: z.object({
    title: z.string().min(1),
    description_headline: z.string().nullish(),
    description: z.string().nullish(),
    functions_headline: z.string().nullish(),
    functions: z.string().nullish(),
    desirable_headline: z.string().nullish(),
    desirable: z.string().nullish(),
    benefits_headline: z.string().nullish(),
    benefits: z.string().nullish(),
    remote_modality: z.string().nullish(),
    countries: z.array(z.string()).nullish(),
    min_salary: z.number().nullish(),
    max_salary: z.number().nullish(),
    published_at: z.number().nullish(),
    company: Named,
    modality: Named,
    seniority: Named,
    location_cities: z
      .object({ data: z.array(z.object({ attributes: z.object({ name: z.string(), country: z.string().nullish() }).nullish() })) })
      .nullish(),
  }),
  links: z.object({ public_url: z.string().url() }),
});

const Page = z.object({ data: z.array(z.unknown()), meta: z.object({ total_pages: z.number() }) });

/** Si el aviso se ofrece en el país: lo nombra entre sus países, o es remoto ("Remote"). */
export function availableIn(country: Country, raw: unknown): boolean {
  const countries: unknown = (raw as { attributes?: { countries?: unknown } } | null)?.attributes?.countries;
  const names = Array.isArray(countries) ? countries.filter((c): c is string => typeof c === "string").map(normalize) : [];
  return names.includes(normalize(COUNTRIES[country])) || names.includes("remote");
}

/** La región de una ciudad, solo si es una que conocemos (en Chile por su clave; en el resto, por las de Computrabajo). */
function regionOfCity(country: Country, city: string): string | null {
  if (country === "CL") return regionKey(city);
  const candidate = regionOf(country, city);
  const known = COMPUTRABAJO_SITES[`computrabajo-${country.toLowerCase()}`]?.regions.map((r) => regionOf(country, r.name));
  return candidate && known?.includes(candidate) ? candidate : null;
}

const usd = (n: number) => `US$${n.toLocaleString("es-419")}`;

/** El sueldo viene bruto, en dólares al mes: va como texto, porque `salary` es en moneda local y filtra el sueldo mínimo. */
function salaryLine(min: number | null | undefined, max: number | null | undefined): string | null {
  if (min && max) return `Sueldo bruto: ${usd(min)} a ${usd(max)} al mes.`;
  if (min) return `Sueldo bruto: desde ${usd(min)} al mes.`;
  if (max) return `Sueldo bruto: hasta ${usd(max)} al mes.`;
  return null;
}

const MODALITY: Record<string, Modality> = { no_remote: "presencial", hybrid: "hibrido" };

export function toJob(country: Country, raw: unknown): NewJob | null {
  const parsed = Posting.safeParse(raw);
  if (!parsed.success) return null;
  const { id, attributes: a, links } = parsed.data;
  const modality: Modality | null = a.remote_modality ? (MODALITY[a.remote_modality] ?? "remoto") : null;
  const here = normalize(COUNTRIES[country]);
  const cities = (a.location_cities?.data ?? [])
    .map((c) => c.attributes)
    .filter((c): c is { name: string; country?: string | null } => !!c && (!c.country || normalize(c.country) === here))
    .map((c) => c.name);
  const section = (headline: string | null | undefined, html: string | null | undefined) =>
    html ? [headline, stripHtml(html)].filter(Boolean).join("\n") : null;
  const seniority = a.seniority?.data?.attributes?.name;
  const description = [
    salaryLine(a.min_salary, a.max_salary),
    seniority ? `Experiencia: ${seniority}.` : null,
    section(a.description_headline, a.description),
    section(a.functions_headline, a.functions),
    section(a.desirable_headline, a.desirable),
    section(a.benefits_headline, a.benefits),
  ]
    .filter(Boolean)
    .join("\n\n");
  const site = `getonboard-${country.toLowerCase()}`;
  return {
    id: `${site}:${id}`,
    source: "getonboard",
    source_id: id,
    country,
    url: links.public_url,
    title: a.title.trim(),
    company: a.company?.data?.attributes?.name ?? null,
    location: cities.length ? `${cities.join(", ")}, ${COUNTRIES[country]}` : null,
    // Un aviso remoto sirve en cualquier región.
    region: modality === "remoto" ? null : (cities.map((c) => regionOfCity(country, c)).find(Boolean) ?? null),
    modality,
    // "Full time", "Part time", "Freelance" o "Práctica/Internship": jobKind los lee.
    job_type: a.modality?.data?.attributes?.name ?? null,
    salary: null,
    description,
    published_at: a.published_at ? new Date(a.published_at * 1000).toISOString() : null,
  };
}

/** Los avisos de Get on Board que se ofrecen en un país, nuevos para nosotros; `listed` trae todos los que siguen publicados. */
export function getonboard(country: Country, get: (url: string) => Promise<unknown> = fetchJson): Source {
  return async ({ maxPages, isKnown }) => {
    const jobs: NewJob[] = [];
    const listed = new Set<string>();
    let invalid = 0;
    let pages = 0;
    let total = 1;
    for (let page = 1; page <= Math.min(total, maxPages); page++) {
      const body = Page.parse(
        await get(`${API}/search/jobs?country_code=${country.toLowerCase()}&per_page=120&page=${page}&expand=${EXPAND}`),
      );
      total = body.meta.total_pages;
      pages++;
      for (const raw of body.data) {
        if (!availableIn(country, raw)) continue;
        const job = toJob(country, raw);
        if (!job) {
          invalid++;
          continue;
        }
        if (listed.has(job.id)) continue;
        listed.add(job.id);
        if (!isKnown(job.id)) jobs.push(job);
      }
      if (page < Math.min(total, maxPages)) await sleep(PAGE_PAUSE_MS);
    }
    // Solo con el listado entero se sabe qué dejó de publicarse.
    return { jobs, pages, invalid, ...(pages >= total ? { listed: [...listed] } : {}) };
  };
}

import { readFileSync } from "node:fs";
import { z } from "zod";
import { fetchText, sleep } from "./http.ts";
import { decodeEntities, modalityOf, regionOf, stripHtml, type Country } from "../text.ts";
import type { NewJob, Source } from "./types.ts";

/**
 * Computrabajo no tiene API: el listado es HTML y cada aviso trae sus datos como JSON-LD (JobPosting).
 * No hay un listado nacional ordenado por fecha, así que se recorre cada región con
 * `/empleos-en-<región>?by=publicationtime`, que su robots.txt permite. Opera en 17 países.
 */
type RegionFile = Record<string, { prefix: string; regions: Array<{ slug: string; name: string; count: number }> }>;

// Generado por scripts/computrabajo-regions.ts: las páginas de región que existen en cada país.
const REGION_FILE = JSON.parse(readFileSync(new URL("./computrabajo-regions.json", import.meta.url), "utf8")) as RegionFile;

export type ComputrabajoSite = { country: Country; domain: string; prefix: string; regions: Array<{ slug: string; name: string }> };

/** Un sitio por país: "computrabajo-co", "computrabajo-mx"... */
export const COMPUTRABAJO_SITES: Record<string, ComputrabajoSite> = Object.fromEntries(
  Object.entries(REGION_FILE).map(([cc, site]) => [
    `computrabajo-${cc}`,
    { country: cc.toUpperCase() as Country, domain: `${cc}.computrabajo.com`, prefix: site.prefix, regions: site.regions },
  ]),
);

// Pausas generosas: Computrabajo es el portal más sensible a la carga (bloqueó al servidor con 403).
const DETAIL_PAUSE_MS = 1500;
const PAGE_PAUSE_MS = 3000;

export type Listed = { id: string; title: string; path: string };

/** Los avisos de una página de listado: id, título y ruta al detalle. */
export function parseListing(html: string): Listed[] {
  const out: Listed[] = [];
  for (const article of html.split("<article").slice(1)) {
    const id = article.match(/data-id='([0-9A-F]{16,})'/)?.[1];
    const link = article.match(/<a class="js-o-link[^"]*" href="([^"]+)">([\s\S]*?)<\/a>/);
    if (!id || !link) continue;
    // El href viene con entidades (&#xF3;) y un fragmento de seguimiento (#lc=...) que no es parte de la ruta.
    const path = encodeURI(decodeEntities(link[1]!).replace(/#lc=.*$/, ""));
    out.push({ id, path, title: decodeEntities(link[2]!).replace(/\s+/g, " ").trim() });
  }
  return out;
}

const Posting = z.object({
  "@type": z.literal("JobPosting"),
  description: z.string().nullish(),
  datePosted: z.string().nullish(),
  employmentType: z.string().nullish(),
  jobLocationType: z.string().nullish(),
  jobLocation: z
    .object({ address: z.object({ addressLocality: z.string().nullish(), addressRegion: z.string().nullish() }).nullish() })
    .nullish(),
  baseSalary: z.object({ value: z.object({ value: z.number().nullish(), unitText: z.string().nullish() }).nullish() }).nullish(),
  hiringOrganization: z.object({ name: z.string().nullish() }).nullish(),
});

/** El JobPosting de la página de un aviso, o null si no viene o cambió de forma. */
export function parsePosting(html: string): z.infer<typeof Posting> | null {
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try {
      const data = JSON.parse(m[1]!);
      for (const item of Array.isArray(data) ? data : (data["@graph"] ?? [data])) {
        const p = Posting.safeParse(item);
        if (p.success) return p.data;
      }
    } catch {
      // otro bloque JSON-LD de la página, sin interés
    }
  }
  return null;
}

/**
 * Lo que se puede leer del HTML del aviso. Parte de los avisos (los de empresa confidencial, entre otros)
 * no trae JSON-LD, así que la descripción, la empresa y el lugar salen de aquí.
 */
export function parseDetailHtml(html: string): { description: string; company: string | null; location: string | null } | null {
  const offer = html.split('div-link="oferta"')[1];
  const body = offer?.match(/<p class="mbB">([\s\S]*?)<\/p>/)?.[1];
  if (!body) return null;
  // "Empresa - Ciudad, Departamento", bajo el título.
  const line = stripHtml(html.match(/<p class="fs16"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "").replace(/\s+/g, " ");
  const cut = line.lastIndexOf(" - ");
  const company = cut > 0 ? line.slice(0, cut).trim() : null;
  return {
    description: stripHtml(body),
    company: company && !/^importante empresa/i.test(company) ? company : null,
    location: cut > 0 ? line.slice(cut + 3).trim() || null : null,
  };
}

export function toJob(siteKey: string, regionName: string, listed: Listed, detailHtml: string): NewJob | null {
  const site = COMPUTRABAJO_SITES[siteKey]!;
  const p = parsePosting(detailHtml);
  const page = parseDetailHtml(detailHtml);
  if (!p && !page) return null;
  const address = p?.jobLocation?.address;
  // El JSON-LD suele repetir la ciudad en los dos campos; el departamento es el de la página recorrida.
  const location =
    [...new Set([address?.addressLocality, address?.addressRegion].filter(Boolean))].join(", ") || page?.location || null;
  const salary = p?.baseSalary?.value;
  return {
    id: `${siteKey}:${listed.id}`,
    source: "computrabajo",
    source_id: listed.id,
    country: site.country,
    url: `https://${site.domain}${listed.path}`,
    title: listed.title,
    company: p?.hiringOrganization?.name ?? page?.company ?? null,
    location,
    region: regionOf(site.country, regionName),
    modality: p?.jobLocationType === "TELECOMMUTE" ? "remoto" : modalityOf(listed.title),
    job_type: p?.employmentType ?? null,
    salary: salary?.value && salary.unitText === "MONTH" ? Math.round(salary.value) : null,
    description: stripHtml(p?.description ?? "") || page?.description || "",
    published_at: p?.datePosted ?? null,
  };
}

export function computrabajo(siteKey: string): Source {
  const site = COMPUTRABAJO_SITES[siteKey];
  if (!site) throw new Error(`Sitio Computrabajo desconocido: ${siteKey}`);
  return async ({ maxPages, isKnown }) => {
    const jobs: NewJob[] = [];
    const seen = new Set<string>();
    let invalid = 0;
    let pages = 0;
    for (const region of site.regions) {
      for (let page = 1; page <= maxPages; page++) {
        const url = `https://${site.domain}/${site.prefix}${region.slug}?by=publicationtime${page > 1 ? `&p=${page}` : ""}`;
        const listing = parseListing(await fetchText(url));
        pages++;
        // Toda región listada tiene avisos: una página vacía es un bloqueo o un cambio en el HTML.
        if (page === 1 && listing.length === 0) throw new Error(`${url} no trae avisos (¿bloqueo o cambio del HTML?)`);
        // Primera vez en esta región: solo la primera página, para no pedir miles de detalles de una vez.
        const cold = page === 1 && !listing.some((item) => isKnown(`${siteKey}:${item.id}`));
        let fresh = 0;
        for (const item of listing) {
          const id = `${siteKey}:${item.id}`;
          if (seen.has(id) || isKnown(id)) continue;
          seen.add(id);
          // Un aviso que falla (despublicado entre el listado y el detalle) no detiene la corrida.
          const job = await fetchText(`https://${site.domain}${item.path}`)
            .then((html) => toJob(siteKey, region.name, item, html))
            .catch(() => null);
          if (job) {
            jobs.push(job);
            fresh++;
          } else invalid++;
          await sleep(DETAIL_PAUSE_MS);
        }
        if (fresh === 0 || cold) break;
        await sleep(PAGE_PAUSE_MS);
      }
    }
    return { jobs, pages, invalid };
  };
}

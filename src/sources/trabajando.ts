import { z } from "zod";
import { fetchJson, sleep } from "./http.ts";
import { modalityOf, regionKey, slugify, stripHtml } from "../text.ts";

// Trabajando.com: solo el portal de Chile responde con esta API.
import type { NewJob, Source } from "./types.ts";

const Listed = z.object({
  idOferta: z.number(),
  nombreCargo: z.string().min(1),
  nombreEmpresa: z.string().nullish(),
  ubicacion: z.string().nullish(),
  nombreJornada: z.string().nullish(),
  fechaPublicacion: z.string().nullish(),
  descripcionOferta: z.string().nullish(),
});
const Page = z.object({ cantidadPaginas: z.number(), ofertas: z.array(z.unknown()) });

const Detail = z.object({
  slug: z.string().nullish(),
  descripcionOferta: z.string().nullish(),
  requisitosMinimos: z.string().nullish(),
  nombreEmpresaFantasia: z.string().nullish(),
  ofertaConfidencial: z.boolean().nullish(),
  mostrarSueldo: z.boolean().nullish(),
  sueldo: z.number().nullish(),
  nombreJornada: z.string().nullish(),
  ubicacion: z
    .object({ nombreRegion: z.string().nullish(), nombreComuna: z.string().nullish() })
    .nullish(),
});

export function toJob(listedRaw: unknown, detailRaw: unknown): NewJob | null {
  const l = Listed.safeParse(listedRaw);
  if (!l.success) return null;
  const o = l.data;
  // El detalle es opcional: si falla, el aviso entra igual con lo que trae el listado.
  const d = Detail.safeParse(detailRaw);
  const det = d.success ? d.data : null;
  const location =
    det?.ubicacion?.nombreComuna && det.ubicacion.nombreRegion
      ? `${det.ubicacion.nombreComuna}, ${det.ubicacion.nombreRegion}`
      : (o.ubicacion ?? null);
  const description = [det?.descripcionOferta ?? o.descripcionOferta, det?.requisitosMinimos]
    .filter(Boolean)
    .map((s) => stripHtml(s as string))
    .join("\n");
  const company = det?.ofertaConfidencial ? null : (det?.nombreEmpresaFantasia ?? o.nombreEmpresa ?? null);
  const jornada = det?.nombreJornada ?? o.nombreJornada ?? null;
  return {
    id: `trabajando:${o.idOferta}`,
    source: "trabajando",
    source_id: String(o.idOferta),
    country: "CL",
    url: `https://www.trabajando.cl/trabajo/${det?.slug ?? `${o.idOferta}-${slugify(o.nombreCargo)}`}`,
    title: o.nombreCargo.trim(),
    company,
    location,
    region: regionKey(location),
    modality: modalityOf(jornada),
    job_type: jornada,
    salary: det?.mostrarSueldo && det.sueldo ? det.sueldo : null,
    description,
    published_at: o.fechaPublicacion ?? null,
  };
}

export const trabajando: Source = async ({ maxPages, isKnown }) => {
  const jobs: NewJob[] = [];
  let invalid = 0;
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const data = Page.parse(
      await fetchJson(`https://www.trabajando.cl/api/searchjob?pagina=${page}&orden=FECHA_PUBLICACION`),
    );
    pages++;
    let fresh = 0;
    for (const raw of data.ofertas) {
      const id = Listed.safeParse(raw);
      if (!id.success) {
        invalid++;
        continue;
      }
      if (isKnown(`trabajando:${id.data.idOferta}`)) continue;
      let detail: unknown = null;
      try {
        detail = await fetchJson(`https://www.trabajando.cl/api/ofertas/${id.data.idOferta}`);
      } catch {
        // sin detalle: se guarda con el extracto del listado
      }
      const job = toJob(raw, detail);
      if (job) {
        jobs.push(job);
        fresh++;
      } else invalid++;
      await sleep(400);
    }
    if (fresh === 0 || page >= data.cantidadPaginas) break;
    await sleep(1000);
  }
  return { jobs, pages, invalid };
};

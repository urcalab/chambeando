import { config } from "./config.ts";
import { runCycle, sources } from "./cycle.ts";
import { openDb } from "./db.ts";
import { localEmbedder } from "./embed.ts";
import { ingest } from "./ingest.ts";

const db = openDb(config.dbPath);
const cmd = process.argv[2];
if (cmd === "ingest") console.log(JSON.stringify(await ingest(db, localEmbedder, sources(db)), null, 2));
else if (cmd === "run") console.log(JSON.stringify(await runCycle(db, localEmbedder), null, 2));
else if (cmd === "stats") {
  const { stats } = await import("./feedback.ts");
  console.log(JSON.stringify(stats(db, Number(process.argv[3]) || 7), null, 2));
} else if (cmd === "counts") {
  // Avisos activos que declara cada portal, para la lista de fuentes de la landing.
  const { JOBINT_SITES } = await import("./sources/jobint.ts");
  const { fetchJson } = await import("./sources/http.ts");
  const { readFileSync } = await import("node:fs");
  const out: Record<string, number> = {};
  for (const [key, site] of Object.entries(JOBINT_SITES)) {
    const page = (await fetchJson(`https://${site.domain}/api/avisos/searchV2?pageSize=1&page=0&sort=RECIENTES`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-site-id": site.siteId, referer: `https://${site.domain}/empleos.html` },
      body: JSON.stringify({ filtros: [] }),
    })) as { total: number };
    out[key] = page.total;
  }
  const t = (await fetchJson("https://www.trabajando.cl/api/searchjob?pagina=1&orden=FECHA_PUBLICACION")) as { cantidadRegistros: number };
  out.trabajando = t.cantidadRegistros;
  // Computrabajo: la suma de sus páginas de región, al momento de generar el archivo de regiones.
  const regions = JSON.parse(readFileSync(new URL("./sources/computrabajo-regions.json", import.meta.url), "utf8"));
  for (const [cc, site] of Object.entries(regions) as Array<[string, { regions: Array<{ count: number }> }]>) {
    out[`computrabajo-${cc}`] = site.regions.reduce((s, r) => s + r.count, 0);
  }
  console.log(JSON.stringify(out, null, 2));
} else {
  console.error("uso: node src/cli.ts ingest|run|counts|stats [días]");
  process.exit(1);
}

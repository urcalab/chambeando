// Genera src/sources/computrabajo-regions.json: por país, las páginas de región de Computrabajo
// que existen de verdad y cuántos avisos muestra cada una. Uso: node scripts/computrabajo-regions.ts
import { writeFileSync } from "node:fs";
import { fetchText, sleep } from "../src/sources/http.ts";
import { decodeEntities, normalize, slugify } from "../src/text.ts";

// Subdominio -> regiones candidatas además de las que el portal enlaza en su portada (que son solo las mayores).
const CANDIDATES: Record<string, string[]> = {
  ar: ["Capital Federal", "Buenos Aires-GBA", "Buenos Aires", "Córdoba", "Santa Fe", "Mendoza", "Tucumán", "Entre Ríos", "Salta", "Misiones", "Chaco", "Corrientes", "Santiago del Estero", "San Juan", "Jujuy", "Río Negro", "Neuquén", "Formosa", "Chubut", "San Luis", "Catamarca", "La Rioja", "La Pampa", "Santa Cruz", "Tierra del Fuego"],
  bo: ["La Paz", "Santa Cruz", "Cochabamba", "Oruro", "Potosí", "Chuquisaca", "Tarija", "Beni", "Pando"],
  cl: ["R.Metropolitana", "Región Metropolitana", "Valparaíso", "Biobío", "Maule", "Araucanía", "Libertador B. O'Higgins", "Los Lagos", "Coquimbo", "Antofagasta", "Ñuble", "Los Ríos", "Tarapacá", "Atacama", "Arica y Parinacota", "Magallanes", "Aysén"],
  co: ["Bogotá DC", "Antioquia", "Valle del Cauca", "Cundinamarca", "Atlántico", "Santander", "Risaralda", "Bolívar", "Caldas", "Tolima", "Meta", "Huila", "Norte de Santander", "Boyacá", "Quindío", "Magdalena", "Cesar", "Nariño", "Cauca", "Córdoba", "Casanare", "La Guajira", "Sucre"],
  cr: ["San José", "Alajuela", "Heredia", "Cartago", "Puntarenas", "Guanacaste", "Limón"],
  do: ["Distrito Nacional", "Santo Domingo", "Santiago", "La Altagracia", "San Cristóbal", "La Vega", "Puerto Plata", "La Romana"],
  ec: ["Pichincha", "Guayas", "Azuay", "Manabí", "El Oro", "Tungurahua", "Los Ríos", "Loja", "Imbabura", "Santo Domingo de los Tsáchilas", "Chimborazo", "Cotopaxi", "Esmeraldas", "Santa Elena"],
  gt: ["Guatemala", "Quetzaltenango", "Escuintla", "Sacatepéquez", "Alta Verapaz", "Chimaltenango", "Petén", "Izabal"],
  hn: ["Francisco Morazán", "Cortés", "Atlántida", "Choluteca", "Comayagua", "Yoro", "Copán"],
  mx: ["Ciudad de México", "Distrito Federal", "Estado de México", "Jalisco", "Nuevo León", "Puebla", "Guanajuato", "Querétaro", "Veracruz", "Chihuahua", "Baja California", "Coahuila", "Sonora", "Tamaulipas", "Sinaloa", "Michoacán", "Yucatán", "Quintana Roo", "San Luis Potosí", "Hidalgo", "Aguascalientes", "Morelos", "Chiapas", "Oaxaca", "Tabasco", "Guerrero", "Durango", "Zacatecas", "Tlaxcala", "Nayarit", "Colima", "Campeche", "Baja California Sur"],
  ni: ["Managua", "León", "Masaya", "Chinandega", "Granada", "Estelí", "Matagalpa"],
  pa: ["Panamá", "Panamá Oeste", "Colón", "Chiriquí", "Coclé", "Veraguas", "Herrera", "Los Santos"],
  pe: ["Lima", "Arequipa", "La Libertad", "Piura", "Lambayeque", "Cusco", "Junín", "Callao", "Ica", "Áncash", "Cajamarca", "Puno", "Loreto", "San Martín", "Tacna", "Ucayali", "Huánuco", "Ayacucho", "Moquegua", "Tumbes", "Apurímac", "Amazonas", "Pasco", "Huancavelica", "Madre de Dios"],
  py: ["Asunción", "Central", "Alto Paraná", "Itapúa", "Caaguazú", "Cordillera"],
  sv: ["San Salvador", "La Libertad", "Santa Ana", "San Miguel", "Sonsonate", "La Paz"],
  uy: ["Montevideo", "Canelones", "Maldonado", "Colonia", "Salto", "Paysandú", "San José"],
  ve: ["Distrito Capital", "Miranda", "Carabobo", "Zulia", "Aragua", "Lara", "Anzoátegui", "Bolívar", "Táchira", "Mérida", "Falcón", "Monagas", "Portuguesa", "Barinas", "Nueva Esparta", "Sucre", "Trujillo", "Yaracuy", "Guárico", "Cojedes", "Apure"],
};

// Páginas de región cuyo slug no sale del nombre ni aparece en la portada.
const EXTRA_SLUGS: Record<string, string[]> = { cl: ["rmetropolitana"] };

type Region = { slug: string; name: string; count: number };

/** El lugar y el total que la página de listado declara en su <h1>: "26.904 Ofertas de empleo en Bogotá, D.C.". */
function heading(html: string): { place: string; count: number } | null {
  const h1 = decodeEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const m = h1.match(/^([\d.,]+)\s+.*?\sen\s+(.+)$/);
  return m ? { count: Number(m[1]!.replace(/[.,]/g, "")), place: m[2]! } : null;
}

const out: Record<string, { prefix: string; regions: Region[] }> = {};
for (const [cc, names] of Object.entries(CANDIDATES)) {
  const base = `https://${cc}.computrabajo.com`;
  let home: string;
  try {
    home = await fetchText(`${base}/`);
  } catch (e) {
    console.error(cc, "portada:", (e as Error).message);
    continue;
  }
  // En la portada, las regiones son los enlaces con flecha; las ciudades van debajo, sin ella.
  const fromHome = [...home.matchAll(/<a href="\/((?:empleos|trabajo)-en-)([a-z0-9-]+)"[^>]*>\s*[^<]*<span class="arrowRight/g)];
  const prefix = fromHome[0]?.[1] ?? "empleos-en-";
  const slugs = new Map<string, boolean>(); // slug -> viene de la portada
  for (const m of fromHome) slugs.set(m[2]!, true);
  for (const slug of EXTRA_SLUGS[cc] ?? []) slugs.set(slug, true);
  for (const n of names) if (!slugs.has(slugify(n))) slugs.set(slugify(n), false);

  const regions: Region[] = [];
  const seenPlaces = new Set<string>();
  for (const [slug, trusted] of slugs) {
    await sleep(350);
    try {
      const html = await fetchText(`${base}/${prefix}${slug}?by=publicationtime`);
      const h = heading(html);
      if (!h || !html.includes("<article")) continue;
      // Un nombre adivinado puede caer en un pueblo homónimo ("Colombia, Huila"): se exige que el lugar sea el mismo.
      if (!trusted && normalize(h.place) !== normalize(slug)) continue;
      if (seenPlaces.has(normalize(h.place))) continue;
      seenPlaces.add(normalize(h.place));
      regions.push({ slug, name: h.place, count: h.count });
    } catch {
      // la página no existe
    }
  }
  regions.sort((a, b) => b.count - a.count);
  out[cc] = { prefix, regions };
  console.error(cc, prefix, regions.length, "regiones,", regions.reduce((s, r) => s + r.count, 0), "avisos");
}
writeFileSync(new URL("../src/sources/computrabajo-regions.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");

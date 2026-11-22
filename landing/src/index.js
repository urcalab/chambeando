// Sirve site/ y, en la portada, adapta lo que depende del país del visitante (request.cf.country,
// que Cloudflare resuelve por IP): el país primero en la tabla de fuentes, la ciudad del chat de ejemplo
// y la etiqueta del hero. La URL es la misma para todos.

export const GEO = {
  CL: { name: "Chile", city: "Santiago", place: "Providencia, Región Metropolitana" },
  MX: { name: "México", city: "Guadalajara", place: "Guadalajara, Jalisco" },
  PE: { name: "Perú", city: "Lima", place: "Miraflores, Lima" },
  CO: { name: "Colombia", city: "Medellín", place: "Medellín, Antioquia" },
};

const setGeo = (html, key, value) =>
  html.replace(new RegExp(`(<span data-geo="${key}">)[^<]*(</span>)`, "g"), `$1${value}$2`);

/** La portada para un país. Un país sin servicio (o desconocido) recibe la página tal cual. */
export function personalize(html, country) {
  const geo = GEO[country];
  if (!geo) return html;
  let out = setGeo(html, "city", geo.city);
  out = setGeo(out, "place", geo.place);
  out = setGeo(out, "badge", `Gratis · en ${geo.name}`);
  // La fila del país pasa al comienzo de la tabla.
  const row = out.match(new RegExp(`[ \\t]*<tr data-country="${country}">[\\s\\S]*?</tr>\\n?`));
  const body = out.indexOf("<tbody>");
  if (row && body >= 0) {
    out = out.replace(row[0], "");
    const at = out.indexOf("<tbody>") + "<tbody>".length;
    out = `${out.slice(0, at)}\n${row[0].replace(/\n?$/, "")}${out.slice(at)}`;
  }
  return out;
}

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const { pathname } = new URL(request.url);
    const type = res.headers.get("content-type") ?? "";
    if (pathname !== "/" || !res.ok || !type.includes("text/html")) return res;
    const country = request.cf?.country ?? "";
    const headers = new Headers(res.headers);
    // La respuesta cambia por país: que ningún caché intermedio la comparta.
    headers.set("cache-control", "private, max-age=0, must-revalidate");
    headers.delete("etag");
    headers.delete("content-length");
    return new Response(personalize(await res.text(), country), { status: res.status, headers });
  },
};

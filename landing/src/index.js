// Sirve site/ y, en la portada, adapta lo que depende del país del visitante (request.cf.country,
// que Cloudflare resuelve por IP): el país primero en la tabla de fuentes, la ciudad del chat de ejemplo
// y la etiqueta del hero. La URL es la misma para todos.

// Precio de Chambeando Pro: unos 5 USD llevados a un precio redondo en cada moneda
// (tipo de cambio del 22-11-2026: CLP 1.014, MXN 19,1, PEN 3,44, COP 3.342 por dólar).
export const GEO = {
  CL: { name: "Chile", city: "Santiago", place: "Providencia, Región Metropolitana", price: "$4.990" },
  MX: { name: "México", city: "Guadalajara", place: "Guadalajara, Jalisco", price: "$99 MXN" },
  PE: { name: "Perú", city: "Lima", place: "Miraflores, Lima", price: "S/ 16.90" },
  CO: { name: "Colombia", city: "Medellín", place: "Medellín, Antioquia", price: "$16.900 COP" },
};

const setGeo = (html, key, value) =>
  // Con una función y no con "$1...": un precio como "$16.900" se leería como el grupo $1.
  html.replace(new RegExp(`(<(span|b) data-geo="${key}">)[^<]*(</\\2>)`, "g"), (_m, open, _tag, close) => open + value + close);

/** La portada para un país. Un país sin servicio (o desconocido) recibe la página tal cual. */
export function personalize(html, country) {
  const geo = GEO[country];
  if (!geo) return html;
  let out = setGeo(html, "city", geo.city);
  out = setGeo(out, "place", geo.place);
  out = setGeo(out, "badge", `Gratis · en ${geo.name}`);
  out = setGeo(out, "price", geo.price);
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

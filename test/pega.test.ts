import assert from "node:assert/strict";
import { test } from "node:test";
import { now, openDb, toBlob } from "../src/db.ts";
import type { Embedder } from "../src/embed.ts";
import { parseVerdicts, type Judge } from "../src/llm.ts";
import { matchAll, passesFilters } from "../src/match.ts";
import { notifyAll, type Sender } from "../src/notify.ts";
import { parseListing, toJob as computrabajoJob } from "../src/sources/computrabajo.ts";
import { parseJobintDate, toJob as jobintJob } from "../src/sources/jobint.ts";
import { toJob as trabajandoJob } from "../src/sources/trabajando.ts";
import type { NewJob } from "../src/sources/types.ts";
import { createTools } from "../src/tools.ts";
import { countryOfPhone, modalityOf, normalizePhone, regionKey, regionOf } from "../src/text.ts";

test("regionKey reconoce los formatos de los dos portales", () => {
  assert.equal(regionKey("Providencia, Región Metropolitana"), "metropolitana");
  assert.equal(regionKey("Constitución, Región VII"), "maule");
  assert.equal(regionKey("Provincia de Antofagasta, Región II"), "antofagasta");
  assert.equal(regionKey("Santiago, Metropolitana de Santiago"), "metropolitana");
  assert.equal(regionKey("Rancagua, Lib. Gral. Bdo. O'Higgins"), "ohiggins");
  assert.equal(regionKey("Chillán, Ñuble"), "nuble");
  assert.equal(regionKey("Biobío"), "biobio");
  assert.equal(regionKey("los-rios"), "los-rios");
  assert.equal(regionKey("Madrid, Extranjero"), null);
  assert.equal(regionKey(null), null);
});

test("país por código del número y región fuera de Chile", () => {
  assert.equal(countryOfPhone("+56911112222"), "CL");
  assert.equal(countryOfPhone("+5491122223333"), "AR");
  assert.equal(countryOfPhone("+5215512345678"), "MX");
  assert.equal(countryOfPhone("+593991234567"), "EC");
  assert.equal(countryOfPhone("+5511912345678"), null);
  assert.equal(regionOf("PE", "Cercado De Lima, Lima"), "lima");
  assert.equal(regionOf("CL", "Constitución, Región VII"), "maule");
});

test("modalityOf", () => {
  assert.equal(modalityOf("Híbrido"), "hibrido");
  assert.equal(modalityOf("Mixta (Teletrabajo + Presencial)"), "hibrido");
  assert.equal(modalityOf("Teletrabajo"), "remoto");
  assert.equal(modalityOf("Jornada Completa"), null);
});

test("normalizePhone deja el mismo número con la misma clave", () => {
  assert.equal(normalizePhone("+56 9 1111 2222"), "+56911112222");
  assert.equal(normalizePhone("56911112222"), "+56911112222");
});

test("Laborum: convierte un aviso y descarta uno sin título", () => {
  assert.equal(parseJobintDate("20-11-2026 21:28:25"), "2026-11-20 21:28");
  const aviso = {
    id: 1118672242,
    titulo: "Técnico Educador Peluquería",
    detalle: "<p>Hola</p><p>Mundo</p>",
    empresa: "Confidencial",
    localizacion: "Providencia, Región Metropolitana",
    modalidadTrabajo: "Presencial",
    tipoTrabajo: "Full-time",
    fechaHoraPublicacion: "20-11-2026 21:28:25",
  };
  const job = jobintJob(aviso, "laborum");
  assert.equal(job?.id, "laborum:1118672242");
  assert.equal(job?.country, "CL");
  assert.equal(job?.url, "https://www.laborum.cl/empleos/tecnico-educador-peluqueria-1118672242.html");
  assert.equal(job?.company, null);
  assert.equal(job?.region, "metropolitana");
  assert.equal(job?.description, "Hola\nMundo");
  assert.equal(jobintJob({ id: 1 }, "laborum"), null);
  // El mismo formato en otro país: otro dominio, otro país y la provincia como región.
  const ar = jobintJob({ ...aviso, localizacion: "Canning, Buenos Aires" }, "bumeran-ar");
  assert.equal(ar?.id, "bumeran-ar:1118672242");
  assert.equal(ar?.country, "AR");
  assert.equal(ar?.source, "bumeran");
  assert.equal(ar?.region, "buenos aires");
  assert.match(ar!.url, /^https:\/\/www\.bumeran\.com\.ar\/empleos\//);
});

test("Trabajando: usa el detalle si viene y el listado si no", () => {
  const listed = {
    idOferta: 6152976,
    nombreCargo: "Analista de Cumplimiento",
    nombreEmpresa: "Fondo Esperanza",
    ubicacion: "Santiago, Metropolitana de Santiago",
    nombreJornada: "Jornada Completa",
    fechaPublicacion: "2026-11-20 22:27",
    descripcionOferta: "Extracto...",
  };
  const full = trabajandoJob(listed, {
    slug: "6152976-analista-de-cumplimiento",
    descripcionOferta: "<p>Completa</p>",
    mostrarSueldo: true,
    sueldo: 1100000,
    nombreJornada: "Mixta (Teletrabajo + Presencial)",
    ubicacion: { nombreRegion: "Metropolitana de Santiago", nombreComuna: "Santiago" },
  });
  assert.equal(full?.salary, 1100000);
  assert.equal(full?.modality, "hibrido");
  assert.equal(full?.description, "Completa");
  const bare = trabajandoJob(listed, null);
  assert.equal(bare?.url, "https://www.trabajando.cl/trabajo/6152976-analista-de-cumplimiento");
  assert.equal(bare?.description, "Extracto...");
  assert.equal(bare?.salary, null);
  // Sueldo oculto por la empresa: no se guarda.
  assert.equal(trabajandoJob(listed, { mostrarSueldo: false, sueldo: 5 })?.salary, null);
});

test("Computrabajo: lee el listado HTML y el JSON-LD del aviso", () => {
  const listing = `<div><article class="box_offer" data-id='74C2C0B04F7E027161373E686DCF3405' id="x">
    <h2><a class="js-o-link fc_base" href="/ofertas-de-trabajo/oferta-de-trabajo-de-asesor-74C2C0B04F7E027161373E686DCF3405#lc=ListOffers-Score-0">
      Asesor / Atenci&#xF3;n al cliente </a></h2></article><article class="otro"><p>sin enlace</p></article></div>`;
  const items = parseListing(listing);
  assert.deepEqual(items, [{
    id: "74C2C0B04F7E027161373E686DCF3405",
    path: "/ofertas-de-trabajo/oferta-de-trabajo-de-asesor-74C2C0B04F7E027161373E686DCF3405",
    title: "Asesor / Atención al cliente",
  }]);
  const detail = `<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      description: "Funciones:<br/>Atenci&#243;n al cliente",
      datePosted: "2026-11-21",
      employmentType: "FULL_TIME",
      jobLocation: { address: { addressLocality: "Sincelejo", addressRegion: "Sincelejo" } },
      baseSalary: { value: { value: 3000000, unitText: "MONTH" } },
      hiringOrganization: { name: "ACTIVOS S A S" },
    })}</script>`;
  const job = computrabajoJob("computrabajo-co", "sucre", items[0]!, detail);
  assert.equal(job?.id, "computrabajo-co:74C2C0B04F7E027161373E686DCF3405");
  assert.equal(job?.country, "CO");
  assert.equal(job?.region, "sucre");
  assert.equal(job?.location, "Sincelejo");
  assert.equal(job?.salary, 3000000);
  assert.equal(job?.description, "Funciones:\nAtención al cliente");
  assert.match(job!.url, /^https:\/\/co\.computrabajo\.com\/ofertas-de-trabajo\//);
  assert.equal(computrabajoJob("computrabajo-co", "sucre", items[0]!, "<html>sin datos</html>"), null);
  // Sin JSON-LD, el aviso entra con lo que trae el HTML.
  const plain = `<h1>Asesor</h1><p class="fs16">Importante empresa del sector - Santa Marta, Magdalena</p>
    <div class="mb40" div-link="oferta"><div class="mbB"><span>A convenir</span></div><p class="mbB">Ruta de ventas.<br />Lunes a s&#xE1;bado</p></div>`;
  const fromHtml = computrabajoJob("computrabajo-co", "magdalena", items[0]!, plain);
  assert.equal(fromHtml?.description, "Ruta de ventas.\nLunes a sábado");
  assert.equal(fromHtml?.company, null);
  assert.equal(fromHtml?.location, "Santa Marta, Magdalena");
  assert.equal(fromHtml?.region, "magdalena");
  // Un href con entidades no se corta en el "#" de la entidad.
  const odd = parseListing(`<article data-id='AAAAAAAAAAAAAAAA1234'><a class="js-o-link" href="/ofertas-de-trabajo/oferta-348807&#x2B;bogot&#xE1;-AAAA#lc=x">T</a></article>`);
  assert.equal(odd[0]?.path, "/ofertas-de-trabajo/oferta-348807+bogot%C3%A1-AAAA");
  assert.equal(computrabajoJob("computrabajo-co", "bogota-dc", items[0]!, detail)?.region, "bogota");
  assert.equal(regionOf("CO", "Bogotá, D.C."), "bogota");
  assert.equal(countryOfPhone("+573001234567"), "CO");
});

test("passesFilters solo descarta por lo que el aviso dice", () => {
  const user = { regions: ["metropolitana"], modalities: [], min_salary: 900000, exclude: ["call center"] };
  const job = { title: "Contador", region: "metropolitana", modality: null, salary: null };
  assert.equal(passesFilters(user, job), true);
  assert.equal(passesFilters(user, { ...job, region: "biobio" }), false);
  assert.equal(passesFilters(user, { ...job, region: "biobio", modality: "remoto" }), true);
  assert.equal(passesFilters(user, { ...job, region: null }), true);
  assert.equal(passesFilters(user, { ...job, salary: 600000 }), false);
  assert.equal(passesFilters(user, { ...job, title: "Ejecutivo Call Center" }), false);
  assert.equal(passesFilters({ ...user, modalities: ["remoto"] }, { ...job, modality: "presencial" }), false);
});

test("parseVerdicts tolera texto alrededor del JSON y avisos que faltan", () => {
  const v = parseVerdicts('Claro:\n```json\n{"avisos":[{"n":2,"sirve":true,"motivo":"calza"}]}\n```', 3);
  assert.deepEqual(v.map((x) => x.ok), [false, true, false]);
  assert.throws(() => parseVerdicts("no sé", 1));
});

// Embeddings de mentira: un eje por palabra clave, para que el orden sea predecible.
const AXES = ["contador", "enfermera", "vendedor"];
const fakeEmbed: Embedder = async (texts) =>
  texts.map((t) => {
    const v = new Float32Array(AXES.map((a) => (t.toLowerCase().includes(a) ? 1 : 0.01)));
    const norm = Math.hypot(...v);
    return v.map((x) => x / norm);
  });

async function addJob(db: ReturnType<typeof openDb>, over: Partial<NewJob> & { id: string; title: string }, seenAt = now()) {
  const country = over.country ?? "CL";
  const [vec] = await fakeEmbed([over.title], "passage");
  db.prepare(
    `INSERT INTO jobs (id, source, source_id, country, url, title, company, location, region, modality, job_type, salary,
                       description, published_at, first_seen_at, embedding)
     VALUES (?, 'laborum', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '', NULL, ?, ?)`,
  ).run(
    over.id, over.id, country, `https://x/${over.id}`, over.title, over.company ?? null, over.location ?? null,
    over.region === undefined ? (country === "CL" ? "metropolitana" : null) : over.region, over.modality ?? null, over.salary ?? null, seenAt, toBlob(vec!),
  );
}

const approveAll: Judge = async (_u, _p, jobs) => jobs.map(() => ({ ok: true, reason: "" }));

test("flujo completo: registro, match de avisos nuevos, envío, opinión y borrado", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "a", title: "Contador general" });
  await addJob(db, { id: "b", title: "Enfermera clínica" });
  await addJob(db, { id: "c", title: "Contador senior", region: "biobio" });
  const tools = createTools(db, fakeEmbed, async (_u, _p, jobs) =>
    jobs.map((j) => ({ ok: j.title.includes("Contador"), reason: "" })),
  );
  const phone = "+56911112222";

  await assert.rejects(tools.buscar_avisos({ phone }), /todavía no ha dicho/);

  const saved = await tools.guardar_preferencias({ phone, resumen: "busco de contador", regiones: ["Región Metropolitana"] });
  assert.equal(saved.nuevo, true);
  assert.deepEqual(saved.preferencias.regiones, ["metropolitana"]);
  // Solo el contador de la RM: el de Biobío cae por región y la enfermera por el modelo.
  assert.deepEqual(saved.avisos.map((a) => a.id), ["a"]);

  // Actualizar un campo conserva los demás.
  const updated = await tools.guardar_preferencias({ phone, sueldo_minimo: 800000 });
  assert.equal(updated.nuevo, false);
  assert.equal(updated.preferencias.resumen, "busco de contador");
  assert.deepEqual(updated.avisos, []);

  // Llegan avisos nuevos: uno calza, otro paga menos del mínimo, otro es de otra profesión.
  await new Promise((r) => setTimeout(r, 5));
  await addJob(db, { id: "d", title: "Contador tributario" });
  await addJob(db, { id: "e", title: "Contador junior", salary: 500000 });
  await addJob(db, { id: "f", title: "Vendedor de tienda" });
  const judged: string[] = [];
  const judge: Judge = async (_u, _p, jobs) =>
    jobs.map((j) => {
      judged.push(j.id);
      return { ok: j.title.includes("Contador"), reason: "calza" };
    });
  const matched = await matchAll(db, judge);
  assert.equal(matched.pending, 1);
  assert.deepEqual(judged.sort(), ["d", "f"]);
  // Una segunda corrida sin avisos nuevos no vuelve a evaluar nada.
  judged.length = 0;
  assert.equal((await matchAll(db, judge)).pending, 0);
  assert.deepEqual(judged, []);

  // Ventana abierta: va como texto y queda enviado.
  const sentTexts: string[] = [];
  const open: Sender = async (m) => {
    sentTexts.push(m.text);
    return { status: 202, mode: "text" };
  };
  const n1 = await notifyAll(db, open);
  assert.equal(n1.sent, 1);
  assert.match(sentTexts[0]!, /Contador tributario/);
  assert.equal((await notifyAll(db, open)).sent, 0);

  await tools.registrar_opinion({ phone, aviso_id: "d", util: false, motivo: "piden inglés" });
  await assert.rejects(tools.registrar_opinion({ phone, aviso_id: "zzz", util: true }), /No le hemos mandado/);

  // Ventana cerrada: una sola plantilla por día y el aviso sigue pendiente hasta que la persona responde.
  await new Promise((r) => setTimeout(r, 5));
  await addJob(db, { id: "g", title: "Contador de costos" });
  await matchAll(db, approveAll);
  const calls: Array<{ template: boolean }> = [];
  const closed: Sender = async (m) => {
    calls.push({ template: Boolean(m.template) });
    return m.template ? { status: 202, mode: "template" } : { status: 422, code: "outside_window" };
  };
  assert.equal((await notifyAll(db, closed)).template, 1);
  assert.deepEqual(calls, [{ template: false }, { template: true }]);
  assert.equal((await notifyAll(db, closed)).outside_window, 1);
  assert.equal(calls.filter((c) => c.template).length, 1);
  const pending = await tools.avisos_pendientes({ phone });
  assert.deepEqual(pending.avisos.map((a) => a.id), ["g"]);
  assert.deepEqual((await tools.avisos_pendientes({ phone })).avisos, []);

  // En pausa no se evalúa ni se manda nada.
  await tools.pausar_avisos({ phone, pausar: true });
  await new Promise((r) => setTimeout(r, 5));
  await addJob(db, { id: "h", title: "Contador auditor" });
  assert.equal((await matchAll(db, approveAll)).users, 0);

  assert.deepEqual(await tools.borrar_mis_datos({ phone }), { borrado: true });
  const left = db.prepare("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM deliveries) AS n").get() as { n: number };
  assert.equal(left.n, 0);
});

test("un aviso republicado con otro id se muestra una sola vez", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "r1", title: "Vendedor - Osorno", company: "Acme", location: "Osorno" });
  await addJob(db, { id: "r2", title: "Vendedor - Osorno", company: "Acme", location: "Osorno" });
  await addJob(db, { id: "r3", title: "Vendedor - Osorno", company: "Otra", location: "Osorno" });
  const tools = createTools(db, fakeEmbed, null);
  const saved = await tools.guardar_preferencias({ phone: "+56900000009", resumen: "vendedor" });
  assert.equal(saved.avisos.length, 2);
});

test("cada persona solo recibe avisos de su país", async () => {
  const db = openDb(":memory:");
  await addJob(db, { id: "cl", title: "Vendedor Santiago" });
  await addJob(db, { id: "ar1", title: "Vendedor Canning", country: "AR", region: "buenos aires" });
  await addJob(db, { id: "ar2", title: "Vendedor Rosario", country: "AR", region: "santa fe" });
  const tools = createTools(db, fakeEmbed, null);
  const ar = await tools.guardar_preferencias({ phone: "+5491122223333", resumen: "vendedor", regiones: ["Buenos Aires"] });
  assert.equal(ar.preferencias.pais, "Argentina");
  assert.deepEqual(ar.avisos.map((a) => a.id), ["ar1"]);
  // Un número de un país que no atendemos necesita decir dónde busca.
  await assert.rejects(tools.guardar_preferencias({ phone: "+5511912345678", resumen: "vendedor" }), /Países disponibles/);
  const co = await tools.guardar_preferencias({ phone: "+5511912345678", resumen: "vendedor", pais: "Chile" });
  assert.deepEqual(co.avisos.map((a) => a.id), ["cl"]);
});

test("si el modelo falla, los avisos se reintentan en la próxima corrida", async () => {
  const db = openDb(":memory:");
  const tools = createTools(db, fakeEmbed, null);
  await tools.guardar_preferencias({ phone: "+56900000000", resumen: "enfermera" });
  await new Promise((r) => setTimeout(r, 5));
  await addJob(db, { id: "x", title: "Enfermera UCI" });
  const failed = await matchAll(db, async () => {
    throw new Error("timeout");
  });
  assert.equal(failed.errors.length, 1);
  assert.equal((await matchAll(db, approveAll)).pending, 1);
});

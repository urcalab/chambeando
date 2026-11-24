import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import worker, { personalize } from "./src/index.js";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const order = (h) => [...h.matchAll(/<tr data-country="(\w+)">/g)].map((m) => m[1]);

test("la portada pone primero el país del visitante y usa su ciudad", () => {
  assert.deepEqual(order(html), ["CL", "MX", "PE", "CO"]);
  const pe = personalize(html, "PE");
  assert.deepEqual(order(pe), ["PE", "CL", "MX", "CO"]);
  assert.match(pe, /<span data-geo="city">Lima<\/span>/);
  assert.match(pe, /<span data-geo="place">Miraflores, Lima<\/span>/);
  assert.match(pe, /<b data-geo="price">S\/ 16\.90<\/b>/);
  assert.match(personalize(html, "CL"), /<b data-geo="price">\$4\.990<\/b>/);
  assert.match(html, /<b data-geo="price">USD 5<\/b>/);
  assert.match(personalize(html, "CO"), /<b data-geo="price">\$16\.900 COP<\/b>/);
  assert.match(personalize(html, "MX"), /<b data-geo="price">\$99 MXN<\/b>/);
  assert.equal(personalize(html, "CL").length > 0, true);
  assert.deepEqual(order(personalize(html, "CO")), ["CO", "CL", "MX", "PE"]);
});

test("un país sin servicio recibe la página sin cambios", () => {
  assert.equal(personalize(html, "AR"), html);
  assert.equal(personalize(html, ""), html);
});

test("los links de avisos en chambeando.app van al backend, sin seguir la redirección", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (req) => {
    seen.push(req);
    return new Response(null, { status: 302, headers: { location: "https://portal.example/aviso" } });
  };
  try {
    const request = new Request("https://chambeando.app/r/sjrr3muj6z?x=1", {
      headers: { "user-agent": "WhatsApp/2", "cf-connecting-ip": "203.0.113.7", cookie: "s=1" },
    });
    const res = await worker.fetch(request, { ASSETS: { fetch: () => assert.fail("un link no es parte de la landing") } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://portal.example/aviso");
    assert.equal(seen[0].url, "https://chambeando.urcalab.com/r/sjrr3muj6z?x=1");
    assert.equal(seen[0].redirect, "manual");
    assert.equal(seen[0].headers.get("user-agent"), "WhatsApp/2");
    assert.equal(seen[0].headers.get("x-forwarded-for"), "203.0.113.7");
    assert.equal(seen[0].headers.get("cookie"), null);
  } finally {
    globalThis.fetch = original;
  }
});

// Live contract check, run offline against the captured public schemas.
// Since 2026-11-11 the GIF-only frame_count / frame_duration_ms fields carry no
// schema `default` (clients that fill defaults would otherwise send them with
// png output); the omitted values live only in the field descriptions.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkLiveContract } from "../scripts/lib/api.mjs";

const read = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const captured = read("schemas-2026-11-06.json").schemas;
const pricing = read("pricing-2026-11-06.json");
const promotions = read("promotions-2026-11-06.json");

/** The captured schemas as served today: no default on the two frame fields. */
function liveSchemas(mutate) {
  const schemas = structuredClone(captured);
  for (const schema of Object.values(schemas)) {
    for (const key of ["frame_count", "frame_duration_ms"]) {
      if (schema.properties[key]) delete schema.properties[key].default;
    }
  }
  mutate?.(schemas);
  return schemas;
}

function fakeFetch(schemas) {
  return async (url) => {
    const { pathname, searchParams } = new URL(url);
    let body;
    if (pathname === "/api/models/content") {
      const schema = schemas[searchParams.get("name")];
      body = schema ? { data: { input_schema: schema } } : null;
    } else if (pathname === "/api/pricing") body = pricing;
    else if (pathname === "/api/promotions") body = promotions;
    return new Response(body ? JSON.stringify(body) : "not found", { status: body ? 200 : 404 });
  };
}

const T2I = ["gpt-image-2.6-flare/text-to-image", "gpt-image-2.6-sunburst/text-to-image"];
const problemsOf = (result) => result.checks.filter((c) => T2I.includes(c.model)).flatMap((c) => c.problems);

test("the frame fields without a schema default pass the live contract check", async () => {
  const result = await checkLiveContract({ fetchImpl: fakeFetch(liveSchemas()) });
  assert.deepEqual(result.checks.flatMap((c) => c.problems), []);
});

test("a frame default reappearing in the schema is reported", async () => {
  const schemas = liveSchemas((all) => {
    for (const model of T2I) all[model].properties.frame_count.default = 9;
  });
  const problems = problemsOf(await checkLiveContract({ fetchImpl: fakeFetch(schemas) }));
  assert.equal(problems.filter((p) => p.startsWith("frame_count.default = 9")).length, 2);
});

test("a description that stops promising the local estimate defaults is reported", async () => {
  const schemas = liveSchemas((all) => {
    for (const model of T2I) {
      all[model].properties.frame_count.description = "GIF only. Number of frames, integer 2-16. Omitted uses 12.";
      all[model].properties.frame_duration_ms.description = "GIF only. Duration of each frame in milliseconds.";
    }
  });
  const problems = problemsOf(await checkLiveContract({ fetchImpl: fakeFetch(schemas) }));
  assert.equal(problems.filter((p) => p.includes('no longer says "Omitted uses 9."')).length, 2);
  assert.equal(problems.filter((p) => p.includes('no longer says "Omitted uses 200."')).length, 2);
});

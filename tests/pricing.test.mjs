import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  enforceMaxCost,
  estimatePayload,
  fetchPromotions,
  referenceAddonUsd,
  resolvePromotion,
  ruleMatches,
  selectPolicy,
} from "../scripts/lib/pricing.mjs";
import { buildPayload } from "../scripts/lib/payload.mjs";

const pricing = JSON.parse(readFileSync(new URL("./fixtures/pricing-2026-11-06.json", import.meta.url), "utf8"));
const promotionsFixture = JSON.parse(readFileSync(new URL("./fixtures/promotions-2026-11-06.json", import.meta.url), "utf8"));
const rows = pricing.rows;
const rowFor = (model) => rows.find((row) => row.model_name === model);
const PROMO = {
  slug: "gpt-image-2-6-family-launch-8-fold",
  start_at: 1793973600,
  end_at: 1794578400,
  paused: false,
  activity_type: "model_promotion",
  execution_mode: "live",
  rule_config: {
    model_ids: [
      "gpt-image-2.6-flare/text-to-image",
      "gpt-image-2.6-flare/image-to-image",
      "gpt-image-2.6-sunburst/text-to-image",
      "gpt-image-2.6-sunburst/image-to-image",
    ],
    benefit: { type: "percentage_discount", price_multiplier_bps: 8000 },
    audience: { mode: "all" },
  },
  active_version: 2,
};

function fetchStub({ pricingRows = rows, promotions = promotionsFixture.items, failPricing = false, failPromotions = false } = {}) {
  return async (url) => {
    const text = String(url);
    if (text.includes("/api/pricing")) {
      if (failPricing) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify({ data: pricingRows }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (text.includes("/api/promotions")) {
      if (failPromotions) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify({ data: promotions }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

test("the most specific rule wins: svg rows beat plain quality×resolution rows", () => {
  const row = rowFor("gpt-image-2.6-flare/text-to-image");
  const plain = selectPolicy(row, { quality: "low", resolution: "1K", output_format: "png" });
  const svg = selectPolicy(row, { quality: "low", resolution: "1K", output_format: "svg" });
  assert.equal(plain.ruleName, "LOW, 1K");
  assert.equal(plain.unitUsd, 0.023);
  assert.equal(svg.ruleName, "SVG, LOW, 1K");
  assert.equal(svg.unitUsd, 0.053);
  assert.equal(svg.ruleKeys, 3);
});

test("gif rules match an array of resolutions", () => {
  const row = rowFor("gpt-image-2.6-sunburst/text-to-image");
  for (const resolution of ["1K", "2K", "4K"]) {
    const selected = selectPolicy(row, { quality: "high", resolution, output_format: "gif" });
    assert.match(selected.ruleName, /GIF, HIGH/);
    assert.equal(selected.unitUsd, 0.15, `${resolution} GIF bills the same`);
  }
  // A gif rule must not be selected for a png request.
  assert.doesNotMatch(selectPolicy(row, { quality: "high", resolution: "1K", output_format: "png" }).ruleName, /GIF/);
});

test("a rule with a missing payload key never matches", () => {
  assert.equal(ruleMatches({ quality: { match: "low" }, resolution: { match: "1K" } }, { quality: "low" }), false);
  assert.equal(ruleMatches({ quality: { match: "low" } }, { quality: "LOW" }), true, "match is case-insensitive");
  assert.equal(ruleMatches({}, {}), false);
  assert.equal(ruleMatches({ resolution: { match: ["1K", "2K"] } }, { resolution: "2K" }), true);
});

test("every quality×resolution combination has a price for all four models", () => {
  for (const row of rows) {
    for (const quality of ["low", "medium", "high", "xhigh", "max"]) {
      for (const resolution of ["1K", "2K", "4K"]) {
        const selected = selectPolicy(row, { quality, resolution, output_format: "png" });
        assert.ok(selected.unitUsd > 0, `${row.model_name} ${quality} ${resolution}`);
        assert.equal(selected.ruleKeys, 2);
      }
    }
  }
});

test("image-to-image rows carry the $0.012 reference-image addon", () => {
  assert.equal(referenceAddonUsd(rowFor("gpt-image-2.6-flare/image-to-image")), 0.012);
  assert.equal(referenceAddonUsd(rowFor("gpt-image-2.6-sunburst/image-to-image")), 0.012);
  assert.equal(referenceAddonUsd(rowFor("gpt-image-2.6-flare/text-to-image")), null);
});

test("estimate totals list price plus addon, then applies the promotion", async () => {
  const payload = buildPayload({
    prompt: "edit",
    imageSources: ["https://x/a.png", "https://x/b.png"],
    quality: "high",
  }).payload;
  const estimate = await estimatePayload(payload, { fetchImpl: fetchStub(), now: () => 1794100000000 });
  assert.equal(estimate.listUsd, 0.049);
  assert.equal(estimate.referenceAddonUsd, 0.012);
  assert.equal(estimate.referenceAddonTotalUsd, 0.024);
  assert.equal(estimate.breakdown.subtotalUsd, 0.073);
  assert.equal(estimate.promotion.slug, "gpt-image-2-6-family-launch-8-fold");
  assert.equal(estimate.promotion.percentOff, 20);
  assert.equal(estimate.estimatedUsd, 0.0584);
  assert.equal(estimate.ruleName, "HIGH, 1K");
});

test("estimate without an active promotion uses the list price and says why", async () => {
  const payload = buildPayload({ prompt: "p", quality: "low" }).payload;
  const estimate = await estimatePayload(payload, {
    fetchImpl: fetchStub({ promotions: [] }),
    now: () => 1794100000000,
  });
  assert.equal(estimate.promotion, null);
  assert.equal(estimate.estimatedUsd, 0.023);
  assert.equal(estimate.promotionNote, null);
});

test("an expired or paused promotion is ignored", async () => {
  const payload = buildPayload({ prompt: "p", quality: "low" }).payload;
  for (const mutate of [
    (items) => items.map((item) => ({ ...item, end_at: 1 })),
    (items) => items.map((item) => ({ ...item, start_at: 1800000000 })),
    (items) => items.map((item) => ({ ...item, paused: true })),
    (items) => items.map((item) => ({ ...item, execution_mode: "config_only" })),
    (items) => items.map((item) => ({ ...item, rule_config: { ...item.rule_config, benefit: { type: "percentage_discount", price_multiplier_bps: 10000 } } })),
    (items) => items.map((item) => ({ ...item, rule_config: { ...item.rule_config, audience: { mode: "invited" } } })),
  ]) {
    const estimate = await estimatePayload(payload, {
      fetchImpl: fetchStub({ promotions: mutate([PROMO]) }),
      now: () => 1794100000000,
    });
    assert.equal(estimate.promotion, null);
    assert.equal(estimate.estimatedUsd, 0.023);
  }
});

test("two conflicting all-user promotions fall back to list price", () => {
  const resolved = resolvePromotion([PROMO, { ...PROMO, slug: "other" }], "gpt-image-2.6-flare/text-to-image", 1794100000);
  assert.equal(resolved.promotion, null);
  assert.match(resolved.note, /conflicting promotions/);
});

test("promotion lookup failure keeps the estimate and marks it", async () => {
  const payload = buildPayload({ prompt: "p", quality: "low" }).payload;
  const estimate = await estimatePayload(payload, {
    fetchImpl: fetchStub({ failPromotions: true }),
    now: () => 1794100000000,
  });
  assert.equal(estimate.estimatedUsd, 0.023, "list price, no discount invented");
  assert.match(estimate.promotionNote, /promotion lookup unavailable/);
});

test("pricing lookup failure returns an estimate error instead of throwing", async () => {
  const payload = buildPayload({ prompt: "p" }).payload;
  const estimate = await estimatePayload(payload, { fetchImpl: fetchStub({ failPricing: true }) });
  assert.match(estimate.error, /Pricing lookup failed/);
  assert.equal(estimate.estimatedUsd, null);
  assert.equal(estimate.unverified, true);
});

test("a model missing from pricing is an explicit error", async () => {
  const payload = buildPayload({ prompt: "p" }).payload;
  const estimate = await estimatePayload(payload, {
    fetchImpl: fetchStub({ pricingRows: rows.filter((row) => !row.model_name.includes("flare/text")) }),
  });
  assert.match(estimate.error, /does not list gpt-image-2\.6-flare\/text-to-image/);
});

test("--max-cost blocks when the estimate exceeds the limit", async () => {
  const payload = buildPayload({ prompt: "p", quality: "high" }).payload;
  const estimate = await estimatePayload(payload, { fetchImpl: fetchStub(), now: () => 1794100000000 });
  const blocked = enforceMaxCost(estimate, 0.01);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /exceeds --max-cost/);
  const allowed = enforceMaxCost(estimate, 1);
  assert.equal(allowed.allowed, true);
});

test("--max-cost blocks when the estimate failed, and is ignored without a limit", async () => {
  const payload = buildPayload({ prompt: "p", quality: "low" }).payload;
  const failed = await estimatePayload(payload, { fetchImpl: fetchStub({ failPricing: true }) });
  const blocked = enforceMaxCost(failed, 5);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /Estimate unavailable/);
  assert.equal(enforceMaxCost(failed, null).allowed, true, "no limit means an estimate failure is only informational");
});

test("--max-cost validates its own value", () => {
  assert.throws(() => enforceMaxCost({ estimatedUsd: 1 }, -1), /non-negative/);
  assert.throws(() => enforceMaxCost({ estimatedUsd: 1 }, "lots"), /non-negative/);
  assert.equal(enforceMaxCost({ estimatedUsd: 0.05 }, 0.05).allowed, true, "the limit is inclusive");
});

test("an unknown option combination falls back to the base rate with a note", () => {
  const row = rowFor("gpt-image-2.6-flare/text-to-image");
  const selected = selectPolicy(row, { quality: "impossible", resolution: "1K" });
  assert.equal(selected.policy, null);
  assert.equal(selected.unitUsd, row.base_usd_value);
  assert.match(selected.note, /bills the base rate/);
});

test("promotions payload without a data array is reported, not guessed", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ data: null }), { status: 200 });
  const result = await fetchPromotions({ fetchImpl });
  assert.equal(result.ok, false);
});

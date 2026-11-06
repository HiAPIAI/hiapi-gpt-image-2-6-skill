// Estimate from live public pricing + promotions.
//
// Rule matching mirrors the MCP server and the backend:
//  - a policy row matches when every key in its `rule` equals the payload
//    value (`match` may be a scalar or an array — GIF rows list all three
//    resolutions);
//  - the rule with the MOST keys wins (the SVG rows add `output_format`, so
//    they beat the plain quality×resolution rows);
//  - promotions multiply the total (rule_config.benefit.price_multiplier_bps).
import {
  DEFAULT_SITE_URL,
  HIAPI_PRICING_URL,
  REFERENCE_IMAGE_ADDON_USD,
  SkillError,
} from "./contract.mjs";

export const PRICING_TIMEOUT_MS = 6000;

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = PRICING_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    try {
      return { ok: true, body: text ? JSON.parse(text) : null };
    } catch {
      return { ok: false, error: "invalid JSON" };
    }
  } catch (error) {
    return { ok: false, error: error?.name === "AbortError" ? "timeout" : error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function siteUrl(options = {}) {
  return String(options.siteUrl || options.env?.HIAPI_SITE_URL || process.env.HIAPI_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, "");
}

export async function fetchPricingRows(options = {}) {
  const url = `${siteUrl(options)}/api/pricing`;
  const result = await fetchJson(url, options);
  if (!result.ok) throw new SkillError(`Pricing lookup failed: ${result.error}`, { code: "PRICING_UNAVAILABLE" });
  const rows = Array.isArray(result.body?.data) ? result.body.data : [];
  if (!rows.length) throw new SkillError("Pricing lookup returned no rows.", { code: "PRICING_UNAVAILABLE" });
  return rows;
}

function valueMatches(actual, match) {
  if (Array.isArray(match)) return match.some((item) => valueMatches(actual, item));
  if (typeof actual === "string" && typeof match === "string") return actual.toLowerCase() === match.toLowerCase();
  if (typeof actual === "number" && typeof match === "string" && match.trim()) return actual === Number(match);
  return actual === match;
}

/** Every rule key must match the payload; a missing key makes the rule not apply. */
export function ruleMatches(rule, input) {
  if (!rule || typeof rule !== "object") return false;
  const entries = Object.entries(rule);
  if (!entries.length) return false;
  return entries.every(([key, condition]) => {
    if (!condition || typeof condition !== "object") return false;
    const payloadValue = key === "reference_video" ? false : input[key];
    if (payloadValue === undefined) return false;
    return valueMatches(payloadValue, condition.match);
  });
}

export function selectPolicy(row, input) {
  const policies = Array.isArray(row?.policies) ? row.policies : [];
  const hits = policies
    .map((policy) => ({ policy, keys: Object.keys(policy?.rule || {}).length, matches: ruleMatches(policy?.rule, input) }))
    .filter((entry) => entry.matches);
  if (!hits.length) {
    const unit = Number(row?.base_usd_value);
    return {
      policy: null,
      unitUsd: Number.isFinite(unit) ? unit : null,
      ruleName: null,
      note: "no pricing rule matched the selected inputs; HiAPI bills the base rate",
    };
  }
  const maxKeys = Math.max(...hits.map((entry) => entry.keys));
  const best = hits.filter((entry) => entry.keys === maxKeys);
  const prices = best.map((entry) => Number(entry.policy.usd_value)).filter((value) => Number.isFinite(value));
  const unitUsd = prices.length ? Math.max(...prices) : null;
  return {
    policy: best[0].policy,
    unitUsd,
    ruleName: best.map((entry) => entry.policy.name).filter(Boolean).join(" | "),
    ruleKeys: maxKeys,
    candidates: best.length,
  };
}

export function referenceAddonUsd(row) {
  const addons = Array.isArray(row?.addons) ? row.addons : [];
  for (const addon of addons) {
    if (addon?.path === "image_urls" && addon?.type === "array_length") {
      const unit = Number(addon.unit_price);
      if (Number.isFinite(unit) && unit > 0) return unit;
    }
  }
  return null;
}

/**
 * Active percentage promotion for one model, mirroring the backend selector:
 * published model_promotion in live mode, unpaused, inside [start_at, end_at),
 * listed by the exact model name, percentage_discount in (0, 10000) bps.
 * Conflicting all-user promotions mean no discount is applied.
 */
export function resolvePromotion(items, modelName, nowSeconds) {
  if (!Array.isArray(items)) {
    return { available: false, note: "promotion lookup unavailable; estimate uses list price" };
  }
  const matched = [];
  for (const item of items) {
    if (!item || item.activity_type !== "model_promotion" || item.execution_mode !== "live") continue;
    if (item.paused === true) continue;
    if (Number(item.active_version ?? 0) <= 0) continue;
    const startAt = Number(item.start_at);
    const endAt = Number(item.end_at);
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) continue;
    if (startAt > nowSeconds || nowSeconds >= endAt) continue;
    const rule = item.rule_config || {};
    const modelIds = Array.isArray(rule.model_ids) ? rule.model_ids.map(String) : [];
    if (!modelIds.includes(modelName)) continue;
    const benefit = rule.benefit || {};
    const bps = Number(benefit.price_multiplier_bps);
    if (benefit.type !== "percentage_discount") continue;
    if (!Number.isFinite(bps) || bps <= 0 || bps >= 10000) continue;
    matched.push({ slug: String(item.slug ?? ""), bps, endAt, audienceAll: (rule.audience || {}).mode === "all" });
  }
  if (!matched.length) return { available: true, promotion: null };
  const allUsers = matched.filter((item) => item.audienceAll);
  if (!allUsers.length) return { available: true, promotion: null, note: "a promotion may apply to eligible accounts; estimate uses list price" };
  if (allUsers.length > 1) {
    return {
      available: true,
      promotion: null,
      note: "multiple live promotions matched this model; HiAPI refuses conflicting promotions, so the estimate uses list price",
    };
  }
  const hit = allUsers[0];
  return {
    available: true,
    promotion: {
      slug: hit.slug,
      multiplierBps: hit.bps,
      multiplier: hit.bps / 10000,
      percentOff: Number(((10000 - hit.bps) / 100).toFixed(2)),
      endsAt: new Date(hit.endAt * 1000).toISOString(),
    },
  };
}

export async function fetchPromotions(options = {}) {
  const result = await fetchJson(`${siteUrl(options)}/api/promotions`, options);
  if (!result.ok) return { ok: false, error: result.error };
  const items = Array.isArray(result.body?.data) ? result.body.data : null;
  if (!items) return { ok: false, error: "promotions payload had no data array" };
  return { ok: true, items };
}

/**
 * Full estimate for one payload. Never throws for a missing pricing row: the
 * caller decides whether a failed estimate blocks the request (`--max-cost`).
 */
export async function estimatePayload(payload, options = {}) {
  const model = payload?.model;
  const input = payload?.input || {};
  const result = {
    model,
    listUsd: null,
    unitUsd: null,
    ruleName: null,
    referenceImages: Array.isArray(input.image_urls) ? input.image_urls.length : 0,
    referenceAddonUsd: null,
    referenceAddonTotalUsd: 0,
    promotion: null,
    promotionNote: null,
    estimatedUsd: null,
    breakdown: null,
    pricingPage: HIAPI_PRICING_URL,
    note: "Estimate only; final billing follows the accepted task.",
  };
  let rows;
  try {
    rows = await fetchPricingRows(options);
  } catch (error) {
    return { ...result, error: error?.message || String(error), unverified: true };
  }
  const row = rows.find((entry) => entry?.model_name === model);
  if (!row) {
    return { ...result, error: `Current public pricing does not list ${model}.`, unverified: false };
  }
  const selected = selectPolicy(row, input);
  result.unitUsd = selected.unitUsd;
  result.ruleName = selected.ruleName;
  result.billingBasis = row.base_display_unit?.en || "per output image";
  if (selected.note) result.policyNote = selected.note;
  if (selected.unitUsd == null) {
    return { ...result, error: `No price is published for ${model} with these inputs (rule: ${JSON.stringify(selected.policy?.rule)}).` };
  }
  result.listUsd = selected.unitUsd;
  const addon = referenceAddonUsd(row);
  if (addon != null && result.referenceImages > 0) {
    result.referenceAddonUsd = addon;
    result.referenceAddonTotalUsd = Number((addon * result.referenceImages).toFixed(6));
  }
  const promotions = await fetchPromotions(options);
  if (promotions.ok) {
    const resolved = resolvePromotion(
      promotions.items,
      model,
      Math.floor((options.now ? options.now() : Date.now()) / 1000),
    );
    result.promotion = resolved.promotion;
    if (resolved.note) result.promotionNote = resolved.note;
  } else {
    result.promotionNote = `promotion lookup unavailable (${promotions.error}); estimate uses list price`;
  }
  const subtotal = result.listUsd + result.referenceAddonTotalUsd;
  const multiplier = result.promotion?.multiplier ?? 1;
  result.breakdown = {
    unitUsd: result.listUsd,
    referenceImages: result.referenceImages,
    referenceAddonTotalUsd: result.referenceAddonTotalUsd,
    subtotalUsd: Number(subtotal.toFixed(6)),
    promotionMultiplier: multiplier,
  };
  result.estimatedUsd = Number((subtotal * multiplier).toFixed(6));
  return result;
}

/** Applies the --max-cost gate. Returns `{ allowed, reason }`. */
export function enforceMaxCost(estimate, maxCost) {
  if (maxCost == null) return { allowed: true };
  const limit = Number(maxCost);
  if (!Number.isFinite(limit) || limit < 0) {
    throw new SkillError(`--max-cost must be a non-negative number (got ${maxCost}).`, {
      code: "INVALID_REQUEST",
      next: "Example: --max-cost 0.10",
    });
  }
  if (estimate?.error || estimate?.estimatedUsd == null) {
    return {
      allowed: false,
      reason: `Estimate unavailable (${estimate?.error || "no price"}), and --max-cost ${limit} is set, so no paid task was created.`,
      next: `Retry when /api/pricing is reachable, or drop --max-cost to accept the current price. ${HIAPI_PRICING_URL}`,
    };
  }
  if (estimate.estimatedUsd > limit) {
    return {
      allowed: false,
      reason: `Estimated $${estimate.estimatedUsd.toFixed(4)} exceeds --max-cost $${limit}.`,
      next: `Lower --quality/--resolution, or raise --max-cost above $${estimate.estimatedUsd.toFixed(4)}. ${HIAPI_PRICING_URL}`,
    };
  }
  return { allowed: true, limit, estimatedUsd: estimate.estimatedUsd };
}

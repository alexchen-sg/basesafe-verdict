// BaseSafe Verdict — Cloudflare Worker (x402 paid-per-call).
// Thin TypeScript-free Worker: bare fetch handler. The deterministic scorer is
// shared with the Node CLI (../../scorer-core.mjs) and bundled by esbuild.
// Routes:
//   GET  /health                  free
//   GET  /v1/verdict/preview      free, verdict + score only (no AI summary)
//   POST /v1/verdict              402; on paid retry verify -> verdict -> settle
//   GET  /.well-known/x402.json   x402 config
//   GET  /openapi.json            OpenAPI spec
// Cache: Cache API, 15 min per token. Never settle on a failed verdict.
// Env bindings: AI (Workers AI).
import { score } from "../../scorer-core.mjs";

const PAY_TO = "0x86dB7E2B155c7FF0c8aa0793B1437e39Ec7fc71B";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PRICE_ATOMIC = "20000"; // $0.02 USDC (6 decimals)
const PRICE_LABEL = "$0.02";
const SUMMARY_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const MAX_SUMMARY_TOKENS = 350;
const CACHE_TTL = 900; // 15 min
const PAYAI = "https://facilitator.payai.network";
const DEXTER = "https://x402.dexter.cash";

const WORKER_OPTS = {
  skipPairAge: true,
  // Holder scan: 2,000-block chunks (a 20k chunk on an active token like WETH
  // exceeds the node's per-call log cap and returns an error; the core also
  // splits failed ranges in half and retries).
  holderMaxBlocks: 100000, holderChunk: 2000, holderMaxLogs: 20000,
  lpMaxBlocks: 500000, lpChunk: 50000, lpMaxLogs: 20000,
};

function json(status, obj, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function acceptsFor(url) {
  return [
    {
      scheme: "exact",
      network: "base",
      maxAmountRequired: PRICE_ATOMIC,
      resource: url,
      description: "BaseSafe token safety verdict (deterministic checks + AI summary)",
      mimeType: "application/json",
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      asset: USDC_BASE,
      extra: { name: "USD Coin", version: "2", facilitator: "payai", assetTransferMethod: "eip3009" },
    },
    {
      scheme: "exact",
      network: "eip155:8453",
      maxAmountRequired: PRICE_ATOMIC,
      resource: url,
      description: "BaseSafe token safety verdict (deterministic checks + AI summary)",
      mimeType: "application/json",
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      asset: USDC_BASE,
      extra: { name: "USD Coin", version: "2", facilitator: "dexter", assetTransferMethod: "permit2" },
    },
  ];
}

function paymentRequired(url) {
  return json(402, {
    x402Version: 1,
    error: "Payment Required",
    accepts: acceptsFor(url),
  });
}

function isAddress(a) {
  return typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
}

async function summarize(env, verdict) {
  const facts = {
    token: verdict.token,
    verdict: verdict.verdict,
    score: verdict.score,
    checks: verdict.checks.map(c => ({ id: c.id, pass: c.pass, detail: c.detail })),
    facts: verdict.facts,
  };
  const res = await env.AI.run(SUMMARY_MODEL, {
    messages: [
      { role: "system", content: "You are a token-safety analyst. Summarize the verdict in at most 3 sentences, plain English, using ONLY the facts in the JSON. If any check has pass null, say it could not be verified. No advice to buy or sell." },
      { role: "user", content: JSON.stringify(facts) },
    ],
    max_tokens: MAX_SUMMARY_TOKENS,
    temperature: 0.2,
  });
  const text = res?.response || res?.choices?.[0]?.message?.content || "";
  const neurons = res?.usage?.neurons ?? null;
  return { text, neurons };
}

function cacheKey(token) {
  return new Request(`https://basesafe-verdict/verdict/${token.toLowerCase()}`, { method: "GET" });
}

async function buildVerdict(env, token, withSummary) {
  const cache = caches.default;
  const key = cacheKey(token);
  const hit = await cache.match(key);
  if (hit) {
    const v = await hit.json();
    if (withSummary && !v.summary) {
      const s = await summarize(env, v);
      v.summary = s.text;
      v.summary_neurons = s.neurons;
      v.summary_model = SUMMARY_MODEL;
      await cache.put(key, new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_TTL}` } }));
    }
    return v;
  }
  // Netlify free-tier functions cap at 10s: TIGHTEN_SCAN=1 (set by the
  // Netlify adapter) narrows the holder/LP scans. Cloudflare is unaffected
  // (env has no TIGHTEN_SCAN there, defaults are unchanged).
  const opts =
    env.TIGHTEN_SCAN === "1"
      ? { ...WORKER_OPTS, holderMaxBlocks: 20000, lpMaxBlocks: 100000 }
      : WORKER_OPTS;
  const v = await score(token, opts);
  if (withSummary) {
    const s = await summarize(env, v);
    v.summary = s.text;
    v.summary_neurons = s.neurons;
    v.summary_model = SUMMARY_MODEL;
  }
  await cache.put(key, new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": `max-age=${CACHE_TTL}` } }));
  return v;
}

async function facilitatorCall(base, path, body) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

function routeFacilitator(paymentPayload) {
  // EIP-3009 payloads carry `authorization`; Permit2 payloads carry `permit`.
  const p = paymentPayload?.payload || {};
  if (p.permit) return DEXTER;
  return PAYAI; // default: EIP-3009
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "GET" && path === "/health") {
      return json(200, { status: "ok", service: "basesafe-verdict", version: "1.0.0", chain: "base", price_usdc: PRICE_LABEL, pay_to: PAY_TO });
    }

    if (request.method === "GET" && path === "/.well-known/x402.json") {
      return json(200, {
        x402Version: 1,
        facilitators: { payai: PAYAI, dexter: DEXTER },
        accepted: [{ scheme: "exact", network: "base", asset: USDC_BASE, payTo: PAY_TO, maxAmountRequired: PRICE_ATOMIC, facilitator: "payai", assetTransferMethod: "eip3009" },
                   { scheme: "exact", network: "eip155:8453", asset: USDC_BASE, payTo: PAY_TO, maxAmountRequired: PRICE_ATOMIC, facilitator: "dexter", assetTransferMethod: "permit2" }],
        endpoints: { preview: "/v1/verdict/preview", verdict: "/v1/verdict" },
        price_usdc: PRICE_LABEL,
      });
    }

    if (request.method === "GET" && path === "/openapi.json") {
      return json(200, openapi(url.origin));
    }

    if (request.method === "GET" && path === "/v1/verdict/preview") {
      const token = url.searchParams.get("token") || "";
      if (!isAddress(token)) return json(400, { error: "invalid_token", detail: "query param token must be a 0x Base address" });
      try {
        const v = await buildVerdict(env, token, false);
        return json(200, { token: v.token, verdict: v.verdict, score: v.score, score_breakdown: v.score_breakdown, cached_at: v.cached_at, ttl_seconds: v.ttl_seconds, preview: true, note: "Full verdict with checks and AI summary: POST /v1/verdict ($0.02 USDC)." });
      } catch (e) {
        return json(502, { error: "verdict_failed", detail: String(e?.message || e).slice(0, 300) });
      }
    }

    if (request.method === "POST" && path === "/v1/verdict") {
      let body = {};
      try { body = await request.json(); } catch { return json(400, { error: "invalid_json" }); }
      const token = body.token || "";
      if (!isAddress(token)) return json(400, { error: "invalid_token", detail: "body.token must be a 0x Base address" });

      const paymentHeader = request.headers.get("X-Payment");
      if (!paymentHeader) return paymentRequired(url.toString());

      let paymentPayload;
      try { paymentPayload = JSON.parse(atob(paymentHeader)); } catch { return json(402, { error: "invalid_payment", detail: "X-Payment is not valid base64 JSON" }); }

      // Requirements for verify/settle are built from the payload's own network
      // (what the client actually signed), with our fixed price/asset/payTo.
      // The 402 accepts array is only the offer; the signature is authoritative.
      const net = paymentPayload?.network || "base";
      const reqs = {
        scheme: "exact",
        network: net,
        maxAmountRequired: PRICE_ATOMIC,
        resource: url.toString(),
        description: "BaseSafe token safety verdict (deterministic checks + AI summary)",
        mimeType: "application/json",
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
        asset: USDC_BASE,
        extra: { name: "USD Coin", version: "2" },
      };
      const verifyBody = { x402Version: 1, paymentPayload, paymentRequirements: reqs };
      const fac = routeFacilitator(paymentPayload);
      let verify = await facilitatorCall(fac, "/verify", verifyBody);
      let verifiedFac = fac;
      if (!verify.body?.isValid) {
        // Fall back to the other facilitator (payload shape may have been misread).
        const other = fac === PAYAI ? DEXTER : PAYAI;
        verify = await facilitatorCall(other, "/verify", verifyBody);
        if (verify.body?.isValid) verifiedFac = other;
      }
      if (!verify.body?.isValid) {
        return json(402, { error: "payment_invalid", detail: "Facilitator could not verify the payment", facilitator: verify.body });
      }

      // Payment verified — generate the verdict. Any failure: 5xx, do NOT settle.
      let verdict;
      try {
        verdict = await buildVerdict(env, token, true);
      } catch (e) {
        const msg = String(e?.message || e);
        if (/quota|allowance|429|402|exhausted|rate limit/i.test(msg)) {
          return json(503, { error: "summary_unavailable", detail: "Daily AI allowance exhausted; no charge was made." });
        }
        return json(502, { error: "verdict_failed", detail: msg.slice(0, 300) });
      }

      const settleBody = { x402Version: 1, paymentPayload, paymentRequirements: reqs };
      const settle = await facilitatorCall(verifiedFac, "/settle", settleBody);
      if (!settle.body?.success) {
        return json(402, { error: "settle_failed", detail: "Facilitator could not settle the payment; no verdict delivered." });
      }
      const paymentResponse = { success: true, transaction: settle.body.transaction, network: settle.body.network, payer: settle.body.payer };
      return json(200, { ...verdict, payment: paymentResponse }, {
        "X-Payment-Response": btoa(JSON.stringify(paymentResponse)),
      });
    }

    return json(404, { error: "not_found", routes: ["GET /health", "GET /v1/verdict/preview", "POST /v1/verdict", "GET /.well-known/x402.json", "GET /openapi.json"] });
  },
};

function openapi(origin) {
  return {
    openapi: "3.0.3",
    info: { title: "BaseSafe Verdict", version: "1.0.0", description: "Deterministic Base token safety verdict, paid per call via x402 ($0.02 USDC). No DexScreener data. Summary only from Cloudflare Workers AI." },
    servers: [{ url: origin }],
    paths: {
      "/health": { get: { summary: "Health (free)", responses: { 200: { description: "ok" } } } },
      "/v1/verdict/preview": { get: { summary: "Free preview: verdict + score only", parameters: [{ name: "token", in: "query", required: true, schema: { type: "string" }, description: "Base token address (0x…)" }], responses: { 200: { description: "verdict + score" }, 400: { description: "invalid token" } } } },
      "/v1/verdict": { post: { summary: "Full verdict ($0.02 USDC via x402)", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] } } } }, responses: { 200: { description: "verdict + checks + AI summary" }, 402: { description: "Payment Required — see accepts" }, 503: { description: "AI allowance exhausted (no charge)" } } } },
      "/.well-known/x402.json": { get: { summary: "x402 config", responses: { 200: { description: "config" } } } },
    },
  };
}

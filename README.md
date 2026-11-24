# BaseSafe Verdict

Deterministic Base token-safety verdict, paid per call via **x402 ($0.02 USDC
on Base)**. No DexScreener data — only public Base RPC + Coinbase public spot
price, plus a Workers AI summary.

- `GET /health` — free
- `GET /v1/verdict/preview?token=0x…` — free, verdict + score only
- `POST /v1/verdict` — 402 without `X-Payment`; verify → verdict → settle
- `GET /.well-known/x402.json` — x402 config (PayAI + Dexter facilitators)
- `GET /openapi.json` — OpenAPI spec

## Scorer

`scorer-core.mjs` is the shared deterministic core (also used by the Node CLI
in the private dev tree). Checks: liquidity, holder concentration, owner
powers, buy/sell simulation incl. **honeypot detection** (`HONEYPOT-SUSPECT`
when buy works but sell doesn't on a V2 pair, or sell tax ≥ 99%). Live-tested
2026-11-24 against a real honeypot (DOGGO on Base, honeypot.is
`IsHoneypot=true`, riskLevel 100).

## Deploy (Cloudflare Workers Builds)

1. Push this repo to `github.com/alexchen-sg/basesafe-verdict` (public).
2. Cloudflare dashboard → Workers & Pages → Create → connect the GitHub repo
   (Cloudflare auto-generates a token with Workers Scripts:Edit).
3. Build command: `npm run build` · Deploy command: `npx wrangler deploy`.
4. Workers AI binding `AI` comes from `wrangler.toml`; no secrets required.
   Live URL: `https://basesafe-verdict.alexchenz8xv.workers.dev`.

## Verify after deploy

```bash
SITE=https://basesafe-verdict.alexchenz8xv.workers.dev
curl -s $SITE/health
curl -s $SITE/.well-known/x402.json
curl -s "$SITE/v1/verdict/preview?token=<redacted>"
curl -s -X POST $SITE/v1/verdict -H 'content-type: application/json' \
  -d '{"token":"0x4200000000000000000000000000000000000006"}' # expect 402 + accepts
```

## Notes / limits

- `payTo` is `0x86dB7E2B155c7FF0c8aa0793B1437e39Ec7fc71B`. Its private key is
  **not** in the persona vault — do not take real paid calls on this address
  until `payTo` points at a controlled wallet.
- Workers AI free tier: 10,000 neurons/day; summary model
  `@cf/meta/llama-3.2-3b-instruct`, max 350 tokens.
- Cache: Cache API, 15 min per token. Never settles on a failed verdict.

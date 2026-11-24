// BaseSafe Verdict — deterministic scorer core (no LLM). Shared by the Node CLI
// (scorer.mjs) and the Cloudflare Worker (worker/src/worker.mjs).
// Reads only public Base RPC + Coinbase public spot price. No DexScreener.
// RPC: JSON-RPC batching is used for independent view calls so the Worker stays
// under the 50-subrequest limit. No process.env / fs usage — runs in Workers.
import { keccak256, encodeFunctionData, decodeFunctionResult, toHex, encodeAbiParameters, hexToBigInt } from "viem";

export const CHAIN = "base";
export const WETH = "0x4200000000000000000000000000000000000006";
export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // lowercase: all address comparisons in this file are case-sensitive
export const V3_FACTORIES = [
  // Aerodrome Slipstream (Uniswap V3 fork) — verified live 2026-11-23 via
  // pool factory() calls; hosts DOGINME/WETH ($1.15M) and AERO/WETH ($665k).
  "0x33128a8fc17869897dce68ed026d694621f6fdfd",
];
// NOTE: 0x1F98431c8aD98523631AE4a59f267346ea31F984 is the Uniswap V3 factory on
// mainnet, but on Base that address hosts an unrelated "Recover" contract
// (Basescan, verified 2026-11-23: owner()/feeAmountTickSpacing() return 0x).
// Do NOT use it. The real Uniswap V3 factory address on Base is unverified;
// Slipstream covers the Base-native tokens in our test set.
export const V2_FACTORY = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";
export const V2_ROUTER = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
export const BURN = "0x000000000000000000000000000000000000dead"; // lowercase: compared against lowercase log topics
export const ZERO = "0x0000000000000000000000000000000000000000";
export const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

let RPC_URLS = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
export function configureRpc(urls) { if (urls && urls.length) RPC_URLS = urls; }
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DEADLINE_BUFFER = 3600;

const ROUTER_ABI = [
  { name: "getAmountsOut", type: "function", stateMutability: "view",
    inputs: [{ type: "uint256", name: "amountIn" }, { type: "address[]", name: "path" }],
    outputs: [{ type: "uint256[]", name: "amounts" }] },
  { name: "swapExactETHForTokensSupportingFeeOnTransferTokens", type: "function", stateMutability: "payable",
    inputs: [{ type: "uint256", name: "amountOutMin" }, { type: "address[]", name: "path" }, { type: "address", name: "to" }, { type: "uint256", name: "deadline" }],
    outputs: [{ type: "uint256[]", name: "amounts" }] },
  { name: "swapExactTokensForETHSupportingFeeOnTransferTokens", type: "function", stateMutability: "nonpayable",
    inputs: [{ type: "uint256", name: "amountIn" }, { type: "uint256", name: "amountOutMin" }, { type: "address[]", name: "path" }, { type: "address", name: "to" }, { type: "uint256", name: "deadline" }],
    outputs: [{ type: "uint256[]", name: "amounts" }] },
];
const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address", name: "a" }], outputs: [{ type: "uint256" }] },
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ type: "address", name: "o" }, { type: "address", name: "s" }], outputs: [{ type: "uint256" }] },
  { name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const PAIR_ABI = [
  { name: "getReserves", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] },
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const FACTORY_ABI = [
  { name: "getPair", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address" }] },
];
const V3_FACTORY_ABI = [
  { name: "getPool", type: "function", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
];
const V3_POOL_ABI = [
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "liquidity", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
];

// V3-style pool discovery (Aerodrome Slipstream + any other V3 forks listed in
// V3_FACTORIES): getPool(token, quote, fee) across fee tiers.
// Liquidity USD is measured from the pool's actual token balances (V3 pools hold
// the tokens; balances include out-of-range liquidity, which is still real).
// Returns the richest pool {pool, quote, usd} or null.
const V3_FEES = [500, 3000, 10000, 100];
async function discoverV3(token, ethUsd) {
  const quotes = token === WETH ? [USDC] : [WETH, USDC];
  const calls = [];
  const meta = [];
  for (const factory of V3_FACTORIES) {
    for (const q of quotes) for (const fee of V3_FEES) {
      calls.push({ method: "eth_call", params: [{ to: factory, data: encodeFunctionData({ abi: V3_FACTORY_ABI, functionName: "getPool", args: [token, q, fee] }) }, "latest"] });
      meta.push(q);
    }
  }
  const results = await rpcBatch(calls);
  const pools = [];
  for (let i = 0; i < results.length; i++) {
    if (isErr(results[i]) || !results[i] || results[i] === "0x") continue;
    try {
      const p = decodeFunctionResult({ abi: V3_FACTORY_ABI, functionName: "getPool", data: results[i] });
      if (p && p.toLowerCase() !== ZERO) pools.push({ pool: p.toLowerCase(), quote: meta[i] });
    } catch {}
  }
  if (!pools.length) return null;
  // token0/token1 + balances for each candidate pool, one batch.
  const bcalls = [];
  for (const { pool } of pools) {
    bcalls.push({ method: "eth_call", params: [{ to: pool, data: encodeFunctionData({ abi: V3_POOL_ABI, functionName: "token0", args: [] }) }, "latest"] });
    bcalls.push({ method: "eth_call", params: [{ to: pool, data: encodeFunctionData({ abi: V3_POOL_ABI, functionName: "token1", args: [] }) }, "latest"] });
  }
  const bres = await rpcBatch(bcalls);
  // Batch all balanceOf(pool) calls for the candidate pools.
  const balCalls = [];
  const poolMeta = [];
  for (let i = 0; i < pools.length; i++) {
    let t0, t1;
    try {
      t0 = decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "token0", data: bres[2 * i] }).toLowerCase();
      t1 = decodeFunctionResult({ abi: V3_POOL_ABI, functionName: "token1", data: bres[2 * i + 1] }).toLowerCase();
    } catch { continue; }
    poolMeta.push({ pool: pools[i].pool, quote: pools[i].quote, t0, t1 });
    balCalls.push({ method: "eth_call", params: [{ to: t0, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [pools[i].pool] }) }, "latest"] });
    balCalls.push({ method: "eth_call", params: [{ to: t1, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "balanceOf", args: [pools[i].pool] }) }, "latest"] });
  }
  const balRes = await rpcBatch(balCalls);
  let best = null;
  for (let i = 0; i < poolMeta.length; i++) {
    const { pool, quote, t0, t1 } = poolMeta[i];
    let b0, b1;
    try {
      if (isErr(balRes[2 * i]) || isErr(balRes[2 * i + 1])) continue;
      b0 = decodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", data: balRes[2 * i] });
      b1 = decodeFunctionResult({ abi: ERC20_ABI, functionName: "balanceOf", data: balRes[2 * i + 1] });
    } catch { continue; }
    if (b0 === null || b1 === null) continue;
    // USD value: quote-side balance x2 (V3 balances are skewed by concentration,
    // so this is an approximation — noted in the verdict detail).
    const q = quote;
    const qBal = t0 === q ? b0 : b1;
    const usd = q === WETH ? Number(qBal) / 1e18 * ethUsd * 2 : Number(qBal) / 1e6 * 2;
    if (!best || usd > best.usd) best = { pool, quote: q, usd };
  }
  return best;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rpc(method, params, tries = 0) {
  const errs = [];
  for (const url of RPC_URLS) {
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: Date.now() % 100000, method, params }),
          signal: AbortSignal.timeout(25000) });
        const j = await r.json();
        if (j.error) throw new Error(method + " " + JSON.stringify(j.error).slice(0, 200));
        return j.result;
      } catch (e) { errs.push(url + ": " + e.message.slice(0, 120)); await sleep(500); }
    }
  }
  throw new Error("all RPCs failed for " + method + " :: " + errs.join(" | ").slice(0, 400));
}

// One HTTP request carrying N independent JSON-RPC calls (PublicNode supports
// batches). Returns results in call order; a per-call error becomes an Error.
// Falls back to sequential rpc() if the node rejects batches.
async function rpcBatch(calls) {
  const url = RPC_URLS[0];
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, method: c.method, params: c.params }));
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    if (!Array.isArray(j) || j.length !== calls.length) throw new Error("bad batch response");
    return j.map(x => x.error ? new Error(JSON.stringify(x.error).slice(0, 200)) : x.result);
  } catch (e) {
    const out = [];
    for (const c of calls) { try { out.push(await rpc(c.method, c.params)); } catch (e2) { out.push(e2); } }
    return out;
  }
}
function isErr(x) { return x instanceof Error; }

async function ethCall(to, data, opts = {}) {
  const tx = { to, data, ...(opts.from ? { from: opts.from } : {}), ...(opts.value ? { value: opts.value } : {}), ...(opts.gas ? { gas: opts.gas } : {}) };
  const params = [tx, opts.block || "latest"];
  if (opts.overrides) params.push(opts.overrides);
  return rpc("eth_call", params);
}
async function callUint(to, abi, fn, args = [], opts = {}) {
  const data = encodeFunctionData({ abi, functionName: fn, args });
  const raw = await ethCall(to, data, opts);
  if (!raw || raw === "0x") return null;
  try { return decodeFunctionResult({ abi, functionName: fn, data: raw }); } catch { return null; }
}
async function getCode(addr) { return rpc("eth_getCode", [addr, "latest"]); }
async function latestBlock() { return parseInt(await rpc("eth_blockNumber", []), 16); }
async function blockTimestamp(n) {
  const b = await rpc("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
  return parseInt(b.timestamp, 16);
}

function selector(sig) {
  return keccak256(toHex(sig)).slice(0, 10);
}
const MINT_SIGS = ["mint(address,uint256)", "mint(address)", "mint(uint256)"];
const PAUSE_SIGS = ["pause()", "unpause()", "paused()", "blacklist(address)", "setBlacklist(address,bool)", "excludeFromFees(address)", "setTaxes(uint256,uint256)", "setFee(uint256)"];

async function ethPriceUsd() {
  // Primary: on-chain WETH/USDC V2 pair ratio (no HTTP, always available).
  // Sanity-bounded; Coinbase/CoinGecko best-effort as cross-check only.
  try {
    const pair = "0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c";
    const raw = await rpc("eth_call", [{ to: pair, data: "0x0902f1ac" }, "latest"]);
    const r0 = hexToBigInt("0x" + raw.slice(2, 66)), r1 = hexToBigInt("0x" + raw.slice(66, 130));
    const t0 = await rpc("eth_call", [{ to: pair, data: "0x0dfe1681" }, "latest"]);
    const t0addr = ("0x" + t0.slice(-40)).toLowerCase();
    const wethRes = t0addr === WETH ? r0 : r1;
    const usdcRes = t0addr === WETH ? r1 : r0;
    if (wethRes > 0n) {
      const px = Number(usdcRes) / 1e6 / (Number(wethRes) / 1e18);
      if (px > 100 && px < 20000) return px;
    }
  } catch {}
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (j?.data?.amount) return parseFloat(j.data.amount);
  } catch {}
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    if (j?.ethereum?.usd) return j.ethereum.usd;
  } catch {}
  return null;
}

// Find a V2 pair's creation block via PairCreated, chunked backwards from latest
// (PublicNode free tier rejects archive-wide log ranges; 2M-block chunks work).
// Best-effort: covers the last ~20M blocks (~1.3y); older pairs return null.
async function pairCreationBlock(pair, tokenA, tokenB, latest) {
  const topic = keccak256(toHex("PairCreated(address,address,address,uint256)"));
  const pad = (a) => "0x000000000000000000000000" + a.slice(2).toLowerCase();
  const CHUNK = 2000000, MAX_CHUNKS = 10;
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const to = latest - i * CHUNK;
    const from = Math.max(0, to - CHUNK + 1);
    if (to < 0) break;
    for (const [a, b] of [[tokenA, tokenB], [tokenB, tokenA]]) {
      try {
        const logs = await rpc("eth_getLogs", [{ address: V2_FACTORY, topics: [topic, pad(a), pad(b)], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
        // PairCreated: topics=[sig, token0, token1]; pair address is 1st word of data.
        const hit = (logs || []).find(l => l.data && ("0x" + l.data.slice(2, 66).slice(-40)).toLowerCase() === pair);
        if (hit) return parseInt(hit.blockNumber, 16);
      } catch { /* next chunk */ }
      await sleep(60);
    }
    if (from === 0) break;
  }
  return null;
}

// Scan Transfer logs backwards from `toBlock` until maxLogs or maxBlocks scanned.
// Chunks are fetched 10 at a time in ONE JSON-RPC batch request (1 subrequest).
// If a chunk errors (e.g. a public node caps results per call for a very active
// token), the range is SPLIT IN HALF and retried — a wide chunk that returns
// too many logs never silently yields zero.
// If fromBlockMin is set, scan down to that block.
async function scanTransfers(token, toBlock, maxLogs = 100000, maxBlocks = 500000, chunk = 2000, fromBlockMin = 0) {
  const balances = new Map();
  let logs = 0, scanned = 0;
  const MIN_CHUNK = 500;
  let cursor = toBlock; // newest block not yet queued
  let queue = []; // [start, end] ranges, newest first; retries go to the front
  const fillQueue = () => {
    while (queue.length < 10 && logs < maxLogs && scanned < maxBlocks && cursor >= fromBlockMin) {
      const start = Math.max(fromBlockMin, cursor - chunk + 1);
      queue.push([start, cursor]);
      cursor = start - 1;
      if (start <= fromBlockMin) break;
    }
  };
  fillQueue();
  while (queue.length && logs < maxLogs && scanned < maxBlocks) {
    const batch = queue.splice(0, 10);
    const results = await rpcBatch(batch.map(([s, e]) => ({
      method: "eth_getLogs",
      params: [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: "0x" + s.toString(16), toBlock: "0x" + e.toString(16) }],
    })));
    const retry = [];
    for (let i = 0; i < batch.length; i++) {
      const [s, e] = batch[i];
      const res = results[i];
      scanned += e - s + 1;
      if (isErr(res)) {
        if (e - s + 1 > MIN_CHUNK) {
          const mid = Math.floor((s + e) / 2);
          retry.push([s, mid], [mid + 1, e]);
        }
        continue;
      }
      for (const l of res || []) {
        logs++;
        const from = "0x" + l.topics[1].slice(-40);
        const to = "0x" + l.topics[2].slice(-40);
        const val = hexToBigInt(l.data);
        balances.set(from, (balances.get(from) || 0n) - val);
        balances.set(to, (balances.get(to) || 0n) + val);
      }
    }
    queue = [...retry, ...queue];
    fillQueue();
    if (logs >= maxLogs) break;
    await sleep(60); // stay under PublicNode's free-tier rate limit
  }
  return { balances, logs, scannedBlocks: scanned };
}

async function topHolders(token, toBlock, opts = {}) {
  const { balances, logs, scannedBlocks } = await scanTransfers(token, toBlock, opts.maxLogs || 100000, opts.maxBlocks || 500000, opts.chunk || 2000, opts.fromBlockMin || 0);
  const list = [...balances.entries()].filter(([, v]) => v > 0n).sort((a, b) => (b[1] > a[1] ? 1 : -1));
  return { list, logs, scannedBlocks };
}

export async function score(token, opts = {}) {
  token = token.toLowerCase();
  const t0 = Date.now();
  const checks = [];
  const facts = {};
  let score = 100;
  const breakdown = { ownership: 100, liquidity: 100, holder_concentration: 100, tax_simulation: 100, contract_risk: 100 };
  const ded = (bucket, pts) => { breakdown[bucket] = Math.max(0, breakdown[bucket] - pts); score -= pts; };

  // Stage A — one JSON-RPC batch: block, token info, owner, code, pair discovery,
  // EIP-1967 implementation slot (proxy detection).
  const quote0 = token === WETH ? USDC : WETH;
  const [blkR, decR, tsR, codeR, ownerR, pairWethR, pairUsdcR, implSlotR] = await rpcBatch([
    { method: "eth_blockNumber", params: [] },
    { method: "eth_call", params: [{ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "decimals", args: [] }) }, "latest"] },
    { method: "eth_call", params: [{ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "totalSupply", args: [] }) }, "latest"] },
    { method: "eth_getCode", params: [token, "latest"] },
    { method: "eth_call", params: [{ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "owner", args: [] }) }, "latest"] },
    { method: "eth_call", params: [{ to: V2_FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPair", args: [token, quote0] }) }, "latest"] },
    { method: "eth_call", params: [{ to: V2_FACTORY, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPair", args: [token, USDC] }) }, "latest"] },
    { method: "eth_getStorageAt", params: [token, EIP1967_IMPL_SLOT, "latest"] },
  ]);
  const latest = isErr(blkR) ? await latestBlock() : parseInt(blkR, 16);
  const decimals = !isErr(decR) && decR && decR !== "0x" ? Number(decodeFunctionResult({ abi: ERC20_ABI, functionName: "decimals", data: decR })) : 18;
  const totalSupply = !isErr(tsR) && tsR && tsR !== "0x" ? decodeFunctionResult({ abi: ERC20_ABI, functionName: "totalSupply", data: tsR }) : null;
  let code = isErr(codeR) ? "0x" : codeR;
  // Proxy detection: if the EIP-1967 implementation slot is set, the token is
  // an upgradeable proxy — scan the IMPLEMENTATION's bytecode too (WHUF:
  // 76-byte proxy hides mint()/pause() in the implementation).
  let proxyImpl = null;
  if (!isErr(implSlotR) && implSlotR && implSlotR !== "0x" + "0".repeat(64)) {
    proxyImpl = ("0x" + implSlotR.slice(-40)).toLowerCase();
    try {
      const implCode = await getCode(proxyImpl);
      if (implCode && implCode !== "0x" && implCode.length > 2) {
        code = code + implCode.slice(2); // scan proxy + implementation together
        facts.proxy_implementation = proxyImpl;
      } else proxyImpl = null;
    } catch { proxyImpl = null; }
  }
  // Pair discovery: preferred pair is against WETH (USDC if the token IS WETH),
  // fallback against USDC. quote records which side the pair uses.
  let pair = null, quote = token === WETH ? USDC : WETH;
  for (const [pr, q] of [[pairWethR, token === WETH ? USDC : WETH], [pairUsdcR, USDC]]) {
    if (!isErr(pr) && pr && pr !== "0x") {
      try { const p = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPair", data: pr }); if (p && p.toLowerCase() !== ZERO) { pair = p.toLowerCase(); quote = q; break; } } catch {}
    }
  }

  // --- 1. owner ---
  let owner = null, ownerIsContract = false, ownerRenounced = false;
  if (!isErr(ownerR) && ownerR && ownerR !== "0x") {
    try { const o = decodeFunctionResult({ abi: ERC20_ABI, functionName: "owner", data: ownerR }); owner = o ? o.toLowerCase() : null; } catch { owner = null; }
  }
  if (!owner || owner === ZERO) ownerRenounced = true;
  else {
    const oc = await getCode(owner);
    ownerIsContract = oc && oc !== "0x" && oc.length > 2;
  }
  if (ownerRenounced) {
    checks.push({ id: "owner_renounced", pass: true, detail: owner ? "owner() == 0x000…0" : "no owner() function" });
  } else {
    ded("ownership", ownerIsContract ? 10 : 20);
    checks.push({ id: "owner_renounced", pass: false, detail: `owner() == ${owner} (${ownerIsContract ? "contract" : "EOA"})` });
  }

  // --- 2/3. bytecode selector scan ---
  const codeLower = (code || "").toLowerCase();
  const mintFound = MINT_SIGS.filter(s => codeLower.includes(selector(s).slice(2)));
  const pauseFound = PAUSE_SIGS.filter(s => codeLower.includes(selector(s).slice(2)));
  if (mintFound.length) {
    ded("contract_risk", ownerIsContract ? 10 : 25);
    checks.push({ id: "mintable", pass: false, detail: `mint selector(s) in bytecode: ${mintFound.join(", ")}${proxyImpl ? ` (via implementation ${proxyImpl})` : ""}` });
  } else checks.push({ id: "mintable", pass: true, detail: "no mint() selector in bytecode" });
  if (pauseFound.length) {
    ded("contract_risk", 20);
    checks.push({ id: "pausable_blacklist", pass: false, detail: `selector(s) in bytecode: ${pauseFound.join(", ")}${proxyImpl ? ` (via implementation ${proxyImpl})` : ""}` });
  } else checks.push({ id: "pausable_blacklist", pass: true, detail: "no pause/blacklist selectors" });

  // --- pair reserves + age ---
  let reserves = null, wethReserve = 0n, tokenReserve = 0n, pairAgeDays = null;
  if (pair) {
    try {
      const [r0, r1] = await callUint(pair, PAIR_ABI, "getReserves");
      const t0a = (await callUint(pair, PAIR_ABI, "token0")).toLowerCase();
      if (t0a === quote) { wethReserve = r0; tokenReserve = r1; } else { wethReserve = r1; tokenReserve = r0; }
      reserves = { r0: r0.toString(), r1: r1.toString() };
    } catch {}
    // pair age via PairCreated log (token-filtered, chunked backwards).
    // Skipped in the Worker (subrequest budget); it is a minor fact, not a check.
    if (!opts.skipPairAge) {
      try {
        const created = await pairCreationBlock(pair, token, quote, latest);
        if (created) {
          const ts = await blockTimestamp(created);
          pairAgeDays = Math.floor((Date.now() / 1000 - ts) / 86400);
          facts.pair_created_block = created;
        }
      } catch {}
    }
  }
  facts.pair_age_days = pairAgeDays;

  // --- 8. liquidity USD (V2 first, V3 fallback) ---
  const ethUsd = await ethPriceUsd();
  let liquidityUsd = null, liquiditySource = "v2";
  if (pair && reserves && ethUsd) {
    // wethReserve here is the QUOTE-side reserve (WETH unless token==WETH, then USDC)
    liquidityUsd = quote === WETH
      ? Number(wethReserve) / 1e18 * ethUsd * 2
      : Number(wethReserve) / 1e6 * 2; // quote is USDC (6 decimals): USD value of both sides
    facts.liquidity_usd = Math.round(liquidityUsd);
    facts.liquidity_quote = quote === WETH ? "WETH" : "USDC";
  } else if (pair && reserves) {
    facts.liquidity_usd = null;
  }
  // V3 fallback: many Base tokens (DOGINME, AERO) keep their real liquidity on
  // Uniswap V3 while the V2 pair is a dust pool. If V2 shows < $50k, use V3.
  if (ethUsd && (!liquidityUsd || liquidityUsd < 50000)) {
    try {
      const v3 = await discoverV3(token, ethUsd);
      if (v3 && v3.usd > (liquidityUsd || 0)) {
        liquidityUsd = v3.usd;
        liquiditySource = "v3";
        facts.liquidity_usd = Math.round(liquidityUsd);
        facts.liquidity_quote = v3.quote === WETH ? "WETH" : "USDC";
        facts.liquidity_source = "v3";
        facts.v3_pool = v3.pool;
      }
    } catch (e) { facts.v3_error = e.message.slice(0, 120); }
  }
  facts.liquidity_source = liquiditySource;
  const anyPool = pair !== null || !!facts.v3_pool;
  if (liquidityUsd === null && !anyPool) {
    // No trading pool exists on V2 or V3: the token has no public liquidity
    // at all. That is a failure, not a data gap (a token you cannot trade
    // is not safe). Distinct from a missing price feed (anyPool true).
    ded("liquidity", 25);
    checks.push({ id: "liquidity_usd", pass: false, detail: "no trading pool found on V2 or V3 — token has no public liquidity" });
  } else if (liquidityUsd === null) {
    // Missing price feed is a data gap, not a token fault: no deduction.
    checks.push({ id: "liquidity_usd", pass: null, detail: "no ETH price available" });
  } else if (liquidityUsd >= 50000) {
    checks.push({ id: "liquidity_usd", pass: true, detail: `$${Math.round(liquidityUsd).toLocaleString()} in ${liquiditySource === "v3" ? "V3" : "V2"} pool${liquiditySource === "v3" ? " (quote-side x2, approx)" : ""}` });
  } else {
    const pts = liquidityUsd < 1000 ? 25 : liquidityUsd < 10000 ? 15 : 7;
    ded("liquidity", pts);
    checks.push({ id: "liquidity_usd", pass: false, detail: `$${Math.round(liquidityUsd).toLocaleString()} in ${liquiditySource === "v3" ? "V3" : "V2"} pool` });
  }

  // --- 6. LP lock (V2 only; V3 concentrated liquidity is NFT positions) ---
  if (liquiditySource === "v3") {
    checks.push({ id: "liquidity_locked_or_burned", pass: null, detail: "V3 concentrated liquidity (NFT positions) — LP-token lock check N/A" });
  } else if (pair) {
    const lpTotal = await callUint(pair, ERC20_ABI, "totalSupply");
    const lpBurn = await callUint(pair, ERC20_ABI, "balanceOf", [BURN]);
    const lpOwner = owner ? await callUint(pair, ERC20_ABI, "balanceOf", [owner]) : 0n;
    let lpLargestShare = null, lpScanNote = "";
    try {
      // LP scan over the recent window (PublicNode free tier: no archive-wide ranges).
      // For young pairs this covers full history; for old pairs it covers holders
      // active in the window — the share is reported as such.
      const winStart = Math.max(0, latest - (opts.lpMaxBlocks || 500000));
      const { list, logs, scannedBlocks } = await topHolders(pair, latest, { maxLogs: opts.lpMaxLogs || 50000, maxBlocks: opts.lpMaxBlocks || 500000, chunk: opts.lpChunk || 50000, fromBlockMin: winStart });
      if (list.length && lpTotal) lpLargestShare = Number(list[0][1]) / Number(lpTotal);
      lpScanNote = ` (${logs} LP transfers, ${scannedBlocks} blocks scanned)`;
    } catch (e) { lpScanNote = " (LP holder scan failed)"; }
    const burnedShare = lpTotal ? Number(lpBurn) / Number(lpTotal) : 0;
    const ownerLpShare = lpTotal ? Number(lpOwner) / Number(lpTotal) : 0;
    if (burnedShare >= 0.9 || (lpLargestShare !== null && lpLargestShare <= 0.2 && ownerLpShare === 0)) {
      checks.push({ id: "liquidity_locked_or_burned", pass: true, detail: `LP burned ${(burnedShare * 100).toFixed(1)}%, largest LP holder ${lpLargestShare === null ? "?" : (lpLargestShare * 100).toFixed(1) + "%"}${lpScanNote}` });
    } else if (ownerLpShare > 0 || (lpLargestShare !== null && lpLargestShare > 0.5)) {
      ded("liquidity", 15);
      checks.push({ id: "liquidity_locked_or_burned", pass: false, detail: `owner holds ${(ownerLpShare * 100).toFixed(1)}% of LP; largest LP holder ${lpLargestShare === null ? "?" : (lpLargestShare * 100).toFixed(1) + "%"}; burned ${(burnedShare * 100).toFixed(1)}%${lpScanNote}` });
    } else {
      ded("liquidity", 7);
      checks.push({ id: "liquidity_locked_or_burned", pass: false, detail: `LP burned ${(burnedShare * 100).toFixed(1)}%, largest LP holder ${lpLargestShare === null ? "unknown" : (lpLargestShare * 100).toFixed(1) + "%"} (20–50% or unverified)${lpScanNote}` });
    }
  } else {
    checks.push({ id: "liquidity_locked_or_burned", pass: null, detail: "no V2 pair found" });
  }

  // --- 7. top10 holders (EOA-only) ---
  let top10Share = null, holderCount = null, largestEoa = null;
  let tokenHolders = null; // cached for the sell sim
  try {
    const { list, logs, scannedBlocks } = await topHolders(token, latest, { maxLogs: opts.holderMaxLogs || 100000, maxBlocks: opts.holderMaxBlocks || 500000, chunk: opts.holderChunk || 2000 });
    tokenHolders = list;
    holderCount = list.length;
    facts.holder_count_approx = holderCount;
    facts.holders_scanned_logs = logs;
    facts.holders_scanned_blocks = scannedBlocks;
    if (totalSupply && list.length) {
      // Batch the is-contract checks (one eth_getCode per candidate, one batch).
      const cands = list.slice(0, 10).filter(([addr]) => addr !== pair && addr !== BURN && addr !== ZERO);
      const codeRes = await rpcBatch(cands.map(([addr]) => ({ method: "eth_getCode", params: [addr, "latest"] })));
      let eoaSum = 0n;
      for (let i = 0; i < cands.length; i++) {
        const [addr, bal] = cands[i];
        const c = codeRes[i];
        if (!isErr(c) && (!c || c === "0x" || c.length <= 2)) { eoaSum += bal; if (!largestEoa) largestEoa = addr; }
      }
      top10Share = Number(eoaSum) / Number(totalSupply);
      facts.top10_share_pct = +(top10Share * 100).toFixed(1);
    }
  } catch (e) { facts.top10_error = e.message.slice(0, 120); }
  if (top10Share === null && holderCount === 0 && facts.holders_scanned_logs === 0 && !facts.top10_error) {
    // The scan SUCCEEDED but found zero transfers in 500k blocks: the token
    // is dormant/dead and its holder concentration is completely unverifiable.
    // (Distinct from a scan failure, which stays null with no deduction.)
    ded("holder_concentration", 20);
    checks.push({ id: "top10_holders", pass: false, detail: "no token transfers in the last 500k blocks — token is dormant; holder concentration unverifiable" });
  } else if (top10Share === null) {
    checks.push({ id: "top10_holders", pass: null, detail: "holder scan failed" });
  } else if (top10Share <= 0.3) {
    checks.push({ id: "top10_holders", pass: true, detail: `top 10 EOAs hold ${(top10Share * 100).toFixed(1)}% of supply` });
  } else {
    const pts = top10Share > 0.9 ? 30 : top10Share > 0.5 ? 15 : 7;
    ded("holder_concentration", pts);
    checks.push({ id: "top10_holders", pass: false, detail: `top 10 EOAs hold ${(top10Share * 100).toFixed(1)}% of supply` });
  }

  // --- 4/5. tax sims (V2 router, state overrides) ---
  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_BUFFER;
  let buyTax = null, sellTax = null, buyWorked = false, sellWorked = false, buyRevertReason = "", sellRevertReason = "";
  const hasLiquidity = pair && wethReserve > 0n && tokenReserve > 0n;
  // V2 tax sims only run against a real V2 pool. If the token's liquidity is
  // V3 (liquiditySource === "v3"), the V2 pair is dust and sims would revert
  // on noise — skip them as "not supported" instead of "reverted".
  const v2Simulable = hasLiquidity && liquiditySource === "v2";
  if (token === WETH) {
    // WETH itself: buying = wrapping ETH, selling = unwrapping — tax-free by construction.
    buyWorked = sellWorked = true; buyTax = sellTax = 0;
    facts.buy_tax_pct = 0; facts.sell_tax_pct = 0;
  } else if (pair && v2Simulable) {
    const buyAmountIn = 10n ** 17n; // 0.01 ETH
    let expectedBuy = null;
    try {
      const amounts = await callUint(V2_ROUTER, ROUTER_ABI, "getAmountsOut", [buyAmountIn, [WETH, token]]);
      expectedBuy = amounts ? amounts[1] : null;
    } catch {}
    const buyer = "0x" + "22".repeat(20);
    try {
      const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", args: [0n, [WETH, token], buyer, BigInt(deadline)] });
      const raw = await ethCall(V2_ROUTER, data, { from: buyer, value: "0x" + buyAmountIn.toString(16), gas: "0x1e8480",
        overrides: { [buyer]: { balance: "0xde0b6b3a7640000" } } });
      const amounts = decodeFunctionResult({ abi: ROUTER_ABI, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens", data: raw });
      const received = amounts[amounts.length - 1];
      if (expectedBuy && expectedBuy > 0n) {
        buyTax = 1 - Number(received) / Number(expectedBuy);
        buyWorked = true;
        facts.buy_tax_pct = +(buyTax * 100).toFixed(2);
      }
    } catch (e) { buyRevertReason = e.message.slice(0, 160); }
    // sell: largest EOA holder (reuse the cached holder scan)
    let seller = null, sellerBal = 0n;
    try {
      const list = tokenHolders || (await topHolders(token, latest)).list;
      const cands = list.filter(([addr]) => addr !== pair && addr !== BURN && addr !== ZERO).slice(0, 5);
      const codeRes = await rpcBatch(cands.map(([addr]) => ({ method: "eth_getCode", params: [addr, "latest"] })));
      for (let i = 0; i < cands.length; i++) {
        const c = codeRes[i];
        if (!isErr(c) && (!c || c === "0x" || c.length <= 2)) { seller = cands[i][0]; sellerBal = cands[i][1]; break; }
      }
    } catch {}
    if (seller && sellerBal > 0n) {
      const amountIn = sellerBal > (totalSupply / 100n) ? totalSupply / 100n : sellerBal; // cap 1% of supply
      let expectedEth = null;
      try {
        const amounts = await callUint(V2_ROUTER, ROUTER_ABI, "getAmountsOut", [amountIn, [token, WETH]]);
        expectedEth = amounts ? amounts[1] : null;
      } catch {}
      // discover allowance storage slot (try 0..3) — one batch, each call with
      // its own state override setting that slot's allowance to max.
      let allowSlotKey = null;
      const slotKeys = [];
      for (let slot = 0; slot < 4; slot++) {
        const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [seller, BigInt(slot)]));
        slotKeys.push(keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [V2_ROUTER, inner])));
      }
      const allowRes = await rpcBatch(slotKeys.map(key => ({
        method: "eth_call",
        params: [{ to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [seller, V2_ROUTER] }) }, "latest",
          { [token]: { state: { [key]: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" } } }],
      })));
      for (let i = 0; i < slotKeys.length; i++) {
        if (isErr(allowRes[i]) || !allowRes[i] || allowRes[i] === "0x") continue;
        try {
          const v = decodeFunctionResult({ abi: ERC20_ABI, functionName: "allowance", data: allowRes[i] });
          if (v > 0n) { allowSlotKey = slotKeys[i]; break; }
        } catch {}
      }
      if (allowSlotKey && expectedEth) {
        try {
          const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", args: [amountIn, 0n, [token, WETH], seller, BigInt(deadline)] });
          const raw = await ethCall(V2_ROUTER, data, { from: seller, gas: "0x1e8480",
            overrides: { [seller]: { balance: "0xde0b6b3a7640000" }, [token]: { state: { [allowSlotKey]: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" } } } });
          const amounts = decodeFunctionResult({ abi: ROUTER_ABI, functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens", data: raw });
          const receivedEth = amounts[amounts.length - 1];
          sellTax = 1 - Number(receivedEth) / Number(expectedEth);
          sellWorked = true;
          facts.sell_tax_pct = +(sellTax * 100).toFixed(2);
        } catch (e) { sellRevertReason = e.message.slice(0, 160); }
      } else {
        sellRevertReason = allowSlotKey ? "no expectedEth" : "allowance slot not found (slots 0-3)";
      }
    }
  }
  if (buyWorked) {
    const d = token === WETH ? "WETH: wrapping ETH is tax-free by construction" : `simulated buy 0.01 ETH -> ${(buyTax * 100).toFixed(1)}% tax`;
    if (buyTax <= 0.05) checks.push({ id: "buy_tax_sim", pass: true, detail: d });
    else { ded("tax_simulation", buyTax > 0.1 ? 25 : 10); checks.push({ id: "buy_tax_sim", pass: false, detail: d }); }
  } else {
    checks.push({ id: "buy_tax_sim", pass: null, detail: liquiditySource === "v3" ? "V3 pool — V2 tax simulation not supported" : hasLiquidity ? `buy simulation reverted: ${buyRevertReason}` : "no liquid V2 pool to simulate" });
  }
  if (sellWorked) {
    const d = token === WETH ? "WETH: unwrapping is tax-free by construction" : `simulated sell -> ${(sellTax * 100).toFixed(1)}% tax`;
    if (sellTax <= 0.05) checks.push({ id: "sell_tax_sim", pass: true, detail: d });
    else { ded("tax_simulation", sellTax > 0.1 ? 25 : 10); checks.push({ id: "sell_tax_sim", pass: false, detail: d }); }
  } else {
    checks.push({ id: "sell_tax_sim", pass: null, detail: liquiditySource === "v3" ? "V3 pool — V2 tax simulation not supported" : hasLiquidity ? `sell simulation reverted: ${sellRevertReason}` : "no liquid V2 pool to simulate" });
  }

  // --- verdict ---
  let verdict;
  const honeypot = (buyWorked && !sellWorked && v2Simulable) || (sellTax !== null && sellTax >= 0.99);
  if (honeypot) verdict = "HONEYPOT-SUSPECT";
  else if (score >= 80) verdict = "SAFE";
  else if (score >= 60) verdict = "CAUTION";
  else verdict = "HIGH-RISK";

  return {
    token, chain: "base", verdict, score,
    score_breakdown: breakdown, checks, facts,
    summary: null, cached_at: new Date().toISOString(), ttl_seconds: 900,
    sources: ["Base public RPC (eth_call / eth_getLogs)", "Uniswap V2/V3 pool contracts on Base"],
    _meta: { pair, ms: Date.now() - t0, honeypot },
  };
}

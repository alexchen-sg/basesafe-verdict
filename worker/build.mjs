// Bundle the Worker (worker.mjs + scorer-core + viem) into dist/worker.mjs.
import * as esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["worker/src/worker.mjs"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: "worker/dist/worker.mjs",
  minify: false,
  logLevel: "info",
  // viem's WebSocket transport (unused by the scorer) pulls in Node-only `ws`;
  // externalize it — tree-shaking drops the unused transport code anyway.
  external: ["ws"],
});
console.log("built dist/worker.mjs");

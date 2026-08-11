import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    // the hand model and piano samples are already compressed binaries
    assetsInlineLimit: 0,
  },
  worker: {
    // MediaPipe's wasm loader bootstraps via importScripts, which does not
    // exist in an ES module worker ("ModuleFactory not set"). A classic
    // worker is its best-tested configuration.
    format: "iife",
  },
});

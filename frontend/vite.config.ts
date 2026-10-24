/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { publishIndexLast } from "./tooling/publishIndexLast.ts";

// The production build is written into the backend package and served by FastAPI on
// http://127.0.0.1:8000, so the app needs no external web server or CDN.
export default defineConfig({
  plugins: [react(), tailwindcss(), publishIndexLast()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
  build: {
    outDir: "../backend/src/taskradar/static",
    // Open tabs still lazy-load chunks from their original build. Never delete those hashed assets on update.
    emptyOutDir: false,
    chunkSizeWarningLimit: 1000,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});

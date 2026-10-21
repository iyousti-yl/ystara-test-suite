import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { loadLocalEnv } from "@ystara/shared/env";

/**
 * Builds the web app into dist/, which the API serves on its own port.
 * In development (`npm run dev:web`), Vite serves the app on 127.0.0.1:5173 and
 * forwards /api to the API on YSTARA_API_PORT, so the browser sees one origin either way.
 */
loadLocalEnv(fileURLToPath(new URL("../../", import.meta.url)));

// IBM Plex font files, served from this app instead of a public CDN (see src/fonts.ts).
const require = createRequire(import.meta.url);
const fontFiles = (name: string) => path.join(path.dirname(require.resolve(`@fontsource/${name}/package.json`)), "files");

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@plex-sans": fontFiles("ibm-plex-sans"), "@plex-mono": fontFiles("ibm-plex-mono") } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": `http://127.0.0.1:${process.env.YSTARA_API_PORT ?? 4000}` },
  },
  build: {
    // UI5 and React Flow make one large but cacheable bundle; there is no need to split it yet.
    chunkSizeWarningLimit: 4000,
  },
});

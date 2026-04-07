import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
);

const clientVersion = clientPkg.version ?? "0.0.0";

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Proxy community API requests to avoid CORS in browser-only dev mode
      "/community-api": {
        target: "https://arkestrator.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/community-api/, "/api"),
      },
    },
  },
  define: {
    __DEV_SERVER_DIR__: JSON.stringify(
      path.resolve(__dirname, "../server"),
    ),
    __CLIENT_VERSION__: JSON.stringify(clientVersion),
    __CLIENT_BUILD__: JSON.stringify(clientVersion),
    __COMMUNITY_API_DEV_URL__: JSON.stringify(""),
  },
});

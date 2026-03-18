import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8"),
);

const adminVersion = adminPkg.version ?? "0.0.0";

export default defineConfig({
  plugins: [svelte()],
  define: {
    __ADMIN_VERSION__: JSON.stringify(adminVersion),
    __ADMIN_BUILD__: JSON.stringify(adminVersion),
  },
  base: "/admin/",
  build: {
    outDir: "dist",
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://localhost:7800",
      "/health": "http://localhost:7800",
    },
  },
});

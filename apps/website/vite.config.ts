import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [tailwindcss(), solidPlugin()],
  resolve: {
    alias: {
      "@uncorded/protocol": resolve(__dirname, "../../packages/protocol/src/index.ts"),
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/v1": {
        target: process.env.VITE_CENTRAL_URL ?? "http://localhost:4000",
        changeOrigin: true,
      },
      "/health": {
        target: process.env.VITE_CENTRAL_URL ?? "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "esnext",
  },
});

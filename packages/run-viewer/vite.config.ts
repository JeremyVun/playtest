import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const packageDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.join(packageDir, "src", "web"),
  base: "./",
  envDir: false,
  publicDir: false,
  build: {
    outDir: path.join(packageDir, "build"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
    rolldownOptions: {
      output: {
        entryFileNames: "app.js",
        assetFileNames: "style.css",
      },
    },
  },
});

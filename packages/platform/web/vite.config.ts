import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runViewerAssetsDir } from "@playtest/run-viewer/assets";
import { defineConfig, type Plugin } from "vite";

const packageDir = path.dirname(fileURLToPath(import.meta.url));

function embedRunViewer(): Plugin {
  let outDir = "";

  return {
    name: "playtest-embed-run-viewer",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!fs.existsSync(path.join(runViewerAssetsDir, "index.html"))) {
        throw new Error(
          `run-viewer build is missing at ${runViewerAssetsDir}; run the ordered root build`,
        );
      }
      fs.cpSync(runViewerAssetsDir, path.join(outDir, "viewer"), { recursive: true });
    },
  };
}

export default defineConfig({
  root: path.join(packageDir, "src"),
  base: "/",
  envDir: false,
  publicDir: false,
  plugins: [embedRunViewer()],
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

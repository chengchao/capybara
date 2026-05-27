import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so Electron can load the built index.html over file://.
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    electron({
      main: {
        // No `entry` shortcut: the plugin would default lib.formats to ["es"]
        // (package is "type": "module") and mergeConfig *concatenates* arrays,
        // so setting it here directly is the only way to get a single cjs build.
        // Main + preload stay CommonJS (.cjs) to match Electron's require()-based
        // loader with sandbox:false; electron + node builtins are auto-external.
        vite: {
          build: {
            lib: {
              entry: "electron/main.ts",
              formats: ["cjs"],
              fileName: () => "main.cjs",
            },
            rollupOptions: {
              // The SDK spawns a native binary it locates on disk, so it must
              // stay external (and is asarUnpack'd by electron-builder).
              external: ["@anthropic-ai/claude-agent-sdk"],
            },
          },
        },
      },
      preload: {
        input: "electron/preload.ts",
        vite: {
          build: {
            rollupOptions: {
              output: {
                entryFileNames: "preload.cjs",
                chunkFileNames: "[name].cjs",
              },
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
});

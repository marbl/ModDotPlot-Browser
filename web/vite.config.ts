import { defineConfig } from "vite";
import packageMetadata from "./package.json" with { type: "json" };

export default defineConfig({
  base: process.env.MODDOTPLOT_BASE_PATH ?? "/",
  define: {
    __APP_VERSION__: JSON.stringify(packageMetadata.version),
  },
});

import { defineConfig } from "vite";

// GitHub Pages serves this project site under /WANIMxFBX/.
// With the default base ('/') every built asset 404s in production while
// working fine in `vite dev`. Always validate the built site with `vite preview`.
export default defineConfig({
  base: "/WANIMxFBX/",
  build: {
    target: "es2021",
    sourcemap: true,
  },
});

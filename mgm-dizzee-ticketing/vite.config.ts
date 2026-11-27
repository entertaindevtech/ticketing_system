import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // One page per portal, served by the backend at / (index.html), /admin (admin.html), /counter (counter.html) and
  // /staff (staff.html, the gate PWA).
  build: { outDir: "dist", sourcemap: false, rollupOptions: { input: { main: "index.html", admin: "admin.html", counter: "counter.html", staff: "staff.html" } } },
});

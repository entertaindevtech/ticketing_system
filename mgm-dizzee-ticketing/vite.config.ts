import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // One page per portal, served by the backend at /customer (index.html), /admin (admin.html) and /staff (staff.html).
  build: { outDir: "dist", sourcemap: false, rollupOptions: { input: { main: "index.html", admin: "admin.html", staff: "staff.html" } } },
});

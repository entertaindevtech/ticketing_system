import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // staff.html is the installable gate-scanner PWA; index.html is the main customer/admin app.
  build: { outDir: "dist", sourcemap: false, rollupOptions: { input: { main: "index.html", staff: "staff.html" } } },
});

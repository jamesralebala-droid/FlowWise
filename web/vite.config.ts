import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard talks to the FlowWise API directly (CORS is enabled server-side).
// VITE_API_BASE_URL overrides the default when the API lives elsewhere.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
  },
  build: {
    outDir: "dist",
  },
});

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Local dev: the SPA runs on :2083 and proxies the Worker routes to `wrangler dev` (default :8787),
// so the app keeps using same-origin URLs exactly like production.
const WORKER = process.env.WORKER_ORIGIN || 'http://127.0.0.1:8787'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 2083,
    host: true,
    hmr: true,
    proxy: {
      '/api': { target: WORKER, changeOrigin: true },
      '/chatuploads': { target: WORKER, changeOrigin: true },
      '/ws': { target: WORKER, changeOrigin: true, ws: true }
    }
  }
})
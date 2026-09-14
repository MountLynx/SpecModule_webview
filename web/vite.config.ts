import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: true, ws: true },
      // TreeChat 对话服务（server 整树挂载于 /treechat；回合为 SSE 流式，HTTP 即可）
      "/treechat": { target: "http://127.0.0.1:8000", changeOrigin: true },
    },
  },
});

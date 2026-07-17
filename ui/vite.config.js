import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    server: {
        port: 5173,
        host: true,
        // Vite blocks requests whose `Host` header doesn't match an entry
        // here. We allow localhost + the LAN IP + the two common tunnel
        // suffixes so the same dev server works from a phone on the same
        // WiFi AND behind a cloudflared / localtunnel quick tunnel.
        // Set to `true` to allow any host (less safe — fine for solo dev).
        allowedHosts: [
            "localhost",
            "127.0.0.1",
            "192.168.1.6",
            ".trycloudflare.com",
            ".loca.lt",
        ],
        proxy: {
            "/api": {
                target: "http://localhost:3001",
                changeOrigin: true,
            },
            "/ws": {
                target: "ws://localhost:3001",
                ws: true,
                changeOrigin: true,
            },
            "/health": {
                target: "http://localhost:3001",
                changeOrigin: true,
            },
        },
    },
});

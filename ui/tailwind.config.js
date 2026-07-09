/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#fafafa",
        grid: "#ececf0",
        ink: {
          900: "#0a0a0f",
          800: "#1a1a23",
          700: "#2a2a35",
          500: "#6b6b7a",
          400: "#9a9aa8",
          300: "#c5c5d0",
        },
      },
      boxShadow: {
        soft: "0 1px 2px rgba(10,10,15,0.04), 0 1px 3px rgba(10,10,15,0.06)",
        card: "0 4px 12px rgba(10,10,15,0.06), 0 1px 3px rgba(10,10,15,0.04)",
        node: "0 4px 12px rgba(10,10,15,0.08), 0 1px 3px rgba(10,10,15,0.04)",
        // Pill chip — softer drop shadow + a tiny inset top highlight so
        // the chip reads as raised but lightweight (like the reference).
        pill:
          "0 1px 2px rgba(10,10,15,0.04), 0 4px 14px rgba(10,10,15,0.06), inset 0 1px 0 rgba(255,255,255,0.6)",
        focus: "0 0 0 3px rgba(124,77,255,0.18)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      keyframes: {
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
        "pulse-ring": {
          "0%": { boxShadow: "0 0 0 0 rgba(124,77,255,0.6)" },
          "70%": { boxShadow: "0 0 0 14px rgba(124,77,255,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(124,77,255,0)" },
        },
        flow: {
          to: { strokeDashoffset: "-24" },
        },
        "dash-flow": {
          to: { strokeDashoffset: "-22" },
        },
        pop: {
          "0%": { transform: "scale(0.4)", opacity: "0" },
          "60%": { transform: "scale(1.15)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
        shake: {
          "0%, 100%": { transform: "translateX(0)" },
          "20%, 60%": { transform: "translateX(-3px)" },
          "40%, 80%": { transform: "translateX(3px)" },
        },
      },
      animation: {
        "pulse-soft": "pulse-soft 2s ease-in-out infinite",
        "pulse-ring": "pulse-ring 1.4s cubic-bezier(0.4,0,0.6,1) infinite",
        flow: "flow 0.9s linear infinite",
        pop: "pop 320ms cubic-bezier(0.34, 1.56, 0.64, 1)",
        shake: "shake 360ms ease-in-out",
        "dash-flow": "dash-flow 0.8s linear infinite",
      },
    },
  },
  plugins: [],
};

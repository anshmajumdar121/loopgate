import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

async function boot() {
  // GitHub Pages build only: no backend exists, so a recorded real run is
  // replayed in the browser (src/staticDemo). Normal builds never load it.
  if (import.meta.env.VITE_STATIC_DEMO === "1") {
    const { installStaticDemo } = await import("./staticDemo/install");
    installStaticDemo();
  }
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void boot();

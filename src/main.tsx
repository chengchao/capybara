import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { applyTheme, getStoredTheme } from "./lib/theme";

import "./index.css";

// Apply the saved theme synchronously, before first paint, to avoid a flash.
applyTheme(getStoredTheme());
// When following the OS ("system"), re-resolve on live preference changes; a
// fixed light/dark choice ignores them.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (getStoredTheme() === "system") applyTheme("system");
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

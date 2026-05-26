import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";

import "./index.css";

// shadcn themes via a `.dark` class; mirror the OS preference onto it so the
// app follows system dark/light (and live changes), as the old CSS did.
// Full light/dark/system toggle with persistence is tracked in #25.
const darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = (isDark: boolean) => document.documentElement.classList.toggle("dark", isDark);
applyTheme(darkModeQuery.matches);
darkModeQuery.addEventListener("change", (event) => applyTheme(event.matches));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

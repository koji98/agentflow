import React from "react";
import ReactDOM from "react-dom/client";

import App from "./app";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element for Agentflow web app.");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);


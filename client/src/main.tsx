import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installFetchGuard } from "./lib/service-health";

// Before the first render, so no request escapes unwatched.
installFetchGuard();

if (!window.location.hash) {
  window.location.hash = "#/";
}

createRoot(document.getElementById("root")!).render(<App />);

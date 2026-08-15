import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { installFetchGuard } from "./lib/service-health";
import { captureReferral } from "./lib/referral";

// Before the first render, so no request escapes unwatched.
installFetchGuard();

// Before the hash router rewrites the URL: an affiliate link lands on
// /?via=jane and the code is gone by the time any component mounts.
captureReferral();

if (!window.location.hash) {
  window.location.hash = "#/";
}

createRoot(document.getElementById("root")!).render(<App />);

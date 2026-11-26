// Entry for the installable staff gate app (/staff.html). Only the scanner ships here; customer and admin stay in
// the main app.
import "./index.css";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "./ui";
import StaffApp from "./staff";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/staff-sw.js", { scope: "/staff" }).catch(() => undefined); });
}
createRoot(document.getElementById("root")!).render(<StoreProvider><StaffApp pwa /></StoreProvider>);

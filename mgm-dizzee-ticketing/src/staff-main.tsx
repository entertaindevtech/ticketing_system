// Staff / gate portal (/staff): the installable scanner PWA. Customer (/), admin (/admin) and counter (/counter) are
// separate entries.
import "./index.css";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "./ui";
import StaffApp from "./staff";

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/staff-sw.js", { scope: "/staff" }).catch(() => undefined); });
}
createRoot(document.getElementById("root")!).render(<StoreProvider><StaffApp /></StoreProvider>);

// Admin portal (/admin). AdminApp shows the staff sign-in until a session exists; every admin API checks roles server-side.
import "./index.css";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "./ui";
import AdminApp from "./admin";

createRoot(document.getElementById("root")!).render(<StoreProvider><AdminApp /></StoreProvider>);

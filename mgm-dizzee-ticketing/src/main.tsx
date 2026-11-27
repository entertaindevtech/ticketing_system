// Customer portal (/customer): booking, payment and "My Bookings". Admin (/admin) and staff (/staff) are separate pages.
import "./index.css";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "./ui";
import CustomerApp from "./customer";
import { captureVisit, dropRetiredOutbox } from "./referral";

// Bookmarks from the old single-page app (/#admin, /#staff) arrive here through the / -> /customer redirect.
const old = location.hash.match(/^#(admin|staff)$/);
if (old) location.replace(`/${old[1]}`);
else {
  dropRetiredOutbox();
  void captureVisit();
  createRoot(document.getElementById("root")!).render(<StoreProvider><CustomerApp /></StoreProvider>);
}

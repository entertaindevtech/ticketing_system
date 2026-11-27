// Customer portal (/): booking, payment and "My Bookings". Admin (/admin), counter (/counter) and staff (/staff) are
// separate pages with their own entries.
import "./index.css";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "./ui";
import CustomerApp from "./customer";
import { captureVisit, dropRetiredOutbox } from "./referral";

// Bookmarks from the old single-page app (/#admin, /#staff) open the customer page; send them to their portal.
const old = location.hash.match(/^#(admin|staff)$/);
if (old) location.replace(`/${old[1]}`);
else {
  dropRetiredOutbox();
  void captureVisit();
  createRoot(document.getElementById("root")!).render(<StoreProvider><CustomerApp /></StoreProvider>);
}

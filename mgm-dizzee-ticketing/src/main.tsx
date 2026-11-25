import "./index.css";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Icon, StoreProvider } from "./ui";
import CustomerApp from "./customer";
import AdminApp from "./admin";
import StaffApp from "./staff";
import { captureVisit, flushOutbox } from "./referral";

type App = "customer" | "admin" | "staff";
const fromHash = (): App => { const h = location.hash.replace("#", ""); return h === "admin" || h === "staff" ? h : "customer"; };

function Shell() {
  const [app, setApp] = useState<App>(fromHash);
  useEffect(() => { const f = () => setApp(fromHash()); window.addEventListener("hashchange", f); return () => window.removeEventListener("hashchange", f); }, []);
  const go = (a: App) => { try { location.hash = a; } catch { /* ignore */ } setApp(a); window.scrollTo(0, 0); };
  const tabs: [App, string, string][] = [["customer", "Customer Booking", "ticket"], ["admin", "Admin Dashboard", "grid"], ["staff", "Staff Scanner", "scan"]];
  return (
    <>
      <div className="sticky top-0 z-[60] h-11 bg-[#000000] text-white flex items-center gap-2 px-2 sm:px-4">
        <span className="hidden md:flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-mgm-yellow mr-2"><span className="h-2 w-2 rounded-full bg-mgm-yellow animate-pulse" />Prototype</span>
        <div className="flex gap-1 flex-1 sm:flex-none">
          {tabs.map(([k, l, i]) => (
            <button key={k} onClick={() => go(k)} className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 rounded-lg px-2 sm:px-3 h-8 text-xs font-semibold transition ${app === k ? "bg-mgm-yellow text-navy-950" : "text-white/70 hover:bg-white/10"}`}>
              <Icon name={i} size={14} /><span className="hidden xs:inline sm:inline">{l}</span><span className="xs:hidden sm:hidden">{l.split(" ")[0]}</span>
            </button>
          ))}
        </div>
        <span className="hidden lg:block ml-auto text-[11px] text-white/45">Illustrative demo data · no real payments · changes saved in this browser</span>
      </div>
      {app === "customer" && <CustomerApp />}
      {app === "admin" && <AdminApp />}
      {app === "staff" && <StaffApp />}
    </>
  );
}

void captureVisit().finally(flushOutbox);
createRoot(document.getElementById("root")!).render(<StoreProvider><Shell /></StoreProvider>);

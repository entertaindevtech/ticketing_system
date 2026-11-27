// Counter portal (/counter): walk-in ticket sales. Same session and APIs as the other portals; POST /api/counter/sales
// accepts only admin and counter accounts, so the role check below only decides what to show.
import "./index.css";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import CounterSale from "./counter";
import { StaffLogin } from "./staff";
import { Badge, Icon, Logo, StoreProvider, hasRole, useStore } from "./ui";

function CounterPortal() {
  const { me, setMe } = useStore();
  if (!me) return <div className="staff-h bg-slate-200/60 flex justify-center"><div className="w-full max-w-md"><StaffLogin title="Counter Sales" subtitle="Sign in with your MGM counter staff account." /></div></div>;
  const signOut = async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => undefined); setMe(null); };
  return (
    <div className="min-h-screen bg-[#F4F3EF] print:min-h-0 print:bg-white">
      <header className="print:hidden sticky top-0 z-30 h-[68px] glass border-b border-black/5 flex items-center gap-3 px-4 sm:px-6">
        <Logo size={44} />
        <div className="flex-1 min-w-0"><h1 className="font-display text-lg sm:text-xl font-bold text-navy-950 truncate leading-tight">Counter Sales</h1><div className="hidden sm:block text-xs text-slate-500 truncate">Walk-in ticket sales at the park counter (simulated payment)</div></div>
        <Badge tone="amber" className="max-sm:hidden">Simulated payments</Badge>
        <div className="flex items-center gap-2 pl-3 border-l border-slate-200"><div className="h-9 w-9 rounded-full bg-mgm-yellow grid place-items-center font-bold text-navy-950">{me.name.split(" ").map((x) => x[0]).join("").slice(0, 2)}</div><div className="hidden sm:block leading-tight"><div className="text-sm font-semibold text-navy-950">{me.name}</div><div className="text-[11px] text-slate-500">{me.roles.join(", ")}</div></div><button title="Sign out" aria-label="Sign out" className="h-9 w-9 grid place-items-center rounded-lg hover:bg-slate-100 text-slate-500" onClick={signOut}><Icon name="logout" size={17} /></button></div>
      </header>
      <main className="p-4 sm:p-6 print:p-0">
        {hasRole(me, "counter")
          ? <CounterSale />
          : <div className="card-flat p-8 text-center text-sm text-slate-600 max-w-md mx-auto"><Icon name="lock" size={28} className="mx-auto mb-2 text-slate-400" />This account has no counter access. Ask an administrator for the counter role.</div>}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StoreProvider><CounterPortal /></StoreProvider>);

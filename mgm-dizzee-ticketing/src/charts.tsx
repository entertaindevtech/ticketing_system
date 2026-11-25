import React, { useEffect, useRef, useState } from "react";
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null); const [w, setW] = useState(640);
  useEffect(() => { const el = ref.current; if (!el) return; const ro = new ResizeObserver(() => setW(Math.max(260, el.clientWidth))); ro.observe(el); setW(Math.max(260, el.clientWidth)); return () => ro.disconnect(); }, []);
  return [ref, w];
}

export const PALETTE = ["#1C1B19", "#F6CD45", "#CE3B37", "#C2541F", "#3F7D3A", "#8C8577", "#E9B825"];
const nice = (v: number) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
const short = (v: number) => (v >= 100000 ? (v / 100000).toFixed(1) + "L" : v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : String(Math.round(v)));

type Series = { name: string; color: string; values: number[] };
export function LineChart({ labels, series, height = 220, area = true, fmt = (v: number) => String(Math.round(v)) }: { labels: string[]; series: Series[]; height?: number; area?: boolean; fmt?: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth(); const H = height, L = 40, R = 10, Tp = 12, B = 26;
  const max = nice(Math.max(1, ...series.flatMap((s) => s.values)));
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, labels.length - 1);
  const y = (v: number) => Tp + (H - Tp - B) * (1 - v / max);
  const step = Math.ceil(labels.length / Math.max(3, Math.floor(W / 80)));
  return (
    <div className="relative" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} className="w-full h-auto" onMouseLeave={() => setHover(null)}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}><line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} stroke="#EBEBEB" /><text x={L - 6} y={y(max * f) + 4} textAnchor="end" fontSize="10" fill="#8C8C8C">{short(max * f)}</text></g>
        ))}
        {labels.map((l, i) => i % step === 0 && <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#8C8C8C">{l}</text>)}
        {series.map((s) => {
          const d = s.values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(" ");
          return (
            <g key={s.name}>
              {area && <path d={`${d} L${x(s.values.length - 1)},${y(0)} L${x(0)},${y(0)}Z`} fill={s.color} opacity="0.12" className="fade-in" style={{ animationDelay: ".5s" }} />}
              <path d={d} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" className="draw" style={{ ["--len" as string]: 3000 } as React.CSSProperties} />
              {hover !== null && <circle cx={x(hover)} cy={y(s.values[hover])} r="4.5" fill="#fff" stroke={s.color} strokeWidth="2.5" />}
            </g>
          );
        })}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={Tp} y2={H - B} stroke="#111111" strokeDasharray="3 3" opacity=".3" />}
        {labels.map((_, i) => <rect key={i} x={x(i) - (W - L - R) / labels.length / 2} y={0} width={(W - L - R) / labels.length} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />)}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-1 rounded-lg bg-navy-950 px-3 py-2 text-xs text-white shadow-lg" style={{ left: `${Math.min(75, (x(hover) / W) * 100)}%` }}>
          <div className="font-semibold mb-1">{labels[hover]}</div>
          {series.map((s) => <div key={s.name} className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}: <b>{fmt(s.values[hover])}</b></div>)}
        </div>
      )}
    </div>
  );
}

export function BarChart({ labels, series, height = 220, stacked = false, fmt = (v: number) => String(Math.round(v)) }: { labels: string[]; series: Series[]; height?: number; stacked?: boolean; fmt?: (v: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth(); const H = height, L = 40, R = 10, Tp = 12, B = 26;
  const totals = labels.map((_, i) => (stacked ? series.reduce((s, x) => s + x.values[i], 0) : Math.max(...series.map((x) => x.values[i]))));
  const max = nice(Math.max(1, ...totals));
  const bw = (W - L - R) / labels.length;
  const y = (v: number) => Tp + (H - Tp - B) * (1 - v / max);
  const step = Math.ceil(labels.length / Math.max(3, Math.floor(W / 70)));
  return (
    <div className="relative" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} height={H} className="w-full h-auto" onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} stroke="#EBEBEB" /><text x={L - 6} y={y(max * f) + 4} textAnchor="end" fontSize="10" fill="#8C8C8C">{short(max * f)}</text></g>)}
        {labels.map((l, i) => {
          let acc = 0;
          const inner = stacked ? bw * 0.62 : (bw * 0.7) / series.length;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} opacity={hover === null || hover === i ? 1 : 0.55}>
              <rect x={L + i * bw} y={0} width={bw} height={H} fill="transparent" />
              {series.map((s, si) => {
                const v = s.values[i];
                const xx = stacked ? L + i * bw + (bw - inner) / 2 : L + i * bw + bw * 0.15 + si * inner;
                const top = stacked ? y(acc + v) : y(v);
                const h = stacked ? y(acc) - y(acc + v) : y(0) - y(v);
                acc += v;
                return <rect key={s.name} x={xx} y={top} width={Math.max(1, inner - (stacked ? 0 : 2))} height={Math.max(0, h)} rx={stacked ? 0 : 3} fill={s.color} className="grow-y" style={{ animationDelay: `${Math.min(i * 18, 500)}ms` }} />;
              })}
              {i % step === 0 && <text x={L + i * bw + bw / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="#8C8C8C">{l}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-1 rounded-lg bg-navy-950 px-3 py-2 text-xs text-white shadow-lg" style={{ left: `${Math.min(72, ((L + hover * bw) / W) * 100)}%` }}>
          <div className="font-semibold mb-1">{labels[hover]}</div>
          {series.map((s) => <div key={s.name} className="flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: s.color }} />{s.name}: <b>{fmt(s.values[hover])}</b></div>)}
        </div>
      )}
    </div>
  );
}

export function Donut({ data, fmt = (v: number) => String(v), center }: { data: { label: string; value: number; color: string }[]; fmt?: (v: number) => string; center?: { value: string; label: string } }) {
  const [hover, setHover] = useState<number | null>(null);
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  let a = -Math.PI / 2;
  const arcs = data.map((d) => {
    const a0 = a, a1 = a + (d.value / total) * Math.PI * 2; a = a1;
    const r = 70, ri = 46, large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (ang: number, rr: number) => `${90 + rr * Math.cos(ang)},${90 + rr * Math.sin(ang)}`;
    return `M${p(a0, r)} A${r},${r} 0 ${large} 1 ${p(a1 - 0.0001, r)} L${p(a1 - 0.0001, ri)} A${ri},${ri} 0 ${large} 0 ${p(a0, ri)}Z`;
  });
  const h = hover !== null ? data[hover] : null;
  return (
    <div className="flex flex-col items-center gap-4">
      <svg viewBox="0 0 180 180" className="w-40 h-40 shrink-0" onMouseLeave={() => setHover(null)}>
        {arcs.map((d, i) => <path key={i} d={d} fill={data[i].color} stroke="#fff" strokeWidth="2" onMouseEnter={() => setHover(i)} className="pop-in" style={{ transform: hover === i ? "scale(1.04)" : "", transformOrigin: "90px 90px", transition: "transform .15s", animationDelay: `${i * 80}ms` }} />)}
        <text x="90" y="88" textAnchor="middle" fontSize={String(h ? fmt(h.value) : center?.value).length > 7 ? 13 : 18} fontWeight="800" fill="#111111">{h ? fmt(h.value) : center?.value}</text>
        <text x="90" y="106" textAnchor="middle" fontSize="10" fill="#8C8C8C">{h ? h.label : center?.label}</text>
      </svg>
      <div className="w-full space-y-2">
        {data.map((d, i) => (
          <div key={d.label} className="flex items-center gap-2 text-sm" onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <span className="h-3 w-3 rounded" style={{ background: d.color }} /><span className="flex-1 text-slate-600 truncate">{d.label}</span>
            <span className="font-semibold text-navy-950 tabular-nums">{fmt(d.value)}</span><span className="w-10 text-right text-xs text-slate-400">{Math.round((d.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HBars({ data, fmt = (v: number) => String(v) }: { data: { label: string; value: number; sub?: string; color?: string }[]; fmt?: (v: number) => string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="space-y-3">
      {data.map((d, i) => (
        <div key={d.label}>
          <div className="flex justify-between text-sm mb-1"><span className="font-medium text-navy-900 truncate pr-2">{d.label}</span><span className="font-semibold tabular-nums text-navy-950">{fmt(d.value)}{d.sub && <span className="ml-1 text-xs font-normal text-slate-400">{d.sub}</span>}</span></div>
          <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden"><div className="h-full rounded-full grow-x" style={{ width: `${(d.value / max) * 100}%`, background: d.color || PALETTE[i % PALETTE.length] }} /></div>
        </div>
      ))}
    </div>
  );
}

export function Funnel({ steps }: { steps: { label: string; value: number }[] }) {
  const max = steps[0]?.value || 1;
  return (
    <div className="space-y-2">
      {steps.map((s, i) => (
        <div key={s.label} className="flex items-center gap-3">
          <div className="w-28 text-xs font-medium text-slate-600 shrink-0">{s.label}</div>
          <div className="flex-1 h-8 rounded-lg bg-slate-100 relative overflow-hidden">
            <div className="absolute inset-y-0 left-0 rounded-lg grow-x" style={{ width: `${(s.value / max) * 100}%`, background: i === steps.length - 1 ? "#10B981" : `rgba(17,17,17,${0.9 - i * 0.15})` }} />
          </div>
          <div className="w-24 text-right text-xs"><span className="font-bold text-navy-950">{s.value.toLocaleString("en-IN")}</span> <span className="text-slate-400">{Math.round((s.value / max) * 100)}%</span></div>
        </div>
      ))}
    </div>
  );
}

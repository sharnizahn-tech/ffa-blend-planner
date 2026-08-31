"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Beaker,
  Bot,
  CheckCircle2,
  ChevronDown,
  Droplets,
  Gauge,
  Info,
  LayoutDashboard,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Truck,
} from "lucide-react";
import type { AdviseRequest } from "@/lib/advise";
import { findTopDespatchPlans, type DespatchPlan } from "@/lib/despatch";
import { getCopy, type Copy, type Lang } from "@/lib/i18n";
import { FormattedOpinion } from "@/lib/format-opinion";

type Tank = { name: string; capacity: number; stock: number; ffa: number };
type Result = Tank & {
  allocation: number;
  incoming: number;
  finalStock: number;
  finalFFA: number;
  utilisation: number;
  overflow: boolean;
};
type TankState = "safe" | "warning" | "critical";
type MobileTab = "overview" | "tanks" | "plan";

const initialTanks: Tank[] = [
  { name: "BST 1", capacity: 2000, stock: 465, ffa: 4.54 },
  { name: "BST 2", capacity: 2000, stock: 716, ffa: 6.23 },
];

function suggestTankName(tanks: Tank[]) {
  let n = 1;
  const taken = new Set(tanks.map((t) => t.name.trim().toLowerCase()));
  while (taken.has(`bst ${n}`)) n += 1;
  return `BST ${n}`;
}

const n = (v: number, d = 1) =>
  v.toLocaleString("en-MY", { minimumFractionDigits: d, maximumFractionDigits: d });

const allocationMt = (incomingCpo: number, pct: number) => (incomingCpo * pct) / 100;

function calculate(
  tanks: Tank[],
  allocation: number[],
  incomingCPO: number,
  incomingFFA: number,
): Result[] {
  return tanks.map((tank, i) => {
    const incoming = incomingCPO * ((allocation[i] || 0) / 100);
    const finalStock = tank.stock + incoming;
    const finalFFA =
      finalStock > 0
        ? (tank.stock * tank.ffa + incoming * incomingFFA) / finalStock
        : 0;
    return {
      ...tank,
      allocation: allocation[i] || 0,
      incoming,
      finalStock,
      finalFFA,
      utilisation: (finalStock / tank.capacity) * 100,
      overflow: finalStock > tank.capacity,
    };
  });
}

type BlendPlan = { allocation: number[]; results: Result[]; score: number };

function sameAllocation(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function scorePlan(
  tanks: Tank[],
  allocation: number[],
  incomingCPO: number,
  incomingFFA: number,
  target: number,
): BlendPlan | null {
  const results = calculate(tanks, allocation, incomingCPO, incomingFFA);
  if (results.some((r) => r.overflow)) return null;
  const excess = results.reduce((s, r) => s + Math.max(0, r.finalFFA - target) * r.finalStock, 0);
  const contamination = results.reduce(
    (s, r) => s + (r.ffa <= target && r.finalFFA > target ? r.stock : 0),
    0,
  );
  const highTankFeed = results.reduce((s, r) => s + (r.ffa > target ? r.incoming : 0), 0);
  const ffaMass = results.reduce((s, r) => s + r.finalFFA * r.finalStock, 0);
  const score =
    excess * 100 +
    contamination * 20 +
    highTankFeed * 2 +
    allocation.filter((x) => x > 0).length * 3 +
    ffaMass * 0.05;
  return { allocation: [...allocation], results, score };
}

function findTopPlans(
  tanks: Tank[],
  incomingCPO: number,
  incomingFFA: number,
  target: number,
  limit = 3,
): BlendPlan[] {
  const top: BlendPlan[] = [];
  const assess = (allocation: number[]) => {
    const plan = scorePlan(tanks, allocation, incomingCPO, incomingFFA, target);
    if (!plan || top.some((p) => sameAllocation(p.allocation, plan.allocation))) return;
    top.push(plan);
    top.sort((a, b) => a.score - b.score);
    if (top.length > limit) top.length = limit;
  };
  const build = (index: number, remaining: number, values: number[]) => {
    if (index === tanks.length - 1) {
      assess([...values, remaining]);
      return;
    }
    for (let value = 0; value <= remaining; value += 5)
      build(index + 1, remaining - value, [...values, value]);
  };
  build(0, 100, []);
  return top;
}

function planToAdvisePayload(plan: BlendPlan, rank: number, target: number) {
  return {
    rank,
    allocationPct: plan.allocation,
    score: plan.score,
    meetsTarget: plan.results.every((r) => r.finalFFA <= target),
    maxFinalFfaPct: Math.max(...plan.results.map((r) => r.finalFFA)),
    tanks: plan.results.map((r) => ({
      name: r.name,
      allocationPct: r.allocation,
      incomingMt: r.incoming,
      finalStockMt: r.finalStock,
      finalFfaPct: r.finalFFA,
      utilisationPct: r.utilisation,
      overflow: r.overflow,
    })),
  };
}

function tankState(result: Result, target: number): TankState {
  if (result.overflow) return "critical";
  if (result.finalFFA > target) return "warning";
  return "safe";
}

function statusLabel(
  state: TankState,
  overflow: boolean,
  finalFFA: number,
  target: number,
  copy: Copy,
) {
  if (overflow) return copy.tanks.overflow;
  if (finalFFA > target) return copy.tanks.aboveLimit;
  return copy.tanks.goodFfa;
}

function TankCylinder({
  fillPct,
  state,
  compact = false,
}: {
  fillPct: number;
  state: TankState;
  compact?: boolean;
}) {
  const clamped = Math.min(100, Math.max(0, fillPct));
  return (
    <div
      className={`tank-cylinder tank-cylinder--${state}${compact ? " tank-cylinder--compact" : ""}`}
      aria-hidden
    >
      <div className="tank-cylinder__cap" />
      <div className="tank-cylinder__shell">
        <div className="tank-cylinder__fill" style={{ height: `${clamped}%` }} />
        <span className="tank-cylinder__pct">{Math.round(clamped)}%</span>
      </div>
    </div>
  );
}

function LanguageToggle({ lang, onChange }: { lang: Lang; onChange: (lang: Lang) => void }) {
  return (
    <div className="flex shrink-0 rounded-full border border-white/20 bg-white/10 p-0.5 text-xs font-bold">
      {(["en", "bm"] as const).map((code) => (
        <button
          key={code}
          type="button"
          onClick={() => onChange(code)}
          className={`rounded-full px-3 py-1.5 transition-colors ${
            lang === code ? "bg-[#d7f08a] text-[#123c2c]" : "text-white/80 hover:text-white"
          }`}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export default function Home() {
  const [tanks, setTanks] = useState(initialTanks);
  const [millCapacity, setMillCapacity] = useState(40);
  const [hours, setHours] = useState(20);
  const [utilisation, setUtilisation] = useState(100);
  const [oer, setOer] = useState(19);
  const [incomingFFA, setIncomingFFA] = useState(6.7);
  const [target, setTarget] = useState(4.8);
  const [allocation, setAllocation] = useState([0, 100]);
  const [mobileTab, setMobileTab] = useState<MobileTab>("overview");
  const [expandedTanks, setExpandedTanks] = useState<Set<number>>(
    () => new Set(initialTanks.map((_, i) => i)),
  );
  const [aiOpinion, setAiOpinion] = useState<string | null>(null);
  const [aiSource, setAiSource] = useState<"openai" | "offline" | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiCooldown, setAiCooldown] = useState(0);
  const [aiQuestion, setAiQuestion] = useState("");
  const [lang, setLang] = useState<Lang>("en");
  const [tankerLoadMt, setTankerLoadMt] = useState(28);

  const copy = getCopy(lang);
  const highFfaTankNames = tanks
    .filter((t) => t.ffa > target)
    .map((t) => t.name)
    .join(", ");

  useEffect(() => {
    const saved = localStorage.getItem("ffa-lang");
    if (saved === "en" || saved === "bm") setLang(saved);
  }, []);

  const setLanguage = (next: Lang) => {
    setLang(next);
    localStorage.setItem("ffa-lang", next);
  };

  const estimatedFFB = (millCapacity * hours * utilisation) / 100;
  const incomingCPO = (estimatedFFB * oer) / 100;
  const results = useMemo(
    () => calculate(tanks, allocation, incomingCPO, incomingFFA),
    [tanks, allocation, incomingCPO, incomingFFA],
  );
  const topPlans = useMemo(
    () => findTopPlans(tanks, incomingCPO, incomingFFA, target),
    [tanks, incomingCPO, incomingFFA, target],
  );
  const best = topPlans[0] ?? null;
  const allocationTotal = allocation.reduce((a, b) => a + b, 0);
  const currentStock = tanks.reduce((s, t) => s + t.stock, 0);
  const highFFAStock = tanks.filter((t) => t.ffa > target).reduce((s, t) => s + t.stock, 0);
  const valid = allocationTotal === 100 && !results.some((r) => r.overflow);
  const bestMeetsTarget = !!best && best.results.every((r) => r.finalFFA <= target);
  const hasOverflow = results.some((r) => r.overflow);
  const despatchTanks = useMemo(
    () =>
      results.map((r) => ({
        name: r.name,
        stockMt: r.finalStock,
        ffaPct: r.finalFFA,
      })),
    [results],
  );
  const topDespatchPlans = useMemo(
    () => findTopDespatchPlans(despatchTanks, tankerLoadMt, target),
    [despatchTanks, tankerLoadMt, target],
  );

  useEffect(() => {
    setAiOpinion(null);
    setAiSource(null);
    setAiError(null);
  }, [tanks, allocation, millCapacity, hours, utilisation, oer, incomingFFA, target, incomingCPO, topPlans]);

  useEffect(() => {
    if (aiCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setAiCooldown((seconds) => (seconds <= 1 ? 0 : seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [aiCooldown]);

  const fetchAiOpinion = async () => {
    if (aiLoading || aiCooldown > 0) return;
    setAiLoading(true);
    setAiError(null);
    setAiCooldown(60);
    try {
      const payload: AdviseRequest = {
        production: {
          millCapacityMtHr: millCapacity,
          operatingHours: hours,
          utilisationPct: utilisation,
          oerPct: oer,
          estimatedFfbMt: estimatedFFB,
          incomingCpoMt: incomingCPO,
          incomingFfaPct: incomingFFA,
          targetFfaPct: target,
        },
        tanks: tanks.map((t) => ({
          name: t.name,
          capacityMt: t.capacity,
          stockMt: t.stock,
          ffaPct: t.ffa,
        })),
        currentAllocationPct: allocation,
        currentPlan: results.map((r) => ({
          name: r.name,
          allocationPct: r.allocation,
          incomingMt: r.incoming,
          finalStockMt: r.finalStock,
          finalFfaPct: r.finalFFA,
          utilisationPct: r.utilisation,
          overflow: r.overflow,
        })),
        recommendedPlan: best ? planToAdvisePayload(best, 1, target) : null,
        alternativePlans: topPlans.slice(1).map((plan, i) => planToAdvisePayload(plan, i + 2, target)),
        flags: {
          allocationTotalPct: allocationTotal,
          allocationValid: allocationTotal === 100,
          hasOverflow,
          highFfaStockMt: highFFAStock,
          currentPlanValid: valid,
        },
        userQuestion: aiQuestion.trim() || undefined,
        language: lang,
      };

      const response = await fetch("/api/advise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await response.json()) as {
        opinion?: string;
        error?: string;
        source?: "openai" | "offline";
      };
      if (!response.ok) {
        throw new Error(data.error ?? copy.ai.errorGeneric);
      }

      setAiOpinion(data.opinion ?? null);
      setAiSource(data.source ?? "openai");
    } catch (error) {
      setAiError(error instanceof Error ? error.message : copy.ai.errorGeneric);
    } finally {
      setAiLoading(false);
    }
  };

  const updateTank = (i: number, key: keyof Tank, value: string | number) =>
    setTanks((p) =>
      p.map((t, j) =>
        j === i
          ? {
              ...t,
              [key]:
                key === "name"
                  ? String(value)
                  : typeof value === "number"
                    ? value
                    : Number(value) || 0,
            }
          : t,
      ),
    );
  const applyPlan = (plan: BlendPlan) => setAllocation(plan.allocation);
  const useSuggested = () => best && applyPlan(best);
  const addTank = () => {
    setTanks((p) => [...p, { name: suggestTankName(p), capacity: 2000, stock: 0, ffa: 0 }]);
    setAllocation((p) => [...p, 0]);
    setExpandedTanks((p) => new Set([...p, tanks.length]));
    setMobileTab("tanks");
  };
  const removeTank = (index: number) => {
    if (tanks.length <= 1) return;
    setTanks((p) => p.filter((_, i) => i !== index));
    setAllocation((p) => p.filter((_, i) => i !== index));
    setExpandedTanks((p) => {
      const next = new Set<number>();
      p.forEach((idx) => {
        if (idx < index) next.add(idx);
        else if (idx > index) next.add(idx - 1);
      });
      return next;
    });
  };
  const toggleTank = (index: number) =>
    setExpandedTanks((p) => {
      const next = new Set(p);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const metrics = (
    <section className="grid grid-cols-4 gap-1.5 sm:gap-3 lg:grid-cols-4">
      <Metric
        icon={<Gauge size={18} />}
        label={copy.metrics.currentStock}
        value={`${n(currentStock, 0)} MT`}
        note={copy.metrics.acrossTanks(tanks.length)}
      />
      <Metric
        icon={<AlertTriangle size={18} />}
        label={copy.metrics.highFfaStock}
        value={`${n(highFFAStock, 0)} MT`}
        note={highFFAStock ? copy.metrics.actionRequired : copy.metrics.goodQuality}
        warning={!!highFFAStock}
      />
      <Metric
        icon={<Droplets size={18} />}
        label={copy.metrics.expectedCpo}
        value={`${n(incomingCPO)} MT`}
        note={copy.metrics.fromFfb(estimatedFFB)}
      />
      <Metric
        icon={<Beaker size={18} />}
        label={copy.metrics.incomingFfa}
        value={`${n(incomingFFA, 2)}%`}
        note={copy.metrics.ffaLimitNote(target)}
        warning={incomingFFA > target}
      />
    </section>
  );

  const forecastPanel = (
    <Panel
      title={copy.forecast.title}
      subtitle={copy.forecast.subtitle}
      icon={<Gauge size={19} />}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <Field label={copy.forecast.capacity} value={millCapacity} onChange={setMillCapacity} unit="MT/hr" />
        <Field label={copy.forecast.operatingHours} value={hours} onChange={setHours} unit="hr" />
        <Field label={copy.forecast.utilisation} value={utilisation} onChange={setUtilisation} unit="%" />
        <Field label={copy.forecast.expectedOer} value={oer} onChange={setOer} unit="%" />
        <Field
          label={copy.forecast.incomingFfa}
          value={incomingFFA}
          onChange={setIncomingFFA}
          unit="%"
          accent
        />
        <Field label={copy.forecast.ffaLimit} value={target} onChange={setTarget} unit="%" />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-[#758078]">{copy.forecast.ffaLimitHint}</p>
    </Panel>
  );

  const allocationBanner = (
    <div
      className={`allocation-status rounded-xl px-4 py-3 ${
        allocationTotal === 100 ? "" : "allocation-status--warn"
      } ${allocationTotal === 100 ? "bg-[#edf5e9] text-[#28553a]" : "bg-[#fff0e7] text-[#92441f]"}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          {allocationTotal === 100 ? (
            <CheckCircle2 size={17} className="shrink-0" />
          ) : (
            <AlertTriangle size={17} className="shrink-0" />
          )}
          {copy.allocation.mustEqual100}
        </span>
        <strong className="shrink-0 text-base">{allocationTotal}%</strong>
      </div>
      <div className="allocation-status__track mt-3">
        <div
          className="allocation-status__fill"
          style={{ width: `${Math.min(100, Math.max(0, allocationTotal))}%` }}
        />
      </div>
    </div>
  );

  const tankActions = (
    <div className="tank-panel-actions">
      <button type="button" onClick={addTank} className="btn-touch border border-[#b9c8bd] bg-white text-[#173f30]">
        <Plus size={16} />
        {copy.allocation.addBst}
      </button>
      <button type="button" onClick={useSuggested} className="btn-touch bg-[#173f30] text-white">
        <Sparkles size={16} />
        {copy.allocation.useBestPlan}
      </button>
    </div>
  );

  const tanksPanel = (
    <Panel
      title={copy.tanks.title}
      subtitle={copy.tanks.subtitle}
      icon={<Droplets size={19} />}
      action={tankActions}
      stackAction
    >
      <div className="tank-panel min-w-0 max-w-full">
        <div className="tank-list">
          {tanks.map((tank, i) => (
            <TankUnitCard
              key={`${tank.name}-${i}`}
              tank={tank}
              result={results[i]}
              index={i}
              allocationPct={allocation[i]}
              incomingCPO={incomingCPO}
              target={target}
              copy={copy}
              canRemove={tanks.length > 1}
              expanded={expandedTanks.has(i)}
              onToggle={() => toggleTank(i)}
              onUpdate={(key, value) => updateTank(i, key, value)}
              onAllocationChange={(v) => setAllocation((p) => p.map((x, j) => (j === i ? v : x)))}
              onRemove={() => removeTank(i)}
            />
          ))}
        </div>
      </div>
      <div className="mt-4">{allocationBanner}</div>
    </Panel>
  );

  const planPanel = (
    <>
      <SmartRecommendation
        copy={copy}
        topPlans={topPlans}
        target={target}
        tanks={tanks}
        valid={valid}
        bestMeetsTarget={bestMeetsTarget}
        highFFAStock={highFFAStock}
        highFfaTankNames={highFfaTankNames}
        incomingCPO={incomingCPO}
        onApplyPlan={(plan) => {
          applyPlan(plan);
          setMobileTab("tanks");
        }}
        aiOpinion={aiOpinion}
        aiSource={aiSource}
        aiLoading={aiLoading}
        aiError={aiError}
        aiCooldown={aiCooldown}
        aiQuestion={aiQuestion}
        onAiQuestionChange={setAiQuestion}
        onGetAiOpinion={fetchAiOpinion}
      />
      <TankerDespatchPlanner
        copy={copy}
        tankerLoadMt={tankerLoadMt}
        onTankerLoadChange={setTankerLoadMt}
        topPlans={topDespatchPlans}
      />
      <DecisionSafeguards
        copy={copy}
        results={results}
        allocationTotal={allocationTotal}
        highFFAStock={highFFAStock}
        target={target}
      />
    </>
  );

  const navItems: { id: MobileTab; label: string; icon: React.ReactNode }[] = [
    { id: "overview", label: copy.nav.overview, icon: <LayoutDashboard size={20} /> },
    { id: "tanks", label: copy.nav.tanks, icon: <Droplets size={20} /> },
    { id: "plan", label: copy.nav.plan, icon: <Sparkles size={20} /> },
  ];

  return (
    <main className="min-h-screen min-w-0 overflow-x-hidden bg-[#f4f6f2] text-[#17231d]">
      <header className="sticky top-0 z-30 border-b border-[#dfe5dc] bg-[#123c2c] text-white">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-3 px-4 py-3 sm:px-7 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#d7f08a] text-[#123c2c]">
                <Droplets size={24} />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-bold sm:text-xl">{copy.appTitle}</h1>
                <p className="truncate text-xs text-[#b9d3c4]">{copy.appSubtitle}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <LanguageToggle lang={lang} onChange={setLanguage} />
              <div className="hidden shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs md:flex">
                <span className="h-2 w-2 rounded-full bg-[#bde85f]" />
                {copy.ready}
              </div>
            </div>
          </div>
          <nav className="top-nav" aria-label="Section navigation">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`top-nav__item ${mobileTab === item.id ? "active" : ""}`}
                onClick={() => setMobileTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-4 py-4 pb-36 sm:px-7 sm:py-6 md:pb-8 xl:pb-6">
        {/* Mobile tab panels */}
        <div className="mobile-panel space-y-4">
          {mobileTab === "overview" && (
            <>
              {metrics}
              {hasOverflow && (
                <AlertBanner
                  title={copy.alerts.overflowTitle}
                  text={copy.alerts.overflowText}
                />
              )}
              {forecastPanel}
              {allocationBanner}
            </>
          )}
          {mobileTab === "tanks" && tanksPanel}
          {mobileTab === "plan" && planPanel}
        </div>

        {/* Desktop layout */}
        <div className="desktop-layout space-y-5">
          {metrics}
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,.75fr)]">
            <div className="space-y-5">
              {forecastPanel}
              {tanksPanel}
            </div>
            <aside className="space-y-5">{planPanel}</aside>
          </div>
        </div>

        <p className="mt-5 pb-2 text-center text-xs leading-relaxed text-[#758078] md:pb-4">
          {copy.footer}
        </p>
      </div>

      {/* Mobile bottom navigation */}
      <nav className="bottom-nav md:hidden" aria-label="Mobile navigation">
        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`bottom-nav__item ${mobileTab === item.id ? "active" : ""}`}
            onClick={() => setMobileTab(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Mobile sticky action bar */}
      <div className="mobile-action-bar md:hidden">
        <button
          type="button"
          onClick={useSuggested}
          className="btn-touch w-full bg-[#173f30] text-white"
        >
          <Sparkles size={16} />
          {copy.allocation.useBestPlan}
        </button>
      </div>
    </main>
  );
}

function Metric({
  icon,
  label,
  value,
  note,
  warning = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  note: string;
  warning?: boolean;
}) {
  return (
    <article
      className={`rounded-xl border bg-white p-2 shadow-sm sm:rounded-2xl sm:p-4 ${
        warning ? "border-[#efc7aa]" : "border-[#dfe5dc]"
      }`}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="text-[9px] font-semibold leading-tight text-[#6c7971] sm:text-xs">{label}</span>
        <span className={`shrink-0 scale-75 sm:scale-100 ${warning ? "text-[#c36331]" : "text-[#2e7652]"}`}>
          {icon}
        </span>
      </div>
      <p className="mt-1 text-sm font-extrabold leading-tight sm:mt-2 sm:text-xl lg:text-2xl">{value}</p>
      <p
        className={`mt-0.5 hidden text-[10px] leading-tight sm:mt-1 sm:block sm:text-xs ${
          warning ? "text-[#b55a2d]" : "text-[#7a867f]"
        }`}
      >
        {note}
      </p>
    </article>
  );
}

function Panel({
  title,
  subtitle,
  icon,
  action,
  stackAction,
  children,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
  stackAction?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 max-w-full rounded-2xl border border-[#d9e2da] bg-white p-4 shadow-sm sm:p-5">
      <div
        className={`mb-5 flex gap-3 ${stackAction ? "flex-col" : "items-start justify-between"}`}
      >
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 shrink-0 text-[#287451]">{icon}</span>
          <div className="min-w-0">
            <h2 className="font-bold">{title}</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-[#758078]">{subtitle}</p>
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function formatNumericValue(value: number) {
  return Number.isFinite(value) ? String(value) : "";
}

function parseNumericDraft(draft: string) {
  if (draft === "" || draft === "." || draft === "-" || draft === "-.") return null;
  const parsed = Number(draft);
  return Number.isFinite(parsed) ? parsed : null;
}

function NumericInput({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? formatNumericValue(value);

  return (
    <input
      aria-label={label}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={display}
      onFocus={() => setDraft(formatNumericValue(value))}
      onChange={(e) => {
        const next = e.target.value;
        if (next === "" || /^-?\d*\.?\d*$/.test(next)) setDraft(next);
      }}
      onBlur={() => {
        if (draft === null) return;
        const parsed = parseNumericDraft(draft);
        if (parsed !== null) onChange(parsed);
        setDraft(null);
      }}
      className={className}
    />
  );
}

function TankNameInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? value;

  return (
    <input
      aria-label={ariaLabel}
      type="text"
      value={display}
      placeholder={placeholder}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft === null) return;
        const trimmed = draft.trim();
        if (trimmed) onChange(trimmed);
        setDraft(null);
      }}
      className="input-touch w-full min-w-0 max-w-full rounded-lg border border-[#dfe5df] bg-white px-3 py-2.5 text-sm font-bold text-[#173f30] outline-none ring-[#88a84e] placeholder:font-normal placeholder:text-[#9aa59f] focus:ring-2"
    />
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  compact?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? value;

  return (
    <label className="block w-full">
      <span
        className={`mb-1 block font-semibold uppercase text-[#7a867f] ${
          compact ? "text-[10px]" : "text-[11px] font-bold text-[#77837c]"
        }`}
      >
        {label}
      </span>
      <div
        className={`input-touch flex rounded-lg border px-3 ${
          compact ? "border-[#dfe5df] bg-white" : "rounded-xl border-[#dce3dd] bg-[#f9faf8]"
        }`}
      >
        <input
          aria-label={label}
          type="text"
          value={display}
          placeholder={placeholder}
          onFocus={() => setDraft(value)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft === null) return;
            const trimmed = draft.trim();
            if (trimmed) onChange(trimmed);
            setDraft(null);
          }}
          className={`min-w-0 flex-1 bg-transparent py-2 outline-none ${
            compact ? "text-sm font-bold" : "text-base font-bold"
          }`}
        />
      </div>
    </label>
  );
}

function Field({
  label,
  value,
  onChange,
  unit,
  accent = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit: string;
  accent?: boolean;
}) {
  return (
    <label className="block w-full">
      <span className="mb-1.5 block text-[11px] font-bold uppercase text-[#77837c]">{label}</span>
      <div
        className={`input-touch flex items-center gap-1.5 rounded-xl border px-3 ${
          accent ? "border-[#e5b18f] bg-[#fff9f5]" : "border-[#dce3dd] bg-[#f9faf8]"
        }`}
      >
        <NumericInput
          label={label}
          value={value}
          onChange={onChange}
          className="numeric-input min-w-0 flex-1 bg-transparent py-2 text-base font-bold outline-none"
        />
        <span className="shrink-0 text-[11px] text-[#7d8982]">{unit}</span>
      </div>
    </label>
  );
}

function MiniField({
  label,
  value,
  onChange,
  unit,
  emphasis = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit: string;
  emphasis?: boolean;
}) {
  return (
    <label className="block min-w-0 max-w-full">
      <span className="field-label">{label}</span>
      <div className={`field-shell ${emphasis ? "field-shell--emphasis" : ""}`}>
        <NumericInput
          label={label}
          value={value}
          onChange={onChange}
          className="numeric-input"
        />
        <span className="shrink-0 text-sm text-[#7a867f]">{unit}</span>
      </div>
    </label>
  );
}

function AllocationField({
  label,
  value,
  incomingCPO,
  onChange,
  incomingLabel,
  showSlider = false,
}: {
  label: string;
  value: number;
  incomingCPO: number;
  onChange: (v: number) => void;
  incomingLabel: string;
  showSlider?: boolean;
}) {
  const mt = n(allocationMt(incomingCPO, value ?? 0));

  return (
    <div className="min-w-0 max-w-full space-y-3">
      <label className="block min-w-0 max-w-full">
        <span className="field-label">{label}</span>
        <div className="field-shell field-shell--emphasis">
          <NumericInput label={label} value={value} onChange={onChange} className="numeric-input" />
          <span className="shrink-0 text-sm font-semibold text-[#7a867f]">%</span>
        </div>
        <p className="mt-1.5 text-sm font-medium text-[#58665e]">
          {incomingLabel}: {mt} MT
        </p>
      </label>
      {showSlider && (
        <label className="block min-w-0 max-w-full">
          <span className="sr-only">{label}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            aria-label={label}
            className="allocation-slider"
          />
        </label>
      )}
    </div>
  );
}

function ReadonlyStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 max-w-full">
      <span className="field-label">{label}</span>
      <p className="text-sm font-bold leading-snug text-[#17231d]">{value}</p>
    </div>
  );
}

function BeforeAfterPanel({
  copy,
  tank,
  result,
  target,
}: {
  copy: Copy;
  tank: Tank;
  result: Result;
  target: number;
}) {
  const ffaImproved = result.finalFFA < tank.ffa;
  const afterFfaClass =
    result.finalFFA > target ? "text-[#a84618]" : ffaImproved ? "text-[#187449]" : "";

  return (
    <div className="tank-compare min-w-0 max-w-full">
      <p className="field-label">{copy.tanks.beforeAfter}</p>
      <div className="tank-compare__grid">
        <div className="tank-compare__block">
          <span className="tank-compare__heading">{copy.tanks.before}</span>
          <p>
            {copy.tanks.stock}: <strong>{n(tank.stock, 0)} MT</strong>
          </p>
          <p>
            {copy.tanks.ffa}: <strong>{n(tank.ffa, 2)}%</strong>
          </p>
        </div>
        <div className="tank-compare__arrow" aria-hidden>
          →
        </div>
        <div className="tank-compare__block">
          <span className="tank-compare__heading">{copy.tanks.after}</span>
          <p>
            {copy.tanks.stock}: <strong>{n(result.finalStock)} MT</strong>
          </p>
          <p>
            {copy.tanks.ffa}:{" "}
            <strong className={afterFfaClass}>{n(result.finalFFA, 2)}%</strong>
          </p>
        </div>
      </div>
    </div>
  );
}

function TankUnitCard({
  tank,
  result,
  index,
  allocationPct,
  incomingCPO,
  target,
  copy,
  canRemove,
  expanded,
  onToggle,
  onUpdate,
  onAllocationChange,
  onRemove,
}: {
  tank: Tank;
  result: Result;
  index: number;
  allocationPct: number;
  incomingCPO: number;
  target: number;
  copy: Copy;
  canRemove: boolean;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (key: keyof Tank, value: string | number) => void;
  onAllocationChange: (value: number) => void;
  onRemove: () => void;
}) {
  const state = tankState(result, target);
  const remainingCapacity = Math.max(0, tank.capacity - result.finalStock);
  const status = statusLabel(state, result.overflow, result.finalFFA, target, copy);

  return (
    <article
      className={`tank-unit ${state}${expanded ? " is-expanded" : ""}`}
      id={`tank-unit-${index}`}
    >
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={copy.tanks.remove(tank.name)}
          title={copy.tanks.remove(tank.name)}
          className="tank-unit__delete remove-tank remove-tank--compact"
        >
          <Trash2 size={14} />
        </button>
      )}

      <div className="tank-unit__summary">
        <button
          type="button"
          className="tank-unit__summary-btn"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={`tank-body-${index}`}
        >
          <TankCylinder fillPct={result.utilisation} state={state} compact />
          <div className="tank-unit__summary-main">
            <p className="tank-unit__summary-name">{tank.name}</p>
            <p className="tank-unit__summary-stats">
              {copy.tanks.stock}: {n(tank.stock, 0)} MT · {copy.tanks.ffa}: {n(tank.ffa, 2)}% ·{" "}
              {copy.tanks.filledAfter(result.utilisation)}
            </p>
          </div>
          <span className={`status-pill shrink-0 ${state}`}>
            {state === "safe" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            {status}
          </span>
          <ChevronDown
            size={18}
            className={`shrink-0 text-[#708078] transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      <div id={`tank-body-${index}`} className="tank-unit__body">
        <section className="tank-unit__identity">
          <div className="tank-unit__identity-head">
            <TankCylinder fillPct={result.utilisation} state={state} />
            <div className="tank-unit__name">
              <TankNameInput
                value={tank.name}
                onChange={(v) => onUpdate("name", v)}
                placeholder={copy.tanks.namePlaceholder}
                ariaLabel={copy.tanks.name}
              />
              <p className="tank-unit__meta">{copy.tanks.filledAfter(result.utilisation)}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className={`status-pill ${state}`}>
                  {state === "safe" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                  {status}
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="tank-unit__readings">
          <div className="tank-unit__readings-grid tank-unit__readings-grid--wide">
            <MiniField
              label={copy.tanks.capacity}
              value={tank.capacity}
              onChange={(v) => onUpdate("capacity", v)}
              unit="MT"
            />
            <MiniField
              label={copy.tanks.stockNow}
              value={tank.stock}
              onChange={(v) => onUpdate("stock", v)}
              unit="MT"
            />
            <MiniField
              label={copy.tanks.ffaNow}
              value={tank.ffa}
              onChange={(v) => onUpdate("ffa", v)}
              unit="%"
            />
          </div>
        </section>

        <section className="tank-unit__allocate">
          <AllocationField
            label={copy.tanks.allocation}
            value={allocationPct}
            incomingCPO={incomingCPO}
            incomingLabel={copy.tanks.incomingQty}
            onChange={onAllocationChange}
            showSlider
          />
          <div className="tank-unit__allocate-results mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
            <ReadonlyStat label={copy.tanks.finalStock} value={`${n(result.finalStock)} MT`} />
            <ReadonlyStat label={copy.tanks.finalFfa} value={`${n(result.finalFFA, 2)}%`} />
            <ReadonlyStat
              label={copy.tanks.remainingCapacity}
              value={`${n(remainingCapacity)} MT`}
            />
          </div>
        </section>

        <section className="tank-unit__compare">
          <BeforeAfterPanel copy={copy} tank={tank} result={result} target={target} />
        </section>

        {canRemove && (
          <div className="tank-unit__remove-mobile md:hidden">
            <button type="button" onClick={onRemove} className="remove-tank remove-tank--wide">
              <Trash2 size={16} />
              {copy.tanks.remove(tank.name)}
            </button>
          </div>
        )}
      </div>
    </article>
  );
}

function Advice({
  icon,
  title,
  text,
  warning = false,
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  warning?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-3.5 ${
        warning ? "border-[#f0cfb9] bg-[#fff8f3]" : "border-[#dfe6df] bg-[#f8faf7]"
      }`}
    >
      <div
        className={`flex items-center gap-2 text-xs font-bold ${
          warning ? "text-[#a85128]" : "text-[#245f43]"
        }`}
      >
        {icon}
        {title}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-[#58665e]">{text}</p>
    </div>
  );
}

function AlertBanner({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-[#efc7aa] bg-[#fff8f3] p-4">
      <AlertTriangle size={20} className="mt-0.5 shrink-0 text-[#c9483e]" />
      <div>
        <p className="font-bold text-[#a4342c]">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-[#7a4a32]">{text}</p>
      </div>
    </div>
  );
}

function PlanOption({
  rank,
  plan,
  tanks,
  target,
  incomingCPO,
  copy,
  highlighted,
  compact = false,
  onApply,
}: {
  rank: number;
  plan: BlendPlan;
  tanks: Tank[];
  target: number;
  incomingCPO: number;
  copy: Copy;
  highlighted: boolean;
  compact?: boolean;
  onApply: () => void;
}) {
  const meetsTarget = plan.results.every((r) => r.finalFFA <= target);
  const maxFfa = Math.max(...plan.results.map((r) => r.finalFFA));

  if (compact) {
    return (
      <div className="rounded-xl border border-[#dfe5dc] bg-[#f9fbf8] p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold text-[#173f30]">{copy.plan.planRank(rank)}</span>
          <button
            type="button"
            onClick={onApply}
            className="rounded-lg bg-[#173f30] px-2 py-1 text-[10px] font-bold text-white"
          >
            {copy.plan.useThisPlan}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {plan.allocation.map((x, i) => (
            <div key={i} className="plan-pill py-2">
              <span className="text-[10px] text-[#708078]">{tanks[i].name}</span>
              <strong>{x}%</strong>
              <span className="text-[10px] text-[#708078]">{n(allocationMt(incomingCPO, x))} MT</span>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[10px] text-[#708078]">
          {meetsTarget ? copy.plan.withinLimit : copy.plan.maxFinalFfa(maxFfa)}
        </p>
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl border p-3 ${
        highlighted ? "border-[#88a84e] bg-[#f6fae9]" : "border-[#dfe5dc] bg-[#f9fbf8]"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold text-[#173f30]">{copy.plan.planRank(rank)}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
            meetsTarget ? "bg-[#d7f08a] text-[#173f30]" : "bg-[#ffceb7] text-[#7c2d12]"
          }`}
        >
          {meetsTarget ? copy.plan.withinLimit : copy.plan.aboveLimitShort}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 min-[400px]:grid-cols-3">
        {plan.allocation.map((x, i) => (
          <div key={i} className="rounded-lg bg-white/80 p-2 text-center">
            <p className="truncate text-[11px] text-[#708078]">{tanks[i].name}</p>
            <p className="text-lg font-extrabold text-[#173f30]">{x}%</p>
            <p className="text-[10px] text-[#708078]">{n(allocationMt(incomingCPO, x))} MT</p>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-[#708078]">{copy.plan.maxFinalFfa(maxFfa)}</p>
      <button
        type="button"
        onClick={onApply}
        className={`btn-touch mt-2 w-full text-sm ${
          highlighted ? "bg-[#173f30] text-white" : "bg-[#d7f08a] text-[#173f30]"
        }`}
      >
        <RefreshCw size={14} />
        {copy.plan.useThisPlan}
      </button>
    </div>
  );
}

function SmartRecommendation({
  copy,
  topPlans,
  target,
  tanks,
  valid,
  bestMeetsTarget,
  highFFAStock,
  highFfaTankNames,
  incomingCPO,
  onApplyPlan,
  aiOpinion,
  aiSource,
  aiLoading,
  aiError,
  aiCooldown,
  aiQuestion,
  onAiQuestionChange,
  onGetAiOpinion,
}: {
  copy: Copy;
  topPlans: BlendPlan[];
  target: number;
  tanks: Tank[];
  valid: boolean;
  bestMeetsTarget: boolean;
  highFFAStock: number;
  highFfaTankNames: string;
  incomingCPO: number;
  onApplyPlan: (plan: BlendPlan) => void;
  aiOpinion: string | null;
  aiSource: "openai" | "offline" | null;
  aiLoading: boolean;
  aiError: string | null;
  aiCooldown: number;
  aiQuestion: string;
  onAiQuestionChange: (value: string) => void;
  onGetAiOpinion: () => void;
}) {
  const aiDisabled = aiLoading || aiCooldown > 0;
  const aiButtonLabel = aiLoading
    ? copy.ai.generating
    : aiCooldown > 0
      ? copy.ai.wait(aiCooldown)
      : copy.ai.ask;
  const best = topPlans[0];
  return (
    <section className="overflow-hidden rounded-2xl border border-[#d9e2da] bg-white shadow-sm">
      <div className="bg-[#173f30] p-4 text-white sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 font-bold">
            <Sparkles size={19} className="text-[#d7f08a]" />
            {copy.plan.smartRecommendation}
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
              valid ? "bg-[#d7f08a] text-[#173f30]" : "bg-[#ffceb7] text-[#7c2d12]"
            }`}
          >
            {valid ? copy.plan.planChecked : copy.plan.checkInput}
          </span>
        </div>
        <h2 className="text-lg font-bold leading-snug sm:text-xl">
          {bestMeetsTarget ? copy.plan.safeAllocation : copy.plan.limitNotAchievable}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[#c9dbd1]">{copy.plan.planBasis}</p>
      </div>
      <div className="p-4 sm:p-5">
        {best ? (
          <>
            <p className="section-label">{copy.plan.recommendedAllocation}</p>
            <div className="mt-3 grid grid-cols-1 gap-2 min-[400px]:grid-cols-2 sm:grid-cols-3">
              {best.allocation.map((x, i) => (
                <div key={i} className="plan-pill">
                  <p className="text-xs text-[#708078]">{tanks[i].name}</p>
                  <p className="mt-1 text-xl font-extrabold text-[#173f30]">{x}%</p>
                  <p className="text-[11px] text-[#708078]">{n(allocationMt(incomingCPO, x))} MT</p>
                </div>
              ))}
            </div>

            {topPlans.length > 1 && (
              <div className="mt-4 hidden lg:block">
                <p className="section-label">{copy.plan.topPlans}</p>
                <div className="mt-2 space-y-2">
                  {topPlans.slice(1).map((plan, i) => (
                    <PlanOption
                      key={plan.allocation.join("-")}
                      rank={i + 2}
                      plan={plan}
                      tanks={tanks}
                      target={target}
                      incomingCPO={incomingCPO}
                      copy={copy}
                      highlighted={false}
                      compact
                      onApply={() => onApplyPlan(plan)}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="mt-5 space-y-3">
              <Advice
                icon={<ShieldCheck size={17} />}
                title={copy.plan.priorityAction}
                text={
                  highFFAStock
                    ? copy.plan.priorityHighFfa(highFFAStock, highFfaTankNames)
                    : copy.plan.priorityAllOk
                }
              />
              <Advice
                icon={<Info size={17} />}
                title={copy.plan.assessment}
                text={
                  bestMeetsTarget ? copy.plan.assessmentMeetsLimit : copy.plan.assessmentMinImpact
                }
              />
              <Advice
                icon={<AlertTriangle size={17} />}
                title={copy.plan.beforeTransfer}
                text={copy.plan.beforeTransferText}
                warning
              />
            </div>
            <button
              type="button"
              onClick={() => onApplyPlan(best)}
              className="btn-touch mt-5 hidden w-full bg-[#d7f08a] text-[#173f30] md:flex"
            >
              <RefreshCw size={16} />
              {copy.allocation.applyRecommended}
            </button>

            <div className="mt-5 space-y-3 lg:hidden">
              <p className="section-label">{copy.plan.topPlans}</p>
              {topPlans.map((plan, i) => (
                <PlanOption
                  key={`mobile-${plan.allocation.join("-")}`}
                  rank={i + 1}
                  plan={plan}
                  tanks={tanks}
                  target={target}
                  incomingCPO={incomingCPO}
                  copy={copy}
                  highlighted={i === 0}
                  onApply={() => onApplyPlan(plan)}
                />
              ))}
            </div>

            <div className="mt-5 border-t border-[#e8ede8] pt-5">
              <p className="section-label">{copy.ai.advisor}</p>
              <p className="mt-1 text-sm text-[#58665e]">{copy.ai.description}</p>
              <textarea
                value={aiQuestion}
                onChange={(e) => onAiQuestionChange(e.target.value)}
                placeholder={copy.ai.questionPlaceholder}
                rows={3}
                maxLength={500}
                className="mt-3 w-full rounded-xl border border-[#dce3dd] bg-[#f9faf8] px-3 py-2.5 text-sm leading-relaxed text-[#17231d] outline-none ring-[#88a84e] placeholder:text-[#9aa59f] focus:ring-2"
              />
              <button
                type="button"
                onClick={onGetAiOpinion}
                disabled={aiDisabled}
                className="btn-touch mt-3 w-full border border-[#b9c8bd] bg-white text-[#173f30] disabled:opacity-60 sm:w-auto"
              >
                {aiLoading ? <Loader2 size={16} className="animate-spin" /> : <Bot size={16} />}
                {aiButtonLabel}
              </button>

              {aiError && (
                <div className="mt-3 rounded-xl border border-[#f0cfb9] bg-[#fff8f3] p-3.5 text-sm text-[#92441f]">
                  {aiError}
                </div>
              )}

              {aiOpinion && (
                <div className="mt-3 rounded-xl border border-[#dfe6df] bg-[#f8faf7] p-4">
                  <div className="mb-2 flex items-center gap-2 text-xs font-bold text-[#245f43]">
                    <Bot size={16} />
                    {aiSource === "offline" ? copy.ai.opinionOffline : copy.ai.opinionLive}
                  </div>
                  <FormattedOpinion text={aiOpinion} />
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-[#8a3d20]">{copy.plan.noFeasiblePlan}</p>
            <div className="mt-5 border-t border-[#e8ede8] pt-5">
              <p className="section-label">{copy.ai.advisor}</p>
              <textarea
                value={aiQuestion}
                onChange={(e) => onAiQuestionChange(e.target.value)}
                placeholder={copy.ai.questionPlaceholder}
                rows={3}
                maxLength={500}
                className="mt-2 w-full rounded-xl border border-[#dce3dd] bg-[#f9faf8] px-3 py-2.5 text-sm leading-relaxed text-[#17231d] outline-none ring-[#88a84e] placeholder:text-[#9aa59f] focus:ring-2"
              />
              <button
                type="button"
                onClick={onGetAiOpinion}
                disabled={aiDisabled}
                className="btn-touch mt-3 w-full border border-[#b9c8bd] bg-white text-[#173f30] disabled:opacity-60"
              >
                {aiLoading ? <Loader2 size={16} className="animate-spin" /> : <Bot size={16} />}
                {aiCooldown > 0 && !aiLoading ? copy.ai.wait(aiCooldown) : aiButtonLabel}
              </button>
              {aiError && (
                <div className="mt-3 rounded-xl border border-[#f0cfb9] bg-[#fff8f3] p-3.5 text-sm text-[#92441f]">
                  {aiError}
                </div>
              )}
              {aiOpinion && (
                <div className="mt-3 rounded-xl border border-[#dfe6df] bg-[#f8faf7] p-4">
                  {aiSource === "offline" && (
                    <div className="mb-2 text-xs font-bold text-[#a85128]">
                      {copy.ai.offlineUnavailable}
                    </div>
                  )}
                  <FormattedOpinion text={aiOpinion} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function TankerDespatchPlanner({
  copy,
  tankerLoadMt,
  onTankerLoadChange,
  topPlans,
}: {
  copy: Copy;
  tankerLoadMt: number;
  onTankerLoadChange: (value: number) => void;
  topPlans: DespatchPlan[];
}) {
  const hasStock = topPlans.length > 0;

  return (
    <section className="mt-4 overflow-hidden rounded-2xl border border-[#d9e2da] bg-white shadow-sm">
      <div className="border-b border-[#e8ede8] bg-[#f8faf7] p-4 sm:p-5">
        <div className="flex items-center gap-2 font-bold text-[#173f30]">
          <Truck size={19} className="text-[#245f43]" />
          {copy.despatch.title}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-[#58665e]">{copy.despatch.subtitle}</p>
        <div className="mt-4 max-w-xs">
          <label className="text-xs font-bold text-[#6c7971]">{copy.despatch.tankerLoad}</label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={1}
              value={tankerLoadMt || ""}
              onChange={(e) => onTankerLoadChange(Number(e.target.value) || 0)}
              className="w-full rounded-xl border border-[#dce3dd] bg-white px-3 py-2.5 text-sm font-semibold text-[#173f30] outline-none ring-[#88a84e] focus:ring-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="shrink-0 text-sm font-bold text-[#58665e]">MT</span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[#758078]">{copy.despatch.tankerLoadHint}</p>
        </div>
      </div>
      <div className="p-4 sm:p-5">
        {!hasStock ? (
          <p className="text-sm leading-relaxed text-[#8a3d20]">
            {tankerLoadMt > 0 ? copy.despatch.noStock : copy.despatch.noPlans}
          </p>
        ) : (
          <>
            <p className="section-label">{copy.despatch.topPlans}</p>
            <div className="mt-3 space-y-3">
              {topPlans.map((plan, i) => (
                <DespatchOption
                  key={plan.sources.map((s) => `${s.name}-${s.mt}`).join("|")}
                  rank={i + 1}
                  plan={plan}
                  copy={copy}
                  highlighted={i === 0}
                />
              ))}
            </div>
            {topPlans[0]?.shortfallMt > 0 && (
              <p className="mt-3 text-sm text-[#92441f]">
                {copy.despatch.shortfall(topPlans[0].shortfallMt)}
              </p>
            )}
            <Advice
              icon={<AlertTriangle size={17} />}
              title={copy.plan.beforeTransfer}
              text={copy.despatch.verifyBeforeLoad}
              warning
            />
          </>
        )}
      </div>
    </section>
  );
}

function DespatchOption({
  rank,
  plan,
  copy,
  highlighted,
}: {
  rank: number;
  plan: DespatchPlan;
  copy: Copy;
  highlighted: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-3 ${
        highlighted ? "border-[#88a84e] bg-[#f6fae9]" : "border-[#dfe5dc] bg-[#f9fbf8]"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold text-[#173f30]">{copy.despatch.planRank(rank)}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
            plan.meetsLimit ? "bg-[#d7f08a] text-[#173f30]" : "bg-[#ffceb7] text-[#7c2d12]"
          }`}
        >
          {plan.meetsLimit ? copy.despatch.withinLimit : copy.despatch.aboveLimitShort}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
        {plan.sources.map((source) => (
          <div key={source.name} className="plan-pill py-2">
            <span className="text-[11px] text-[#708078]">{source.name}</span>
            <strong>{n(source.mt)} MT</strong>
            <span className="text-[10px] text-[#708078]">{n(source.ffaPct, 2)}% FFA</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#708078]">
        <span>{copy.despatch.totalLoad(plan.totalMt)}</span>
        <span>{copy.despatch.loadFfa(plan.loadFfaPct)}</span>
      </div>
    </div>
  );
}

function DecisionSafeguards({
  copy,
  results,
  allocationTotal,
  highFFAStock,
  target,
}: {
  copy: Copy;
  results: Result[];
  allocationTotal: number;
  highFFAStock: number;
  target: number;
}) {
  const checks: [boolean, string][] = [
    [!results.some((r) => r.overflow), copy.safeguards.noOverflow],
    [allocationTotal === 100, copy.safeguards.allocation100],
    [highFFAStock === 0, copy.safeguards.noHighFfa],
    [results.every((r) => r.finalFFA <= target), copy.safeguards.finalFfaWithinLimit(target)],
  ];

  return (
    <section className="rounded-2xl border border-[#d9e2da] bg-white p-4 shadow-sm sm:p-5">
      <p className="section-label">{copy.safeguards.title}</p>
      <div className="mt-4 space-y-3 text-sm">
        {checks.map(([ok, label], i) => (
          <div key={i} className="flex min-h-[44px] items-center justify-between gap-3">
            <span className="leading-snug text-[#53625a]">{label}</span>
            {ok ? (
              <CheckCircle2 size={20} className="shrink-0 text-[#278858]" />
            ) : (
              <AlertTriangle size={20} className="shrink-0 text-[#d2773d]" />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

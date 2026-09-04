"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Image from "next/image";
import {
  AlertTriangle,
  ArrowRightLeft,
  Beaker,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Coins,
  Droplets,
  Gauge,
  Info,
  LayoutDashboard,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Scale,
  ShieldCheck,
  Sparkles,
  Trash2,
  TrendingUp,
  Truck,
  User,
  Wand2,
  X,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AdviseRequest } from "@/lib/advise";
import { findTopDespatchPlans, planToDespatchPayload, type DespatchPlan } from "@/lib/despatch";
import { getCopy, type Copy, type Lang } from "@/lib/i18n";
import { FormattedOpinion } from "@/lib/format-opinion";
import {
  calcPenaltyExposure,
  calcTotalExposure,
  createEmptyBuyerProfile,
  newPenaltyBandId,
  type BuyerProfile,
  type PenaltyBand,
} from "@/lib/penalty";
import {
  DEFAULT_HORIZON_DAYS,
  DEFAULT_RISE_FACTOR_PER_DAY,
  daysUntilLimit,
  projectFfaRise,
} from "@/lib/prediction";
import { suggestSafeProduction, type SafeProductionSuggestion } from "@/lib/production";
import {
  autoMaxTransferPerDayMt,
  compareHoldVsDespatch,
  DEFAULT_MAX_TRANSFER_PER_DAY_MT,
  simulateHoldToTarget,
  type HoldVsDespatch,
  type HoldSimulation,
} from "@/lib/lossOptimizer";
import { planBatchBlend, type BatchBlendResult } from "@/lib/batchBlend";
import type { MillStateInput } from "@/lib/millStore";

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
type MobileTab = "overview" | "production" | "despatch" | "transfer";

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

const n = (v: number, d = 2) =>
  v.toLocaleString("en-MY", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Round every number nested inside an object/array to `decimals` places.
 *  Used right before payloads leave the app (e.g. to the AI advisor) so
 *  downstream consumers never see raw floating-point noise like
 *  6.312304147465437 or 111240.00000000001. */
function roundDeep<T>(value: T, decimals = 2): T {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    const factor = 10 ** decimals;
    return (Math.round((value + Number.EPSILON) * factor) / factor) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => roundDeep(item, decimals)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = roundDeep(val, decimals);
    }
    return out as T;
  }
  return value;
}

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

/** The alternative to splitting incoming CPO by % across tanks: route the
 *  whole batch into ONE tank instead. Operationally simpler — one valve, one
 *  number to record — but if that tank ends up over the limit, it needs a
 *  follow-up dilution (Transfer tab) rather than staying clean on arrival.
 *  Reuses the exact same scoring rule as the split-allocation planner
 *  (scorePlan) so the two approaches are judged on identical terms. */
function findBestSingleTankOption(
  tanks: Tank[],
  incomingCPO: number,
  incomingFFA: number,
  target: number,
): BlendPlan | null {
  const options: BlendPlan[] = [];
  for (let i = 0; i < tanks.length; i += 1) {
    const allocation = tanks.map((_, j) => (j === i ? 100 : 0));
    const plan = scorePlan(tanks, allocation, incomingCPO, incomingFFA, target);
    if (plan) options.push(plan);
  }
  options.sort((a, b) => a.score - b.score);
  return options[0] ?? null;
}

/** Index of the tank with the highest CURRENT FFA reading (before today's
 *  incoming CPO is added), or -1 if there are no tanks. */
function findHighestFfaTankIndex(tanks: Tank[]): number {
  let best = -1;
  tanks.forEach((t, i) => {
    if (best === -1 || t.ffa > tanks[best].ffa) best = i;
  });
  return best;
}

/** Route the whole incoming batch into one specific tank, no matter how it
 *  scores against the alternatives — used for the "consolidate into the
 *  already-high tank" rule, where the target tank is fixed by the rule
 *  rather than chosen by the generic scorer. Returned even if it overflows,
 *  so the UI can show exactly why the tank has no room for this batch. */
function buildSingleTankPlan(
  tanks: Tank[],
  incomingCPO: number,
  incomingFFA: number,
  target: number,
  tankIndex: number,
): BlendPlan | null {
  if (tankIndex < 0 || tankIndex >= tanks.length) return null;
  const allocation = tanks.map((_, j) => (j === tankIndex ? 100 : 0));
  const results = calculate(tanks, allocation, incomingCPO, incomingFFA);
  const excess = results.reduce((s, r) => s + Math.max(0, r.finalFFA - target) * r.finalStock, 0);
  return { allocation, results, score: excess };
}

/** The full "what to do about it, in RM terms" sentence for a tank that's
 *  over the limit — despatch-now cost (with the RM/MT rate and tonnage it
 *  applies to, plus how much dilution was actually tried and how far short
 *  it fell), or hold-and-dilute savings (with exactly what to transfer from
 *  where). Shared by the Allocation strategy card and Smart Recommendation
 *  so the two never phrase the same number two different ways. */
function buildPenaltyDecisionText(
  copy: Copy,
  hasProfile: boolean,
  singleTankFollowUp: HoldVsDespatch | null,
  singleTankBlendPlan: { hold: HoldSimulation; dilutionTankName: string | null } | null,
): string | null {
  if (!hasProfile) return copy.routingStrategy.followUpNoProfile;
  if (!singleTankFollowUp) return null;
  if (singleTankFollowUp.recommendation === "hold" && singleTankFollowUp.bestDay > 0) {
    const info = {
      days: singleTankFollowUp.bestDay,
      transferMt: singleTankFollowUp.bestDayTransferMt,
      dilutionTank: singleTankBlendPlan?.dilutionTankName ?? copy.routingStrategy.unnamedTank,
      incomingMt: singleTankFollowUp.bestDayIncomingMt,
      finalFfaPct: singleTankFollowUp.bestDayFfaPct,
      rm: singleTankFollowUp.savingsRm,
    };
    return singleTankFollowUp.bestDayFullyCompliant
      ? copy.routingStrategy.followUpHold(info)
      : copy.routingStrategy.followUpHoldPartial(info);
  }
  return copy.routingStrategy.followUpDespatchNow({
    tonnageMt: singleTankFollowUp.tankStockMt,
    ffaPct: singleTankFollowUp.tankFfaPct,
    rmPerMt: singleTankFollowUp.despatchNowRmPerMt,
    rm: singleTankFollowUp.despatchNowPenaltyRm,
    triedMt: singleTankFollowUp.hold.transferUsedMt + singleTankFollowUp.hold.incomingUsedMt,
    bestFfaPct: singleTankFollowUp.hold.finalFfaPct,
  });
}

function planToAdvisePayload(
  plan: BlendPlan,
  rank: number,
  target: number,
  penaltyBands?: PenaltyBand[] | null,
) {
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
    ...(penaltyBands
      ? {
          penaltyRm: calcTotalExposure(
            plan.results.map((r) => ({ ffaPct: r.finalFFA, tonnageMt: r.finalStock })),
            penaltyBands,
          ),
        }
      : {}),
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

/** Current-reading FFA badge (good / monitor / high), independent from the
 *  final-blend state used for the card accent. Monitor is a half-percentage-
 *  point buffer above the configured good FFA limit, giving a heads-up
 *  before a tank is officially over limit. */
function currentFfaTier(ffa: number, target: number): TankState {
  if (ffa > target + 0.5) return "critical";
  if (ffa > target) return "warning";
  return "safe";
}

function currentFfaLabel(tier: TankState, copy: Copy) {
  if (tier === "critical") return copy.tanks.highFfa;
  if (tier === "warning") return copy.tanks.monitorFfa;
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
            lang === code ? "bg-white text-[#00713a]" : "text-white/80 hover:text-white"
          }`}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export default function Home() {
  const params = useParams<{ id: string }>();
  const millId = params.id;
  // "loading" until the mill's saved data comes back (or 404s) — every
  // engineer opening this link should see the mill's real current state,
  // never the hardcoded demo data flashing first.
  const [millLoadState, setMillLoadState] = useState<"loading" | "ready" | "not-found" | "error">(
    "loading",
  );
  const hydratedRef = useRef(false);

  const [tanks, setTanks] = useState(initialTanks);
  const [millCapacity, setMillCapacity] = useState(40);
  const [hours, setHours] = useState(20);
  const [utilisation, setUtilisation] = useState(100);
  const [oer, setOer] = useState(19);
  const [incomingFFA, setIncomingFFA] = useState(6.7);
  const [target, setTarget] = useState(4.8);
  const [deadStockMt, setDeadStockMtState] = useState(200);
  const [allocation, setAllocation] = useState([0, 100]);
  const [mobileTab, setMobileTab] = useState<MobileTab>("overview");
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [expandedTanks, setExpandedTanks] = useState<Set<number>>(() => new Set([0]));
  const [aiMessages, setAiMessages] = useState<
    { role: "user" | "assistant"; content: string; source?: "openai" | "offline"; kind?: "deep" }[]
  >([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiCooldown, setAiCooldown] = useState(0);
  const [aiQuestion, setAiQuestion] = useState("");
  // Auto-fired AI explanation for Allocation strategy — separate from the
  // manual "Ask AI" chat above (own loading/error state, never touches
  // aiMessages/aiCooldown) so the two features can't interfere with each
  // other.
  const [aiAllocationSuggestion, setAiAllocationSuggestion] = useState<string | null>(null);
  const [aiAllocationLoading, setAiAllocationLoading] = useState(false);
  const [aiAllocationError, setAiAllocationError] = useState(false);
  const [lang, setLang] = useState<Lang>("en");
  const [tankerLoadMt, setTankerLoadMt] = useState(38);

  const [buyerProfiles, setBuyerProfiles] = useState<BuyerProfile[]>(() => [
    createEmptyBuyerProfile("Buyer 1"),
  ]);
  const [activeProfileId, setActiveProfileId] = useState("");
  const [riseFactorPerDay, setRiseFactorPerDay] = useState(DEFAULT_RISE_FACTOR_PER_DAY);
  const [horizonDays, setHorizonDays] = useState(DEFAULT_HORIZON_DAYS);
  const [preferFewerTanks, setPreferFewerTanks] = useState(true);
  const [showScenarioCompare, setShowScenarioCompare] = useState(false);
  const [scenarios, setScenarios] = useState([
    { id: "b", millCapacity: 40, hours: 22, utilisation: 100, oer: 19, incomingFFA: 6.7 },
    { id: "c", millCapacity: 40, hours: 18, utilisation: 100, oer: 19, incomingFFA: 6.7 },
  ]);
  const [manualMaxTransferPerDayMt, setMaxTransferPerDayMtState] = useState(DEFAULT_MAX_TRANSFER_PER_DAY_MT);
  const [autoTransfer, setAutoTransfer] = useState(true);
  // Whether THIS mill has been through first-time tank setup. Defaults to
  // true so an existing mill (or one still loading) never flashes the
  // onboarding screen — only a freshly created mill starts false.
  const [setupComplete, setSetupComplete] = useState(true);
  const [batchSelected, setBatchSelected] = useState<Set<number>>(
    () => new Set(initialTanks.map((_, i) => i)),
  );

  const copy = getCopy(lang);
  const activeProfile = buyerProfiles.find((p) => p.id === activeProfileId) ?? buyerProfiles[0] ?? null;
  const autoTransferValue = useMemo(() => autoMaxTransferPerDayMt(tanks), [tanks]);
  const maxTransferPerDayMt = autoTransfer ? autoTransferValue : manualMaxTransferPerDayMt;

  // Persistence for every field below now happens centrally (see the load
  // and debounced-save effects further down) — these stay as plain state
  // setters, no more per-field localStorage calls scattered around.
  const updateBuyerProfiles = (updater: (profiles: BuyerProfile[]) => BuyerProfile[]) => {
    setBuyerProfiles((prev) => updater(prev));
  };
  const setActiveProfile = (id: string) => setActiveProfileId(id);
  const changeRiseFactor = (v: number) => setRiseFactorPerDay(v);
  const changeHorizonDays = (v: number) => setHorizonDays(v);
  const changeDeadStockMt = (v: number) => setDeadStockMtState(Math.max(0, v));
  const changeMaxTransferPerDay = (v: number) => {
    setMaxTransferPerDayMtState(v);
    setAutoTransfer(false);
  };
  const useAutoTransfer = () => setAutoTransfer(true);
  const setLanguage = (next: Lang) => setLang(next);
  const highFfaTankNames = tanks
    .filter((t) => t.ffa > target)
    .map((t) => t.name)
    .join(", ");

  // Load this mill's saved state once, on mount / whenever the link changes.
  useEffect(() => {
    if (!millId) return;
    let cancelled = false;
    hydratedRef.current = false;
    setMillLoadState("loading");

    fetch(`/api/mills/${millId}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setMillLoadState("not-found");
          return;
        }
        if (!res.ok) {
          setMillLoadState("error");
          return;
        }
        const state = await res.json();
        setTanks(state.tanks);
        setMillCapacity(state.millCapacity);
        setHours(state.hours);
        setUtilisation(state.utilisation);
        setOer(state.oer);
        setIncomingFFA(state.incomingFFA);
        setTarget(state.target);
        setDeadStockMtState(state.deadStockMt);
        setAllocation(state.allocation);
        setTankerLoadMt(state.tankerLoadMt);
        setBuyerProfiles(state.buyerProfiles);
        setActiveProfileId(state.activeProfileId);
        setRiseFactorPerDay(state.riseFactorPerDay);
        setHorizonDays(state.horizonDays);
        setPreferFewerTanks(state.preferFewerTanks);
        setScenarios(state.scenarios);
        setMaxTransferPerDayMtState(state.manualMaxTransferPerDayMt);
        setAutoTransfer(state.autoTransfer);
        setLang(state.lang);
        setSetupComplete(state.setupComplete ?? true);
        // Marks hydration complete on the NEXT tick, after all the setters
        // above have committed — otherwise the save effect (which watches
        // these same fields) would fire once with stale pre-load values
        // and immediately overwrite what we just fetched.
        setMillLoadState("ready");
      })
      .catch(() => {
        if (!cancelled) setMillLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [millId]);

  useEffect(() => {
    if (millLoadState === "ready") hydratedRef.current = true;
  }, [millLoadState]);

  // Debounced save: any change to the mill's persisted fields is written
  // back a moment after typing/clicking settles, so every other device on
  // this mill's link picks it up on its next load. Skipped entirely until
  // the initial fetch above has actually hydrated state, so we never save
  // the hardcoded demo defaults over a mill's real saved data.
  useEffect(() => {
    if (!millId || !hydratedRef.current || millLoadState !== "ready") return;
    const payload: MillStateInput = {
      tanks,
      millCapacity,
      hours,
      utilisation,
      oer,
      incomingFFA,
      target,
      deadStockMt,
      allocation,
      tankerLoadMt,
      buyerProfiles,
      activeProfileId,
      riseFactorPerDay,
      horizonDays,
      preferFewerTanks,
      scenarios,
      manualMaxTransferPerDayMt,
      autoTransfer,
      lang,
      setupComplete,
    };
    const timer = setTimeout(() => {
      fetch(`/api/mills/${millId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {
        // Best-effort — a transient failure here isn't worth interrupting
        // the engineer's work with an error banner; the next change will
        // simply try saving again.
      });
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    millId,
    millLoadState,
    tanks,
    millCapacity,
    hours,
    utilisation,
    oer,
    incomingFFA,
    target,
    deadStockMt,
    allocation,
    tankerLoadMt,
    buyerProfiles,
    activeProfileId,
    riseFactorPerDay,
    horizonDays,
    preferFewerTanks,
    scenarios,
    manualMaxTransferPerDayMt,
    autoTransfer,
    lang,
    setupComplete,
  ]);

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
  // Consolidation rule: once incoming FFA is above THIS MILL'S OWN good FFA
  // limit (target) — not a fixed number — the plan is to send the whole
  // batch into the tank that is ALREADY the highest FFA (deliberately, not
  // by accident) and blend it down separately afterwards, rather than let
  // the generic scorer nudge every tank's FFA up a little. Tied to target
  // because "high FFA" only means anything relative to the limit a mill has
  // actually set for itself.
  const highFfaTankIndex = useMemo(() => findHighestFfaTankIndex(tanks), [tanks]);
  const consolidateRuleApplies =
    incomingFFA > target &&
    highFfaTankIndex >= 0 &&
    tanks[highFfaTankIndex].ffa > target;
  const consolidatePlan = useMemo(
    () =>
      consolidateRuleApplies
        ? buildSingleTankPlan(tanks, incomingCPO, incomingFFA, target, highFfaTankIndex)
        : null,
    [consolidateRuleApplies, tanks, incomingCPO, incomingFFA, target, highFfaTankIndex],
  );
  // If the high-FFA tank has no room left for today's batch, consolidating
  // isn't an option at all — that's the "no option, split across tanks" case.
  const consolidateOverflow = !!consolidatePlan?.results[highFfaTankIndex]?.overflow;
  // Tank with the most remaining capacity — the "best chance" single-tank
  // target to show when NO single tank can actually fit today's batch
  // without overflow, so there's still something concrete to point at
  // ("this tank, and it's still X MT short") rather than an empty card.
  const mostSpareCapacityIndex = useMemo(() => {
    let bestIdx = -1;
    tanks.forEach((t, i) => {
      const spare = t.capacity - t.stock;
      if (bestIdx === -1 || spare > tanks[bestIdx].capacity - tanks[bestIdx].stock) bestIdx = i;
    });
    return bestIdx;
  }, [tanks]);
  const genericSingleTank = useMemo(() => {
    const scored = findBestSingleTankOption(tanks, incomingCPO, incomingFFA, target);
    if (scored) return scored;
    return buildSingleTankPlan(tanks, incomingCPO, incomingFFA, target, mostSpareCapacityIndex);
  }, [tanks, incomingCPO, incomingFFA, target, mostSpareCapacityIndex]);
  const bestSingleTank = consolidateRuleApplies ? consolidatePlan : genericSingleTank;
  const genericSingleIndex = genericSingleTank?.allocation.findIndex((v) => v === 100) ?? -1;
  const genericSingleOverflow = !!genericSingleTank?.results[genericSingleIndex]?.overflow;
  // Mills here can't split incoming flow precisely between tanks — in
  // practice everything goes into one tank, then gets blended down
  // afterward. So single-tank routing is the default recommendation
  // essentially always; splitting across tanks is only ever forced when
  // there's genuinely no single tank with room for today's batch.
  const forceSplitFallback = consolidateRuleApplies ? consolidateOverflow : genericSingleOverflow;
  const singleIndexForRecommendation = bestSingleTank?.allocation.findIndex((v) => v === 100) ?? -1;
  const recommendSingle = !forceSplitFallback;
  const allocationTotal = allocation.reduce((a, b) => a + b, 0);
  const currentStock = tanks.reduce((s, t) => s + t.stock, 0);
  const highFFAStock = tanks.filter((t) => t.ffa > target).reduce((s, t) => s + t.stock, 0);
  const valid = allocationTotal === 100 && !results.some((r) => r.overflow);
  const bestMeetsTarget = !!best && best.results.every((r) => r.finalFFA <= target);
  const hasOverflow = results.some((r) => r.overflow);
  const projectedBlendFfa = best
    ? (() => {
        const totalStock = best.results.reduce((s, r) => s + r.finalStock, 0);
        return totalStock > 0
          ? best.results.reduce((s, r) => s + r.finalFFA * r.finalStock, 0) / totalStock
          : incomingFFA;
      })()
    : incomingFFA;
  const blendConfidence: "high" | "medium" | "low" = !best
    ? "low"
    : bestMeetsTarget && !hasOverflow
      ? "high"
      : !hasOverflow
        ? "medium"
        : "low";
  const blendAtRisk = incomingFFA > target || highFFAStock > 0;
  // Dispatchable stock excludes the dead stock reserve — the bottom layer of
  // a tank is never shipped, since quality near-empty is unreliable.
  const despatchTanks = useMemo(
    () =>
      results.map((r) => ({
        name: r.name,
        stockMt: Math.max(0, r.finalStock - deadStockMt),
        ffaPct: r.finalFFA,
      })),
    [results, deadStockMt],
  );
  // Ship from good-FFA tanks first — tanks already over the limit are excluded
  // as despatch sources here (they belong on the Loss Optimizer / Transfer flow
  // instead, not mixed into a tanker load).
  const goodFfaDespatchTanks = useMemo(
    () => despatchTanks.filter((t) => t.ffaPct <= target),
    [despatchTanks, target],
  );
  const topDespatchPlans = useMemo(
    () => findTopDespatchPlans(goodFfaDespatchTanks, tankerLoadMt, target, 3, preferFewerTanks),
    [goodFfaDespatchTanks, tankerLoadMt, target, preferFewerTanks],
  );

  const penaltyPerTank = useMemo(
    () =>
      activeProfile
        ? results.map((r) => ({
            name: r.name,
            ...calcPenaltyExposure(r.finalFFA, r.finalStock, activeProfile.bands),
          }))
        : [],
    [results, activeProfile],
  );
  const totalPenaltyExposureRm = useMemo(
    () =>
      activeProfile
        ? calcTotalExposure(
            results.map((r) => ({ ffaPct: r.finalFFA, tonnageMt: r.finalStock })),
            activeProfile.bands,
          )
        : 0,
    [results, activeProfile],
  );
  const despatchPenaltyRm = useMemo(() => {
    if (!activeProfile || !topDespatchPlans[0]) return 0;
    return calcTotalExposure(
      topDespatchPlans[0].sources.map((s) => ({ ffaPct: s.ffaPct, tonnageMt: s.mt })),
      activeProfile.bands,
    );
  }, [activeProfile, topDespatchPlans]);

  const ffaProjections = useMemo(
    () =>
      results.map((r) => ({
        name: r.name,
        points: projectFfaRise(r.finalFFA, incomingFFA, riseFactorPerDay, horizonDays),
        daysToLimit: daysUntilLimit(r.finalFFA, incomingFFA, riseFactorPerDay, target, horizonDays),
      })),
    [results, incomingFFA, riseFactorPerDay, horizonDays, target],
  );

  const safeProduction = useMemo<SafeProductionSuggestion>(
    () => suggestSafeProduction(tanks, target, incomingFFA, millCapacity, hours, utilisation, oer),
    [tanks, target, incomingFFA, millCapacity, hours, utilisation, oer],
  );

  const lossOptimizerResults = useMemo<HoldVsDespatch[]>(() => {
    if (!activeProfile) return [];
    return tanks
      .map((tank, i) => {
        if (tank.ffa <= target) return null;
        const others = tanks.filter((_, j) => j !== i);
        return compareHoldVsDespatch(
          tank,
          others,
          target,
          incomingCPO,
          incomingFFA,
          riseFactorPerDay,
          maxTransferPerDayMt,
          activeProfile.bands,
          deadStockMt,
        );
      })
      .filter((r): r is HoldVsDespatch => r !== null);
  }, [tanks, target, incomingCPO, incomingFFA, riseFactorPerDay, maxTransferPerDayMt, activeProfile, deadStockMt]);

  // If routing 100% into one tank leaves it over the limit, don't just say
  // "sort it out later" — reuse the same despatch-vs-hold engine the Loss
  // Optimizer uses, so the recommendation names a concrete number: despatch
  // now for RM X, or hold and dilute over N days to save RM Y.
  const singleTankFollowUp = useMemo<HoldVsDespatch | null>(() => {
    if (!bestSingleTank || !activeProfile) return null;
    const singleIndex = bestSingleTank.allocation.findIndex((v) => v === 100);
    if (singleIndex < 0) return null;
    const result = bestSingleTank.results[singleIndex];
    if (result.finalFFA <= target) return null;
    const resultingTank = { name: result.name, capacity: result.capacity, stock: result.finalStock, ffa: result.finalFFA };
    const others = tanks.filter((_, j) => j !== singleIndex);
    return compareHoldVsDespatch(
      resultingTank,
      others,
      target,
      incomingCPO,
      incomingFFA,
      riseFactorPerDay,
      maxTransferPerDayMt,
      activeProfile.bands,
      deadStockMt,
    );
  }, [bestSingleTank, tanks, target, incomingCPO, incomingFFA, riseFactorPerDay, maxTransferPerDayMt, activeProfile, deadStockMt]);

  // The concrete "how much to blend and what FFA it lands on" plan for the
  // single-tank route — available with or without a buyer profile, since it
  // doesn't need pricing. Considers all three FFA readings the blend-later
  // decision actually turns on: today's incoming FFA, the high-FFA tank being
  // filled, and the good-FFA tank used to dilute it back down.
  const singleTankBlendPlan = useMemo<{ hold: HoldSimulation; dilutionTankName: string | null } | null>(() => {
    if (!bestSingleTank) return null;
    const singleIndex = bestSingleTank.allocation.findIndex((v) => v === 100);
    if (singleIndex < 0) return null;
    const result = bestSingleTank.results[singleIndex];
    if (result.finalFFA <= target) return null;
    const resultingTank = { name: result.name, capacity: result.capacity, stock: result.finalStock, ffa: result.finalFFA };
    const others = tanks.filter((_, j) => j !== singleIndex);
    const dilutionTank = others.filter((t) => t.ffa < target).sort((a, b) => a.ffa - b.ffa)[0] ?? null;
    const hold = simulateHoldToTarget(
      resultingTank,
      others,
      target,
      incomingCPO,
      incomingFFA,
      riseFactorPerDay,
      maxTransferPerDayMt,
      30,
      deadStockMt,
    );
    return { hold, dilutionTankName: dilutionTank?.name ?? null };
  }, [bestSingleTank, tanks, target, incomingCPO, incomingFFA, riseFactorPerDay, maxTransferPerDayMt, deadStockMt]);

  const batchBlendTanks = useMemo(
    () => tanks.filter((_, i) => batchSelected.has(i)),
    [tanks, batchSelected],
  );
  const batchBlendResult = useMemo<BatchBlendResult | null>(() => {
    if (batchBlendTanks.length < 2) return null;
    return planBatchBlend(batchBlendTanks, target, maxTransferPerDayMt, 30, deadStockMt);
  }, [batchBlendTanks, target, maxTransferPerDayMt, deadStockMt]);

  const scenarioResults = useMemo(
    () =>
      scenarios.map((s) => {
        const ffb = (s.millCapacity * s.hours * s.utilisation) / 100;
        const cpo = (ffb * s.oer) / 100;
        const plans = findTopPlans(tanks, cpo, s.incomingFFA, target);
        const scenarioBest = plans[0] ?? null;
        return {
          id: s.id,
          incomingCpo: cpo,
          meetsTarget: scenarioBest ? scenarioBest.results.every((r) => r.finalFFA <= target) : false,
          overflow: scenarioBest ? scenarioBest.results.some((r) => r.overflow) : true,
          feasible: !!scenarioBest,
        };
      }),
    [scenarios, tanks, target],
  );

  useEffect(() => {
    setAiMessages([]);
    setAiError(null);
  }, [
    tanks,
    allocation,
    millCapacity,
    hours,
    utilisation,
    oer,
    incomingFFA,
    target,
    incomingCPO,
    topPlans,
    tankerLoadMt,
    topDespatchPlans,
    activeProfileId,
    riseFactorPerDay,
    horizonDays,
    maxTransferPerDayMt,
    batchSelected,
  ]);

  useEffect(() => {
    if (aiCooldown <= 0) return;
    const timer = window.setInterval(() => {
      setAiCooldown((seconds) => (seconds <= 1 ? 0 : seconds - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [aiCooldown]);

  /** Everything the AI advisor needs to reason about the current situation —
   *  shared by the manual "Ask AI" chat and the auto-fired Allocation
   *  strategy explanation below, so the two never see a different picture. */
  const buildAdvisePayload = (
    question: string | undefined,
    history: { role: "user" | "assistant"; content: string }[],
    deepAnalysis?: boolean,
    // When given, this plan is sent as "the recommended plan" instead of
    // `best` (the split-scored plan) — used for the Allocation strategy
    // auto-suggestion so the AI is told the SAME thing the card is
    // actually showing, and can't reason its way to a contradictory
    // answer. `best` is still included as an alternative either way.
    recommendedPlanOverride?: BlendPlan,
  ): AdviseRequest => {
    const recommended = recommendedPlanOverride ?? best;
    const alternatives = recommendedPlanOverride
      ? [best, ...topPlans.slice(1)].filter(
          (p): p is BlendPlan => !!p && !sameAllocation(p.allocation, recommendedPlanOverride.allocation),
        )
      : topPlans.slice(1);
    return {
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
        recommendedPlan: recommended ? planToAdvisePayload(recommended, 1, target, activeProfile?.bands) : null,
        alternativePlans: alternatives.map((plan, i) =>
          planToAdvisePayload(plan, i + 2, target, activeProfile?.bands),
        ),
        despatch: {
          tankerLoadMt: tankerLoadMt,
          recommendedPlan: topDespatchPlans[0]
            ? planToDespatchPayload(topDespatchPlans[0], 1)
            : null,
          alternativePlans: topDespatchPlans
            .slice(1)
            .map((plan, i) => planToDespatchPayload(plan, i + 2)),
        },
        flags: {
          allocationTotalPct: allocationTotal,
          allocationValid: allocationTotal === 100,
          hasOverflow,
          highFfaStockMt: highFFAStock,
          currentPlanValid: valid,
        },
        penalty: activeProfile
          ? {
              buyerName: activeProfile.name,
              totalExposureRm: totalPenaltyExposureRm,
              perTank: penaltyPerTank.map(({ name, rmPerMt, totalRm }) => ({ name, rmPerMt, totalRm })),
            }
          : null,
        prediction: {
          riseFactorPerDay,
          horizonDays,
          tanks: ffaProjections.map((p) => ({ name: p.name, daysUntilLimit: p.daysToLimit })),
        },
        productionSuggestion: {
          maxSafeIncomingCpoMt: safeProduction.maxSafeIncomingCpoMt,
          binding: safeProduction.binding,
          suggestedHoursAtCurrentUtilisation: safeProduction.suggestedHoursAtCurrentUtilisation,
          suggestedUtilisationPctAtCurrentHours: safeProduction.suggestedUtilisationPctAtCurrentHours,
        },
        lossOptimizer: lossOptimizerResults.map((r) => ({
          tankName: r.tankName,
          despatchNowPenaltyRm: r.despatchNowPenaltyRm,
          holdFeasible: r.hold.feasible,
          holdDays: r.hold.days,
          holdPenaltyRm: r.holdPenaltyRm,
          savingsRm: r.savingsRm,
          recommendation: r.recommendation,
          bestDay: r.bestDay,
          bestDayFfaPct: r.bestDayFfaPct,
          bestDayFullyCompliant: r.bestDayFullyCompliant,
        })),
        batchBlend: batchBlendResult
          ? {
              feasible: batchBlendResult.feasible,
              days: batchBlendResult.days,
              reason: batchBlendResult.reason,
              steps: batchBlendResult.steps.map((s) => ({
                day: s.day,
                fromTank: s.fromTank,
                toTank: s.toTank,
                mt: s.mt,
              })),
            }
          : null,
        conversationHistory: history,
        userQuestion: question || undefined,
        language: lang,
        deepAnalysis,
        currentTab: mobileTab,
      };
  };

  const fetchAiOpinion = async (opts: { deepAnalysis?: boolean } = {}) => {
    if (aiLoading || aiCooldown > 0) return;
    const question = aiQuestion.trim();
    const historyForRequest = aiMessages.map((m) => ({ role: m.role, content: m.content }));
    if (question) {
      setAiMessages((prev) => [...prev, { role: "user", content: question }]);
    }
    setAiQuestion("");
    setAiLoading(true);
    setAiError(null);
    setAiCooldown(60);
    try {
      const payload = buildAdvisePayload(question, historyForRequest, opts.deepAnalysis);
      const response = await fetch("/api/advise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(roundDeep(payload, 2)),
      });

      const data = (await response.json()) as {
        opinion?: string;
        error?: string;
        source?: "openai" | "offline";
      };
      if (!response.ok) {
        throw new Error(data.error ?? copy.ai.errorGeneric);
      }

      setAiMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.opinion ?? "",
          source: data.source ?? "openai",
          kind: opts.deepAnalysis ? "deep" : undefined,
        },
      ]);
    } catch (error) {
      setAiError(error instanceof Error ? error.message : copy.ai.errorGeneric);
    } finally {
      setAiLoading(false);
    }
  };

  // Auto-fire an AI explanation for the Allocation strategy recommendation
  // whenever the underlying situation actually changes — debounced so
  // typing in the production forecast doesn't spam the AI service. The
  // deterministic recommendation (recommendSingle, recommendationText) is
  // computed instantly either way; this only replaces the wording shown
  // with the AI's explanation once it's back, and falls back cleanly if the
  // AI call fails.
  useEffect(() => {
    if (!best || !bestSingleTank || incomingCPO <= 0) {
      setAiAllocationSuggestion(null);
      setAiAllocationLoading(false);
      setAiAllocationError(false);
      return;
    }
    setAiAllocationLoading(true);
    setAiAllocationError(false);
    const timer = setTimeout(() => {
      const singleTank = tanks[singleIndexForRecommendation];
      const question = forceSplitFallback
        ? copy.routingStrategy.aiQuestionForceSplit(singleTank?.name ?? "")
        : consolidateRuleApplies
          ? copy.routingStrategy.aiQuestionConsolidate(singleTank?.name ?? "")
          : recommendSingle
            ? copy.routingStrategy.aiQuestionSingle(singleTank?.name ?? "")
            : copy.routingStrategy.aiQuestionSplit;
      // Tell the AI the SAME plan the card is actually showing as
      // recommended — otherwise it reasons from the generic split-scored
      // plan and can contradict the card it's meant to be explaining.
      const payload = buildAdvisePayload(
        question,
        [],
        false,
        recommendSingle ? (bestSingleTank ?? undefined) : (best ?? undefined),
      );
      fetch("/api/advise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(roundDeep(payload, 2)),
      })
        .then(async (res) => {
          const data = (await res.json()) as { opinion?: string; error?: string; source?: "openai" | "offline" };
          if (!res.ok || !data.opinion || data.source === "offline") {
            throw new Error(data.error ?? "unavailable");
          }
          setAiAllocationSuggestion(data.opinion);
        })
        .catch(() => {
          setAiAllocationError(true);
          setAiAllocationSuggestion(null);
        })
        .finally(() => setAiAllocationLoading(false));
    }, 1200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tanks, incomingCPO, incomingFFA, target, recommendSingle, singleIndexForRecommendation, lang]);

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
  const transferStock = (sourceIndex: number, destIndex: number, amountMt: number) => {
    setTanks((prev) => {
      const source = prev[sourceIndex];
      const dest = prev[destIndex];
      if (!source || !dest || sourceIndex === destIndex || amountMt <= 0) return prev;
      const sourceNewStock = Math.max(0, source.stock - amountMt);
      const destNewStock = dest.stock + amountMt;
      const destNewFfa = destNewStock > 0 ? (dest.stock * dest.ffa + amountMt * source.ffa) / destNewStock : dest.ffa;
      return prev.map((t, i) => {
        if (i === sourceIndex) return { ...t, stock: sourceNewStock };
        if (i === destIndex) return { ...t, stock: destNewStock, ffa: destNewFfa };
        return t;
      });
    });
  };
  const addTank = () => {
    setTanks((p) => [...p, { name: suggestTankName(p), capacity: 2000, stock: 0, ffa: 0 }]);
    setAllocation((p) => [...p, 0]);
    setExpandedTanks((p) => new Set([...p, tanks.length]));
    setBatchSelected((p) => new Set([...p, tanks.length]));
    setMobileTab("production");
  };
  const removeTank = (index: number) => {
    if (tanks.length <= 1) return;
    setTanks((p) => p.filter((_, i) => i !== index));
    setAllocation((p) => p.filter((_, i) => i !== index));
    const reindex = (p: Set<number>) => {
      const next = new Set<number>();
      p.forEach((idx) => {
        if (idx < index) next.add(idx);
        else if (idx > index) next.add(idx - 1);
      });
      return next;
    };
    setExpandedTanks(reindex);
    setBatchSelected(reindex);
  };
  const toggleTank = (index: number) =>
    setExpandedTanks((p) => {
      const next = new Set(p);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const metrics = (
    <section className="grid grid-cols-2 gap-1.5 sm:gap-3 lg:grid-cols-4">
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
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <Field label={copy.forecast.capacity} value={millCapacity} onChange={setMillCapacity} unit="MT/hr" />
        <Field label={copy.forecast.operatingHours} value={hours} onChange={setHours} unit="hr" />
        <Field label={copy.forecast.utilisation} value={utilisation} onChange={setUtilisation} unit="%" />
        <Field label={copy.forecast.expectedOer} value={oer} onChange={setOer} unit="%" />
        <ReadOnlyField label={copy.forecast.cpoProduced} value={n(incomingCPO, 2)} unit="MT" />
        <Field
          label={copy.forecast.incomingFfa}
          value={incomingFFA}
          onChange={setIncomingFFA}
          unit="%"
          accent
        />
        <Field label={copy.forecast.ffaLimit} value={target} onChange={setTarget} unit="%" />
        <Field label={copy.forecast.deadStock} value={deadStockMt} onChange={changeDeadStockMt} unit="MT" />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-[#758078]">
        {copy.forecast.ffaLimitHint} {copy.forecast.deadStockHint}
      </p>
    </Panel>
  );

  const productionOptimizerPanel = (
    <ProductionOptimizer
      copy={copy}
      suggestion={safeProduction}
      showScenarioCompare={showScenarioCompare}
      onToggleScenarioCompare={() => setShowScenarioCompare((v) => !v)}
      scenarios={scenarios}
      scenarioResults={scenarioResults}
      onScenarioChange={(id, key, value) =>
        setScenarios((prev) => prev.map((s) => (s.id === id ? { ...s, [key]: value } : s)))
      }
      baselineIncomingCpo={incomingCPO}
      baselineMeetsTarget={bestMeetsTarget}
      baselineOverflow={hasOverflow}
    />
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
      <button type="button" onClick={useSuggested} className="btn-touch bg-[#00b14f] text-white shadow-[0_4px_14px_rgba(0,177,79,0.35)] hover:bg-[#00a047]">
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

  const ffaForecastPanel = (
    <FfaForecastPanel
      copy={copy}
      projections={ffaProjections}
      target={target}
      riseFactorPerDay={riseFactorPerDay}
      onRiseFactorChange={changeRiseFactor}
      horizonDays={horizonDays}
      onHorizonChange={changeHorizonDays}
    />
  );

  const penaltyPanel = (
    <PenaltyPanel
      copy={copy}
      profiles={buyerProfiles}
      activeProfile={activeProfile}
      onSelectProfile={setActiveProfile}
      onUpdateProfiles={updateBuyerProfiles}
      penaltyPerTank={penaltyPerTank}
      totalExposureRm={totalPenaltyExposureRm}
    />
  );

  const productionPanel = (
    <>
      {forecastPanel}
      <RoutingStrategyCard
        copy={copy}
        tanks={tanks}
        target={target}
        incomingCPO={incomingCPO}
        best={best}
        bestSingleTank={bestSingleTank}
        consolidateRuleApplies={consolidateRuleApplies}
        forceSplitFallback={forceSplitFallback}
        recommendSingle={recommendSingle}
        aiSuggestion={aiAllocationSuggestion}
        aiLoading={aiAllocationLoading}
        aiError={aiAllocationError}
        onApplySingle={() => bestSingleTank && applyPlan(bestSingleTank)}
        onApplySplit={() => best && applyPlan(best)}
      />
      <div className="grid gap-4 xl:grid-cols-2 xl:items-start">
        {tanksPanel}
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
          allocation={allocation}
          onApplyPlan={(plan) => applyPlan(plan)}
          aiMessages={aiMessages}
          aiLoading={aiLoading}
          aiError={aiError}
          aiCooldown={aiCooldown}
          aiQuestion={aiQuestion}
          onAiQuestionChange={setAiQuestion}
          onGetAiOpinion={fetchAiOpinion}
          onClearChat={() => {
            setAiMessages([]);
            setAiError(null);
          }}
          penaltyBands={activeProfile?.bands}
          bestSingleTank={bestSingleTank}
          singleTankBlendPlan={singleTankBlendPlan}
          singleTankFollowUp={singleTankFollowUp}
          hasProfile={!!activeProfile}
          onApplySingle={() => bestSingleTank && applyPlan(bestSingleTank)}
          autoAiSuggestion={aiAllocationSuggestion}
          autoAiLoading={aiAllocationLoading}
          autoAiError={aiAllocationError}
        />
      </div>
    </>
  );

  const despatchPanel = (
    <>
      {penaltyPanel}
      <RefineryDespatchTable
        copy={copy}
        profiles={buyerProfiles}
        defaultFfaPct={topDespatchPlans[0]?.loadFfaPct ?? target}
        tankerLoadMt={tankerLoadMt}
        onTankerLoadChange={setTankerLoadMt}
      />
      <LossOptimizerPanel
        copy={copy}
        results={lossOptimizerResults}
        hasProfile={!!activeProfile}
        maxTransferPerDayMt={maxTransferPerDayMt}
        onMaxTransferChange={changeMaxTransferPerDay}
        autoTransfer={autoTransfer}
        onUseAuto={useAutoTransfer}
      />
    </>
  );

  const transferPanel = (
    <>
      <SimpleTransferCalculator copy={copy} tanks={tanks} deadStockMt={deadStockMt} onTransfer={transferStock} />
      <details className="advanced-disclosure">
        <summary>{copy.transferCalc.advanced}</summary>
        <div className="mt-4">
          <BatchBlendPlanner
            copy={copy}
            tanks={tanks}
            selected={batchSelected}
            onToggleTank={(i) =>
              setBatchSelected((p) => {
                const next = new Set(p);
                if (next.has(i)) next.delete(i);
                else next.add(i);
                return next;
              })
            }
            target={target}
            maxTransferPerDayMt={maxTransferPerDayMt}
            onMaxTransferChange={changeMaxTransferPerDay}
            autoTransfer={autoTransfer}
            onUseAuto={useAutoTransfer}
            result={batchBlendResult}
          />
        </div>
      </details>
    </>
  );

  const navItems: { id: MobileTab; label: string; icon: React.ReactNode }[] = [
    { id: "overview", label: copy.nav.overview, icon: <LayoutDashboard size={20} /> },
    { id: "production", label: copy.nav.production, icon: <Droplets size={20} /> },
    { id: "despatch", label: copy.nav.despatch, icon: <Truck size={20} /> },
    { id: "transfer", label: copy.nav.transfer, icon: <ArrowRightLeft size={20} /> },
  ];

  if (millLoadState === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f4f6f2] text-[#17231d]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 size={28} className="animate-spin text-[#00713a]" />
          <p className="text-sm text-[#58665e]">Loading your mill's saved data…</p>
        </div>
      </main>
    );
  }

  if (millLoadState === "not-found") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f4f6f2] px-6 text-[#17231d]">
        <div className="max-w-sm rounded-2xl border border-[#dfe5dc] bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-bold">No mill found at this link</h1>
          <p className="mt-2 text-sm text-[#58665e]">
            This link doesn&apos;t match any saved mill. Check that you copied the full URL, or set up a
            new mill from the home page.
          </p>
          <a
            href="/"
            className="btn-touch mt-5 inline-flex bg-[#00713a] text-white"
          >
            Go to home page
          </a>
        </div>
      </main>
    );
  }

  if (millLoadState === "error") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f4f6f2] px-6 text-[#17231d]">
        <div className="max-w-sm rounded-2xl border border-[#f0cfb9] bg-[#fff8f3] p-6 text-center shadow-sm">
          <h1 className="text-lg font-bold text-[#92441f]">Couldn&apos;t load this mill</h1>
          <p className="mt-2 text-sm text-[#92441f]">
            Something went wrong reaching the server. Check your connection and reload the page.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-touch mt-5 inline-flex bg-[#173f30] text-white"
          >
            Reload
          </button>
        </div>
      </main>
    );
  }

  if (!setupComplete) {
    return (
      <MillSetupScreen
        copy={copy}
        tanks={tanks}
        onUpdateTank={updateTank}
        onAddTank={addTank}
        onRemoveTank={removeTank}
        onFinish={() => setSetupComplete(true)}
      />
    );
  }

  return (
    <main className="min-h-screen min-w-0 overflow-x-hidden bg-[#f4f6f2] text-[#17231d]">
      <header className="sticky top-0 z-30 border-b border-[#dfe5dc] bg-[#123c2c] text-white">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-3 px-4 py-3 sm:px-7 sm:py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#00b14f] text-white shadow-[0_4px_14px_rgba(0,177,79,0.45)]">
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
                <span className="h-2 w-2 rounded-full bg-[#00e676]" />
                {copy.ready}
              </div>
            </div>
          </div>
          <nav className="top-nav" aria-label="Section navigation">
            {navItems.map((item, i) => (
              <button
                key={item.id}
                type="button"
                className={`top-nav__item ${mobileTab === item.id ? "active" : ""}`}
                onClick={() => setMobileTab(item.id)}
              >
                <span className="top-nav__step">{i + 1}</span>
                {item.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-[1400px] px-4 py-4 pb-36 sm:px-7 sm:py-6 md:pb-8 xl:pb-10">
        <FlowHint copy={copy} activeTab={mobileTab} />
        {/* Tab panel — same one-job-per-screen flow at every screen size */}
        <div className="app-panel space-y-4">
          {mobileTab === "overview" && (
            <>
              {metrics}
              <BlendSituationCard
                copy={copy}
                tanks={tanks}
                incomingCPO={incomingCPO}
                incomingFFA={incomingFFA}
                highFFAStock={highFFAStock}
                highFfaTankNames={highFfaTankNames}
                target={target}
                projectedFfa={projectedBlendFfa}
                atRisk={blendAtRisk}
                confidence={blendConfidence}
                onViewBlend={() => setMobileTab("production")}
              />
              <WarningsPanel
                copy={copy}
                results={results}
                incomingFFA={incomingFFA}
                target={target}
              />
            </>
          )}
          {mobileTab === "production" && productionPanel}
          {mobileTab === "despatch" && despatchPanel}
          {mobileTab === "transfer" && transferPanel}
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

      {/* Mobile sticky action bar — overview/production only so other tabs' own buttons stay clickable */}
      {(mobileTab === "overview" || mobileTab === "production") && (
        <div className="mobile-action-bar md:hidden">
          <button
            type="button"
            onClick={useSuggested}
            className="btn-touch w-full bg-[#00b14f] text-white shadow-[0_4px_14px_rgba(0,177,79,0.35)]"
          >
            <Sparkles size={16} />
            {copy.allocation.useBestPlan}
          </button>
        </div>
      )}

      {/* Floating Ask AI button — visible on every tab */}
      <button
        type="button"
        onClick={() => setAiModalOpen(true)}
        className="fixed bottom-24 right-4 z-40 flex items-center gap-2 rounded-full bg-[#00b14f] px-4 py-3 text-sm font-bold text-white shadow-[0_8px_24px_rgba(0,177,79,0.45)] hover:bg-[#00a047] md:bottom-6"
      >
        <Bot size={18} />
        {copy.askAi.button}
      </button>

      {aiModalOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl sm:p-5">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-bold text-[#173f30]">
                <Bot size={19} className="text-[#245f43]" />
                {copy.askAi.title}
              </h2>
              <button
                type="button"
                onClick={() => setAiModalOpen(false)}
                aria-label={copy.askAi.close}
                className="grid h-8 w-8 place-items-center rounded-full text-[#708078] hover:bg-[#f4f6f2]"
              >
                <X size={18} />
              </button>
            </div>
            <AiAdvisorPanel
              copy={copy}
              aiMessages={aiMessages}
              aiLoading={aiLoading}
              aiError={aiError}
              aiCooldown={aiCooldown}
              aiQuestion={aiQuestion}
              onAiQuestionChange={setAiQuestion}
              onGetAiOpinion={fetchAiOpinion}
              onClearChat={() => {
                setAiMessages([]);
                setAiError(null);
              }}
            />
          </div>
        </div>
      )}
    </main>
  );
}

const FLOW_ORDER: MobileTab[] = ["overview", "production", "despatch", "transfer"];

function FlowHint({ copy, activeTab }: { copy: Copy; activeTab: MobileTab }) {
  const stepIndex = FLOW_ORDER.indexOf(activeTab);
  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border border-[#dbe9de] bg-white px-3.5 py-2.5 shadow-[0_1px_2px_rgba(15,45,32,0.04)]">
      <div className="flex shrink-0 items-center gap-1">
        {FLOW_ORDER.map((step, i) => (
          <span
            key={step}
            className={`h-1.5 rounded-full transition-all ${
              i === stepIndex ? "w-5 bg-[#00b14f]" : i < stepIndex ? "w-1.5 bg-[#00b14f]/50" : "w-1.5 bg-[#dfe5df]"
            }`}
          />
        ))}
      </div>
      <p className="min-w-0 flex-1 truncate text-xs font-semibold text-[#3f4c46]">
        {copy.flow[activeTab]}
      </p>
    </div>
  );
}

function BlendSituationCard({
  copy,
  tanks,
  incomingCPO,
  incomingFFA,
  highFFAStock,
  highFfaTankNames,
  target,
  projectedFfa,
  atRisk,
  confidence,
  onViewBlend,
}: {
  copy: Copy;
  tanks: Tank[];
  incomingCPO: number;
  incomingFFA: number;
  highFFAStock: number;
  highFfaTankNames: string;
  target: number;
  projectedFfa: number;
  atRisk: boolean;
  confidence: "high" | "medium" | "low";
  onViewBlend: () => void;
}) {
  const confidenceLabel =
    confidence === "high"
      ? copy.blendSituation.confidenceHigh
      : confidence === "medium"
        ? copy.blendSituation.confidenceMedium
        : copy.blendSituation.confidenceLow;
  const confidenceColor =
    confidence === "high" ? "#00713a" : confidence === "medium" ? "#a64f24" : "#a4342c";

  return (
    <section className="relative overflow-hidden rounded-2xl border border-[#d9e2da] bg-[#123c2c] text-white shadow-[0_1px_2px_rgba(15,45,32,0.04),0_8px_24px_-16px_rgba(15,45,32,0.3)]">
      <div className="absolute inset-0">
        <Image
          src="/BST.webp"
          alt=""
          fill
          priority
          sizes="(min-width: 1024px) 60vw, 100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#123c2c] via-[#123c2c]/90 to-[#123c2c]/30" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#123c2c]/70 via-transparent to-transparent" />
      </div>
      <div className="relative z-10 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold sm:text-lg">{copy.blendSituation.title}</h2>
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${
              atRisk ? "bg-[#ffceb7] text-[#7c2d12]" : "bg-[#d4f7e2] text-[#00713a]"
            }`}
          >
            {atRisk ? copy.blendSituation.highRisk : copy.blendSituation.onTrack}
          </span>
        </div>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-[#cfe0d5]">
          {atRisk ? copy.blendSituation.highRiskText : copy.blendSituation.onTrackText}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2.5 lg:grid-cols-3 lg:gap-3">
          <BlendStat
            label={copy.blendSituation.incomingCpo}
            value={`${n(incomingCPO, 0)} MT`}
            sub={`@ ${n(incomingFFA, 2)}% FFA`}
          />
          <BlendStat
            label={copy.blendSituation.highFfaStock}
            value={`${n(highFFAStock, 0)} MT`}
            sub={highFfaTankNames || undefined}
          />
          <BlendStat label={copy.blendSituation.targetDispatchFfa} value={`≤ ${n(target, 2)}%`} />
          <BlendStat
            label={copy.blendSituation.projectedAfterBlending}
            value={`${n(projectedFfa, 2)}%`}
            highlight
          />
          <BlendStat
            label={copy.blendSituation.confidence}
            value={confidenceLabel}
            valueStyle={{ color: confidenceColor }}
          />
        </div>

        <div className="mt-5 border-t border-white/15 pt-4">
          <p className="text-[11px] font-bold uppercase tracking-wide text-[#9fc3ae]">
            {copy.tankSummary.title}
          </p>
          <div className="mt-2 space-y-1.5">
            {tanks.map((tank, i) => {
              const tier = currentFfaTier(tank.ffa, target);
              const label = currentFfaLabel(tier, copy);
              const badgeClass =
                tier === "safe"
                  ? "bg-[#d4f7e2] text-[#00713a]"
                  : tier === "warning"
                    ? "bg-[#ffe3c2] text-[#7a4a1f]"
                    : "bg-[#ffceb7] text-[#7c2d12]";
              return (
                <div
                  key={i}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-white/10 px-3 py-2 text-sm"
                >
                  <span className="font-semibold">{tank.name}</span>
                  <span className="text-[#cfe0d5]">
                    {n(tank.stock, 0)} MT · {n(tank.ffa, 2)}%
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${badgeClass}`}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={onViewBlend}
          className="btn-touch mt-5 w-full bg-[#00b14f] text-white shadow-[0_4px_14px_rgba(0,177,79,0.35)] hover:bg-[#00a047] sm:w-auto"
        >
          {copy.blendSituation.viewRecommendedBlend}
          <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}

function BlendStat({
  label,
  value,
  sub,
  highlight = false,
  valueStyle,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <div
      className={`rounded-xl p-2.5 ${highlight ? "bg-[#00b14f]/20 ring-1 ring-[#00b14f]/40" : "bg-white/10"}`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[#cfe0d5]">{label}</p>
      <p className="mt-1 text-base font-extrabold text-white sm:text-lg" style={valueStyle}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-[#cfe0d5]">{sub}</p>}
    </div>
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
    <section className="min-w-0 max-w-full rounded-2xl border border-[#e5eae5] bg-white p-4 shadow-[0_1px_2px_rgba(15,45,32,0.04),0_8px_24px_-16px_rgba(15,45,32,0.18)] sm:p-5">
      <div
        className={`mb-5 flex gap-3 ${stackAction ? "flex-col" : "items-start justify-between"}`}
      >
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#e5faed] text-[#00713a]">
            {icon}
          </span>
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
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return String(rounded);
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

function NullableNumericInput({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (value === null ? "" : formatNumericValue(value));

  return (
    <input
      aria-label={label}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={display}
      onFocus={() => setDraft(value === null ? "" : formatNumericValue(value))}
      onChange={(e) => {
        const next = e.target.value;
        if (next === "" || /^-?\d*\.?\d*$/.test(next)) setDraft(next);
      }}
      onBlur={() => {
        if (draft === null) return;
        if (draft.trim() === "") {
          onChange(null);
        } else {
          const parsed = parseNumericDraft(draft);
          if (parsed !== null) onChange(parsed);
        }
        setDraft(null);
      }}
      className={className}
    />
  );
}

/** First-time setup for a brand-new mill — replaces the demo tank data
 *  (BST 1 / BST 2 with pre-filled numbers) with the mill's actual tanks
 *  before the real app is shown. Reuses the same tanks/allocation state and
 *  add/remove logic as the normal Production tab, so nothing here is a
 *  separate draft that needs merging in later. */
function MillSetupScreen({
  copy,
  tanks,
  onUpdateTank,
  onAddTank,
  onRemoveTank,
  onFinish,
}: {
  copy: Copy;
  tanks: Tank[];
  onUpdateTank: (index: number, key: keyof Tank, value: string | number) => void;
  onAddTank: () => void;
  onRemoveTank: (index: number) => void;
  onFinish: () => void;
}) {
  const [touched, setTouched] = useState(false);
  const allNamed = tanks.every((t) => t.name.trim().length > 0);

  return (
    <main className="min-h-screen bg-[#f4f6f2] px-4 py-10 text-[#17231d] sm:px-6">
      <div className="mx-auto max-w-2xl">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#00b14f] text-white shadow-[0_4px_14px_rgba(0,177,79,0.45)]">
          <Droplets size={22} />
        </div>
        <h1 className="mt-4 text-2xl font-bold">{copy.setup.title}</h1>
        <p className="mt-2 text-sm text-[#58665e]">{copy.setup.subtitle}</p>

        <div className="mt-6 space-y-3">
          {tanks.map((tank, i) => (
            <div key={i} className="rounded-2xl border border-[#dfe5dc] bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-[#6c7971]">
                  {copy.setup.tankLabel(i + 1)}
                </span>
                {tanks.length > 1 && (
                  <button
                    type="button"
                    onClick={() => onRemoveTank(i)}
                    className="inline-flex items-center gap-1 rounded-full border border-[#f0cfb9] bg-[#fff8f3] px-2.5 py-1 text-[11px] font-bold text-[#a4342c]"
                  >
                    <Trash2 size={12} />
                    {copy.tanks.remove(tank.name)}
                  </button>
                )}
              </div>
              <div className="mt-3">
                <TankNameInput
                  value={tank.name}
                  onChange={(v) => onUpdateTank(i, "name", v)}
                  placeholder={copy.tanks.namePlaceholder}
                  ariaLabel={copy.tanks.name}
                />
              </div>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className="text-xs font-bold text-[#6c7971]">{copy.setup.capacityLabel}</span>
                  <NumericInput
                    label={copy.setup.capacityLabel}
                    value={tank.capacity}
                    onChange={(v) => onUpdateTank(i, "capacity", v)}
                    className="mt-1 w-full rounded-xl border border-[#dfe5dc] bg-white px-3 py-2.5 text-sm font-semibold"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-[#6c7971]">{copy.setup.stockLabel}</span>
                  <NumericInput
                    label={copy.setup.stockLabel}
                    value={tank.stock}
                    onChange={(v) => onUpdateTank(i, "stock", v)}
                    className="mt-1 w-full rounded-xl border border-[#dfe5dc] bg-white px-3 py-2.5 text-sm font-semibold"
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-bold text-[#6c7971]">{copy.setup.ffaLabel}</span>
                  <NumericInput
                    label={copy.setup.ffaLabel}
                    value={tank.ffa}
                    onChange={(v) => onUpdateTank(i, "ffa", v)}
                    className="mt-1 w-full rounded-xl border border-[#dfe5dc] bg-white px-3 py-2.5 text-sm font-semibold"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={onAddTank}
          className="btn-touch mt-3 w-full border border-[#b9c8bd] bg-white text-[#173f30]"
        >
          <Plus size={16} />
          {copy.setup.addTank}
        </button>

        {touched && !allNamed && (
          <p className="mt-3 text-sm font-semibold text-[#a4342c]">{copy.setup.needsName}</p>
        )}

        <button
          type="button"
          onClick={() => {
            setTouched(true);
            if (allNamed) onFinish();
          }}
          className="btn-touch mt-6 w-full bg-[#00713a] text-base text-white"
        >
          <CheckCircle2 size={18} />
          {copy.setup.finish}
        </button>
      </div>
    </main>
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
      className="input-touch w-full min-w-0 max-w-full rounded-lg border border-[#dfe5df] bg-white px-3 py-2.5 text-sm font-bold text-[#173f30] outline-none ring-[#00b14f] placeholder:font-normal placeholder:text-[#9aa59f] focus:ring-2"
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
    <label className="block min-w-0 w-full">
      <span className="mb-1 block truncate text-[10px] font-bold uppercase text-[#77837c]">{label}</span>
      <div
        className={`flex min-h-[38px] items-center gap-1 rounded-lg border px-2 ${
          accent ? "border-[#e5b18f] bg-[#fff9f5]" : "border-[#dce3dd] bg-[#f9faf8]"
        }`}
      >
        <NumericInput
          label={label}
          value={value}
          onChange={onChange}
          className="numeric-input min-w-0 flex-1 bg-transparent py-1.5 text-sm font-bold outline-none"
        />
        <span className="shrink-0 text-[10px] text-[#7d8982]">{unit}</span>
      </div>
    </label>
  );
}

/** Read-only companion to Field, for values the engine calculates rather
 *  than the engineer types in — same compact sizing, no input. */
function ReadOnlyField({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="block min-w-0 w-full">
      <span className="mb-1 block truncate text-[10px] font-bold uppercase text-[#77837c]">{label}</span>
      <div className="flex min-h-[38px] items-center gap-1 rounded-lg border border-[#d4f7e2] bg-[#f6fae9] px-2">
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-[#173f30]">{value}</span>
        <span className="shrink-0 text-[10px] text-[#4d8f6b]">{unit}</span>
      </div>
    </div>
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

function QuickStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: TankState;
}) {
  const accentColor =
    accent === "critical" ? "#a4342c" : accent === "warning" ? "#a64f24" : "#00713a";
  return (
    <div className="tank-unit__quickstat">
      <span className="tank-unit__quickstat-label">{label}</span>
      <span
        className="tank-unit__quickstat-value"
        style={accent ? { color: accentColor } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function QuickStatInput({
  label,
  value,
  onChange,
  unit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit: string;
}) {
  return (
    <label className="tank-unit__quickstat tank-unit__quickstat--input">
      <span className="tank-unit__quickstat-label">{label}</span>
      <span className="tank-unit__quickstat-inputrow">
        <NumericInput
          label={label}
          value={value}
          onChange={onChange}
          className="tank-unit__quickstat-input"
        />
        <span className="tank-unit__quickstat-unit">{unit}</span>
      </span>
    </label>
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
  const status = statusLabel(state, result.overflow, result.finalFFA, target, copy);
  const currentTier = currentFfaTier(tank.ffa, target);
  const currentLabel = currentFfaLabel(currentTier, copy);
  const availableSpace = Math.max(0, tank.capacity - tank.stock);

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
          <div className="tank-unit__summary-main">
            <p className="tank-unit__summary-name">
              <span className="tank-unit__number">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{tank.name}</span>
              <Pencil size={12} className="tank-unit__edit-icon shrink-0" aria-hidden />
            </p>
            <p className="tank-unit__summary-stats">
              {copy.tanks.stock}: {n(tank.stock, 0)} MT · {copy.tanks.ffa}: {n(tank.ffa, 2)}% ·{" "}
              {copy.tanks.filledAfter(result.utilisation)}
            </p>
          </div>
          <span className={`status-pill shrink-0 ${currentTier}`}>
            {currentTier === "safe" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
            {currentLabel}
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
            <span className="tank-unit__scale" aria-hidden>
              <span>100%</span>
              <span>50%</span>
              <span>0%</span>
            </span>
            <TankCylinder fillPct={result.utilisation} state={state} />
            <div className="tank-unit__identity-side">
              <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-[#7a867f]">
                <span className="tank-unit__number">{index + 1}</span>
                {copy.tanks.name}
              </p>
              <TankNameInput
                value={tank.name}
                onChange={(v) => onUpdate("name", v)}
                placeholder={copy.tanks.namePlaceholder}
                ariaLabel={copy.tanks.name}
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className={`status-pill ${currentTier}`}>
                  {currentTier === "safe" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                  {currentLabel}
                </span>
                <span className="text-xs font-semibold text-[#708078]">
                  {copy.tanks.filledAfter(result.utilisation)}
                </span>
              </div>
              <div className="tank-unit__quickstats">
                <QuickStatInput
                  label={copy.tanks.capacity}
                  value={tank.capacity}
                  onChange={(v) => onUpdate("capacity", v)}
                  unit="MT"
                />
                <QuickStatInput
                  label={copy.tanks.stockNow}
                  value={tank.stock}
                  onChange={(v) => onUpdate("stock", v)}
                  unit="MT"
                />
                <QuickStatInput
                  label={copy.tanks.ffaNow}
                  value={tank.ffa}
                  onChange={(v) => onUpdate("ffa", v)}
                  unit="%"
                />
                <QuickStat label={copy.tanks.availableSpace} value={`${n(availableSpace, 0)} MT`} />
                <QuickStat label={copy.tanks.allocation} value={`${n(allocationPct, 0)}%`} />
                <QuickStat
                  label={copy.tanks.finalStock}
                  value={`${n(result.finalStock, 0)} MT`}
                  accent={state}
                />
                <QuickStat
                  label={copy.tanks.finalFfa}
                  value={`${n(result.finalFFA, 2)}%`}
                  accent={state}
                />
              </div>
            </div>
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

function WarningsPanel({
  copy,
  results,
  incomingFFA,
  target,
}: {
  copy: Copy;
  results: Result[];
  incomingFFA: number;
  target: number;
}) {
  const overflowTanks = results.filter((r) => r.overflow).map((r) => r.name);
  const atRisk = incomingFFA > target;

  const items: { title: string; text: string }[] = [];
  if (overflowTanks.length > 0) {
    items.push({ title: copy.warnings.overflowTitle, text: copy.warnings.overflowText(overflowTanks.join(", ")) });
  }
  if (atRisk) {
    items.push({
      title: copy.warnings.highRiskTitle,
      text: copy.warnings.highRiskText(n(incomingFFA, 2), n(target, 2)),
    });
  }

  if (items.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-[#c8dfae] bg-[#f6fae9] px-4 py-3 text-sm font-semibold text-[#173f30]">
        <CheckCircle2 size={17} className="shrink-0 text-[#00b14f]" />
        {copy.warnings.allGood}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <AlertBanner key={i} title={item.title} text={item.text} />
      ))}
    </div>
  );
}

function AiRecommendationCard({
  copy,
  tanks,
  incomingCPO,
  best,
  despatchPlan,
  batchResult,
  onApply,
}: {
  copy: Copy;
  tanks: Tank[];
  incomingCPO: number;
  best: BlendPlan | null;
  despatchPlan: DespatchPlan | null;
  batchResult: BatchBlendResult | null;
  onApply: () => void;
}) {
  const lines: string[] = [];

  if (despatchPlan && despatchPlan.sources.length > 0) {
    const top = despatchPlan.sources[0];
    lines.push(copy.aiRecommendation.despatchLine(n(top.mt, 0), top.name));
  }

  if (best && incomingCPO > 0) {
    const parts = best.allocation
      .map((pct, i) => ({ pct, mt: allocationMt(incomingCPO, pct), name: tanks[i]?.name }))
      .filter((p) => p.mt > 0)
      .map((p) => `${n(p.mt, 0)} MT→${p.name}`)
      .join(", ");
    if (parts) lines.push(copy.aiRecommendation.allocateLine(parts));
  }

  if (batchResult && batchResult.feasible && batchResult.steps.length > 0) {
    const step = batchResult.steps[0];
    lines.push(copy.aiRecommendation.transferLine(n(step.mt, 0), step.fromTank, step.toTank));
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-[#d9e2da] bg-white shadow-sm">
      <div className="border-b border-[#e8ede8] bg-[#f8faf7] p-4 sm:p-5">
        <div className="flex items-center gap-2 font-bold text-[#173f30]">
          <Bot size={19} className="text-[#245f43]" />
          {copy.aiRecommendation.title}
        </div>
        <p className="mt-1 text-sm text-[#58665e]">{copy.aiRecommendation.subtitle}</p>
      </div>
      <div className="p-4 sm:p-5">
        {lines.length === 0 ? (
          <p className="text-sm text-[#58665e]">{copy.aiRecommendation.noAction}</p>
        ) : (
          <>
            <p className="section-label">{copy.aiRecommendation.todaysPlan}</p>
            <ol className="mt-2 space-y-2">
              {lines.map((line, i) => (
                <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-[#17231d]">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#e5faed] text-[10px] font-bold text-[#00713a]">
                    {i + 1}
                  </span>
                  {line}
                </li>
              ))}
            </ol>
            <button
              type="button"
              onClick={onApply}
              className="btn-touch mt-4 w-full bg-[#00b14f] text-white shadow-[0_4px_14px_rgba(0,177,79,0.35)] hover:bg-[#00a047]"
            >
              <Sparkles size={16} />
              {copy.aiRecommendation.apply}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function TankSummaryTable({ copy, tanks, target }: { copy: Copy; tanks: Tank[]; target: number }) {
  return (
    <Panel title={copy.tankSummary.title} subtitle="" icon={<Droplets size={19} />}>
      <div className="table-scroll overflow-x-auto">
        <table className="w-full min-w-[420px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-[#e8ede8] text-left text-[11px] font-bold uppercase tracking-wide text-[#7a867f]">
              <th className="pb-2 pr-3">{copy.tankSummary.name}</th>
              <th className="pb-2 pr-3">{copy.tankSummary.stock}</th>
              <th className="pb-2 pr-3">{copy.tankSummary.ffa}</th>
              <th className="pb-2">{copy.tankSummary.status}</th>
            </tr>
          </thead>
          <tbody>
            {tanks.map((tank, i) => {
              const tier = currentFfaTier(tank.ffa, target);
              const label = currentFfaLabel(tier, copy);
              return (
                <tr key={i} className="border-b border-[#f2f5f0] last:border-0">
                  <td className="py-2.5 pr-3 font-semibold text-[#17231d]">{tank.name}</td>
                  <td className="py-2.5 pr-3 text-[#3f4c46]">{n(tank.stock, 0)} MT</td>
                  <td className="py-2.5 pr-3 text-[#3f4c46]">{n(tank.ffa, 2)}%</td>
                  <td className="py-2.5">
                    <span className={`status-pill ${tier}`}>
                      {tier === "safe" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                      {label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function SimpleTransferCalculator({
  copy,
  tanks,
  deadStockMt,
  onTransfer,
}: {
  copy: Copy;
  tanks: Tank[];
  deadStockMt: number;
  onTransfer: (sourceIndex: number, destIndex: number, amountMt: number) => void;
}) {
  const [sourceIndex, setSourceIndex] = useState(0);
  const [destIndex, setDestIndex] = useState(tanks.length > 1 ? 1 : 0);
  const [amount, setAmount] = useState(0);

  const source = tanks[sourceIndex];
  const dest = tanks[destIndex];
  const sameTank = sourceIndex === destIndex;
  const sourceAvailable = source ? Math.max(0, source.stock - deadStockMt) : 0;
  const notEnoughStock = !sameTank && source ? amount > sourceAvailable : false;
  const destNewStock = dest ? dest.stock + amount : 0;
  const wouldOverflow = !sameTank && dest ? destNewStock > dest.capacity : false;
  const destNewFfa =
    !sameTank && dest && source && destNewStock > 0
      ? (dest.stock * dest.ffa + amount * source.ffa) / destNewStock
      : dest?.ffa ?? 0;
  const sourceNewStock = source ? source.stock - amount : 0;
  const canApply = !sameTank && amount > 0 && !notEnoughStock && !wouldOverflow;

  return (
    <Panel title={copy.transferCalc.title} subtitle={copy.transferCalc.subtitle} icon={<ArrowRightLeft size={19} />}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className="field-label">{copy.transferCalc.source}</span>
          <select
            value={sourceIndex}
            onChange={(e) => setSourceIndex(Number(e.target.value))}
            className="min-h-[44px] w-full rounded-lg border border-[#dce3dd] bg-white px-3 text-sm font-semibold text-[#173f30] outline-none ring-[#00b14f] focus:ring-2"
          >
            {tanks.map((t, i) => (
              <option key={i} value={i}>
                {t.name} — {n(t.stock, 0)} MT · {n(t.ffa, 2)}%
              </option>
            ))}
          </select>
        </label>
        <label className="block min-w-0">
          <span className="field-label">{copy.transferCalc.destination}</span>
          <select
            value={destIndex}
            onChange={(e) => setDestIndex(Number(e.target.value))}
            className="min-h-[44px] w-full rounded-lg border border-[#dce3dd] bg-white px-3 text-sm font-semibold text-[#173f30] outline-none ring-[#00b14f] focus:ring-2"
          >
            {tanks.map((t, i) => (
              <option key={i} value={i}>
                {t.name} — {n(t.stock, 0)} MT · {n(t.ffa, 2)}%
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 max-w-xs">
        <MiniField label={copy.transferCalc.amount} value={amount} onChange={(v) => setAmount(Math.max(0, v))} unit="MT" />
        {!sameTank && source && (
          <p className="mt-1.5 text-xs text-[#708078]">
            {copy.transferCalc.availableToTransfer(n(sourceAvailable, 0), n(deadStockMt, 0))}
          </p>
        )}
      </div>

      {sameTank && (
        <p className="mt-3 text-sm font-semibold text-[#92441f]">{copy.transferCalc.selectDifferent}</p>
      )}
      {!sameTank && notEnoughStock && (
        <p className="mt-3 text-sm font-semibold text-[#92441f]">{copy.transferCalc.notEnoughStock}</p>
      )}
      {!sameTank && wouldOverflow && (
        <p className="mt-3 text-sm font-semibold text-[#92441f]">{copy.transferCalc.wouldOverflow}</p>
      )}

      {!sameTank && amount > 0 && !notEnoughStock && !wouldOverflow && (
        <div className="mt-4">
          <p className="section-label">{copy.transferCalc.preview}</p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-[#f9fbf8] p-3">
              <p className="text-[11px] font-bold uppercase text-[#58665e]">{copy.transferCalc.sourceAfter}</p>
              <p className="mt-1 text-lg font-extrabold text-[#173f30]">{n(sourceNewStock, 0)} MT</p>
              <p className="text-xs text-[#708078]">{n(source.ffa, 2)}% FFA</p>
            </div>
            <div className="rounded-xl bg-[#f6fae9] p-3">
              <p className="text-[11px] font-bold uppercase text-[#58665e]">{copy.transferCalc.destAfter}</p>
              <p className="mt-1 text-lg font-extrabold text-[#173f30]">{n(destNewStock, 0)} MT</p>
              <p className="text-xs text-[#708078]">{n(destNewFfa, 2)}% FFA</p>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        disabled={!canApply}
        onClick={() => {
          onTransfer(sourceIndex, destIndex, amount);
          setAmount(0);
        }}
        className="btn-touch mt-4 w-full bg-[#00b14f] text-white shadow-[0_4px_14px_rgba(0,177,79,0.35)] hover:bg-[#00a047] disabled:opacity-40"
      >
        <ArrowRightLeft size={16} />
        {copy.transferCalc.confirmTransfer}
      </button>
    </Panel>
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
  penaltyBands,
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
  penaltyBands?: PenaltyBand[] | null;
}) {
  const meetsTarget = plan.results.every((r) => r.finalFFA <= target);
  const maxFfa = Math.max(...plan.results.map((r) => r.finalFFA));
  const penaltyRm = penaltyBands
    ? calcTotalExposure(
        plan.results.map((r) => ({ ffaPct: r.finalFFA, tonnageMt: r.finalStock })),
        penaltyBands,
      )
    : null;
  const penaltyLabel =
    penaltyRm !== null
      ? penaltyRm > 0
        ? copy.plan.estimatedPenalty(n(penaltyRm, 0))
        : copy.plan.noPenalty
      : null;

  if (compact) {
    return (
      <div className="rounded-xl border border-[#dfe5dc] bg-[#f9fbf8] p-2.5">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[11px] font-bold text-[#173f30]">{copy.plan.planRank(rank)}</span>
          <button
            type="button"
            onClick={onApply}
            className="btn-touch relative z-10 shrink-0 rounded-lg bg-[#00b14f] px-3 py-2 text-xs font-bold text-white hover:bg-[#00a047]"
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
        <p className="mt-1.5 text-xs font-bold text-[#3f4c46]">
          {meetsTarget ? copy.plan.withinLimit : copy.plan.maxFinalFfa(maxFfa)}
        </p>
        {penaltyLabel && (
          <p className={`mt-1 text-xs font-bold ${penaltyRm && penaltyRm > 0 ? "text-[#92441f]" : "text-[#00b14f]"}`}>
            {penaltyLabel}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl border p-3 ${
        highlighted ? "border-[#00b14f] bg-[#f6fae9]" : "border-[#dfe5dc] bg-[#f9fbf8]"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-bold text-[#173f30]">{copy.plan.planRank(rank)}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
            meetsTarget ? "bg-[#d4f7e2] text-[#00713a]" : "bg-[#ffceb7] text-[#7c2d12]"
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
      {penaltyLabel && (
        <p className={`mt-1 text-[11px] font-bold ${penaltyRm && penaltyRm > 0 ? "text-[#92441f]" : "text-[#00b14f]"}`}>
          {penaltyLabel}
        </p>
      )}
      <button
        type="button"
        onClick={onApply}
        className={`btn-touch relative z-10 mt-2 w-full scroll-mb-28 text-sm ${
          highlighted ? "bg-[#173f30] text-white" : "bg-[#d4f7e2] text-[#00713a]"
        }`}
      >
        <RefreshCw size={14} />
        {copy.plan.useThisPlan}
      </button>
    </div>
  );
}

function RoutingStrategyCard({
  copy,
  tanks,
  target,
  incomingCPO,
  best,
  bestSingleTank,
  consolidateRuleApplies,
  forceSplitFallback,
  recommendSingle,
  aiSuggestion,
  aiLoading,
  aiError,
  onApplySingle,
  onApplySplit,
}: {
  copy: Copy;
  tanks: Tank[];
  target: number;
  incomingCPO: number;
  best: BlendPlan | null;
  bestSingleTank: BlendPlan | null;
  consolidateRuleApplies: boolean;
  forceSplitFallback: boolean;
  recommendSingle: boolean;
  aiSuggestion: string | null;
  aiLoading: boolean;
  aiError: boolean;
  onApplySingle: () => void;
  onApplySplit: () => void;
}) {
  if (!best || !bestSingleTank || incomingCPO <= 0) return null;

  const singleIndex = bestSingleTank.allocation.findIndex((v) => v === 100);
  const singleTank = tanks[singleIndex];
  const singleResult = bestSingleTank.results[singleIndex];
  const singleMeets = bestSingleTank.results.every((r) => r.finalFFA <= target);
  const splitMeets = best.results.every((r) => r.finalFFA <= target);

  // Mills here route incoming CPO into one tank at a time — precise flow
  // splitting isn't practical — so single-tank is the default explanation
  // essentially always; split only gets its own text when there's genuinely
  // no single tank left with room.
  const calculatedText = forceSplitFallback
    ? copy.routingStrategy.forceSplitText(singleTank.name)
    : consolidateRuleApplies
      ? copy.routingStrategy.consolidateRule(singleTank.name, n(target, 2))
      : singleMeets
        ? copy.routingStrategy.recommendSingle(singleTank.name)
        : copy.routingStrategy.recommendSingleWithFollowUp(singleTank.name, n(singleResult.finalFFA, 2));
  // Prefer the AI's written explanation once it's back; the calculated text
  // (always correct, always instant) is the fallback while it's loading, if
  // it failed, or before the first response ever arrives.
  const recommendationText = aiSuggestion ?? calculatedText;

  // One decisive recommendation, not a side-by-side comparison to pick from —
  // recommendSingle already says which route is correct for this situation
  // (forced single-tank consolidation, forced split when there's no room, or
  // whichever scores better in the ordinary case), so that's the only card
  // shown. The split plan is still one click away via Smart Recommendation
  // below if an engineer wants to override it.
  const singleBadge = singleResult.overflow
    ? copy.routingStrategy.noRoom
    : singleMeets
      ? copy.routingStrategy.meetsLimit
      : copy.routingStrategy.overLimit;
  const singleBadgeOk = !singleResult.overflow && singleMeets;

  const recommended = recommendSingle
    ? {
        label: copy.routingStrategy.singleLabel,
        hint: copy.routingStrategy.singleHint,
        detail: `${n(incomingCPO, 0)} MT → ${singleTank.name} · ${n(singleResult.finalFFA, 2)}% FFA`,
        badge: singleBadge,
        badgeOk: singleBadgeOk,
        onApply: onApplySingle,
        disabled: singleResult.overflow,
        applyLabel: copy.routingStrategy.applySingle,
      }
    : {
        label: copy.routingStrategy.splitLabel,
        hint: copy.routingStrategy.splitHint,
        detail: best.allocation
          .map((pct, i) => (pct > 0 ? `${pct}%→${tanks[i].name}` : null))
          .filter(Boolean)
          .join(", "),
        badge: splitMeets ? copy.routingStrategy.meetsLimit : copy.routingStrategy.overLimit,
        badgeOk: splitMeets,
        onApply: onApplySplit,
        disabled: false,
        applyLabel: copy.routingStrategy.applySplit,
      };

  return (
    <Panel
      title={copy.routingStrategy.title}
      subtitle={copy.routingStrategy.subtitle}
      icon={<ArrowRightLeft size={19} />}
    >
      <div className="rounded-xl border border-[#00b14f] bg-[#f6fae9] p-3.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-bold text-[#173f30]">{recommended.label}</p>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              recommended.badgeOk ? "bg-[#d4f7e2] text-[#00713a]" : "bg-[#ffceb7] text-[#7c2d12]"
            }`}
          >
            {recommended.badge}
          </span>
        </div>
        <p className="mt-1 text-xs text-[#708078]">{recommended.hint}</p>
        <p className="mt-2 text-sm text-[#3f4c46]">{recommended.detail}</p>
        <button
          type="button"
          onClick={recommended.onApply}
          disabled={recommended.disabled}
          className="btn-touch mt-3 w-full bg-[#00713a] text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {recommended.applyLabel}
        </button>
      </div>

      <div className="mt-4 rounded-xl bg-[#f8faf7] p-3.5">
        <FormattedOpinion text={recommendationText} />
      </div>
      {aiLoading && !aiSuggestion && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-[#8a9690]">
          <Loader2 size={12} className="animate-spin" />
          {copy.routingStrategy.aiThinking}
        </p>
      )}
      {aiError && (
        <p className="mt-2 text-xs text-[#8a9690]">{copy.routingStrategy.aiFallbackNote}</p>
      )}
    </Panel>
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
  allocation,
  onApplyPlan,
  aiMessages,
  aiLoading,
  aiError,
  aiCooldown,
  aiQuestion,
  onAiQuestionChange,
  onGetAiOpinion,
  onClearChat,
  penaltyBands,
  bestSingleTank,
  singleTankBlendPlan,
  singleTankFollowUp,
  hasProfile,
  onApplySingle,
  autoAiSuggestion,
  autoAiLoading,
  autoAiError,
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
  allocation: number[];
  onApplyPlan: (plan: BlendPlan) => void;
  aiMessages: AiMessage[];
  aiLoading: boolean;
  aiError: string | null;
  aiCooldown: number;
  aiQuestion: string;
  onAiQuestionChange: (value: string) => void;
  onGetAiOpinion: (opts?: { deepAnalysis?: boolean }) => void;
  onClearChat: () => void;
  penaltyBands?: PenaltyBand[] | null;
  bestSingleTank: BlendPlan | null;
  singleTankBlendPlan: { hold: HoldSimulation; dilutionTankName: string | null } | null;
  singleTankFollowUp: HoldVsDespatch | null;
  hasProfile: boolean;
  onApplySingle: () => void;
  // Same auto-fired AI explanation that Allocation strategy shows above —
  // shared here too so the two panels always tell the same story instead of
  // Smart Recommendation falling back to older, purely calculated wording.
  autoAiSuggestion: string | null;
  autoAiLoading: boolean;
  autoAiError: boolean;
}) {
  const best = topPlans[0];
  // Which view to show is driven by what's actually APPLIED right now — not
  // by the >5% rule alone — so picking "Route into this tank" always surfaces
  // the full blend/despatch/penalty plan here, and picking the split plan
  // always shows the standard top-plans view, regardless of the rule.
  const useConsolidate = !!bestSingleTank && sameAllocation(allocation, bestSingleTank.allocation);
  const singleIndex = useConsolidate ? bestSingleTank!.allocation.findIndex((v) => v === 100) : -1;
  const singleResult = useConsolidate && singleIndex >= 0 ? bestSingleTank!.results[singleIndex] : null;

  let blendDownText: string | null = null;
  let penaltyText: string | null = null;
  if (useConsolidate && singleResult) {
    if (singleResult.finalFFA <= target) {
      blendDownText = copy.routingStrategy.alreadyCompliant(n(singleResult.finalFFA, 2));
    } else {
      if (!singleTankBlendPlan?.dilutionTankName) {
        blendDownText = copy.routingStrategy.consolidateNoDilutionTank;
      } else if (singleTankBlendPlan.hold.feasible && singleTankBlendPlan.hold.days !== null) {
        blendDownText = copy.routingStrategy.consolidateBlendPlan(
          n(singleTankBlendPlan.hold.transferUsedMt, 0),
          singleTankBlendPlan.dilutionTankName,
          singleTankBlendPlan.hold.days,
          n(singleTankBlendPlan.hold.finalFfaPct, 2),
        );
      } else {
        blendDownText = copy.routingStrategy.consolidateBlendInfeasible;
      }
      penaltyText = buildPenaltyDecisionText(copy, hasProfile, singleTankFollowUp, singleTankBlendPlan);
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-[#d9e2da] bg-white shadow-sm">
      <div className="relative overflow-hidden bg-[#173f30] p-4 text-white sm:p-5">
        <Image
          src="/Oil.png"
          alt=""
          fill
          sizes="(min-width: 1024px) 40vw, 100vw"
          className="object-cover object-right opacity-80"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#173f30] via-[#173f30]/95 to-[#173f30]/40" />
        <div className="relative z-10">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-bold">
              <Sparkles size={19} className="text-[#8ff0bb]" />
              {copy.plan.smartRecommendation}
            </div>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${
                valid ? "bg-[#d4f7e2] text-[#00713a]" : "bg-[#ffceb7] text-[#7c2d12]"
              }`}
            >
              {valid ? copy.plan.planChecked : copy.plan.checkInput}
            </span>
          </div>
          <h2 className="text-lg font-bold leading-snug sm:text-xl">
            {useConsolidate
              ? copy.plan.consolidateTitle(tanks[singleIndex].name)
              : bestMeetsTarget
                ? copy.plan.safeAllocation
                : copy.plan.limitNotAchievable}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-[#c9dbd1]">
            {useConsolidate ? copy.plan.consolidateBasis(n(target, 2)) : copy.plan.planBasis}
          </p>
        </div>
      </div>
      <div className="p-4 sm:p-5">
        {useConsolidate ? (
          <>
            {autoAiSuggestion ? (
              <div className="mb-4 rounded-xl bg-[#f8faf7] p-3.5">
                <FormattedOpinion text={autoAiSuggestion} />
              </div>
            ) : autoAiLoading ? (
              <p className="mb-4 flex items-center gap-1.5 text-xs text-[#8a9690]">
                <Loader2 size={12} className="animate-spin" />
                {copy.routingStrategy.aiThinking}
              </p>
            ) : autoAiError ? (
              <p className="mb-4 text-xs text-[#8a9690]">{copy.routingStrategy.aiFallbackNote}</p>
            ) : null}
            <p className="section-label">{copy.plan.recommendedAllocation}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {bestSingleTank!.allocation.map((x, i) => (
                <div key={i} className="plan-pill">
                  <p className="text-xs text-[#708078]">{tanks[i].name}</p>
                  <p className="mt-1 text-xl font-extrabold text-[#173f30]">{x}%</p>
                  <p className="text-[11px] text-[#708078]">{n(allocationMt(incomingCPO, x))} MT</p>
                </div>
              ))}
            </div>

            {blendDownText && (
              <div className="mt-4">
                <p className="section-label">{copy.plan.blendDownPlan}</p>
                <div className="mt-2 rounded-xl border border-[#efc7aa] bg-[#fff8f3] p-3.5 text-sm leading-relaxed text-[#92441f]">
                  {blendDownText}
                </div>
              </div>
            )}
            {penaltyText && (
              <div className="mt-3">
                <p className="section-label">{copy.routingStrategy.penaltyExposure}</p>
                <div className="mt-2 rounded-xl border border-[#d9c7a3] bg-[#fdf7ec] p-3.5 text-sm leading-relaxed text-[#6b4c14]">
                  {penaltyText}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={onApplySingle}
              className="btn-touch mt-5 flex w-full bg-[#d4f7e2] text-[#00713a]"
            >
              <RefreshCw size={16} />
              {copy.routingStrategy.applySingle}
            </button>

            <div className="mt-5 border-t border-[#e8ede8] pt-5">
              <AiAdvisorPanel
                copy={copy}
                aiMessages={aiMessages}
                aiLoading={aiLoading}
                aiError={aiError}
                aiCooldown={aiCooldown}
                aiQuestion={aiQuestion}
                onAiQuestionChange={onAiQuestionChange}
                onGetAiOpinion={onGetAiOpinion}
                onClearChat={onClearChat}
              />
            </div>
          </>
        ) : best ? (
          <>
            <p className="section-label">{copy.plan.recommendedAllocation}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {best.allocation.map((x, i) => (
                <div key={i} className="plan-pill">
                  <p className="text-xs text-[#708078]">{tanks[i].name}</p>
                  <p className="mt-1 text-xl font-extrabold text-[#173f30]">{x}%</p>
                  <p className="text-[11px] text-[#708078]">{n(allocationMt(incomingCPO, x))} MT</p>
                </div>
              ))}
            </div>

            {topPlans.length > 1 && (
              <div className="mt-4">
                <p className="section-label">{copy.plan.topPlans}</p>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                      penaltyBands={penaltyBands}
                    />
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => onApplyPlan(best)}
              className="btn-touch mt-5 flex w-full bg-[#d4f7e2] text-[#00713a]"
            >
              <RefreshCw size={16} />
              {copy.allocation.applyRecommended}
            </button>

            <div className="mt-5 border-t border-[#e8ede8] pt-5">
              <AiAdvisorPanel
                copy={copy}
                aiMessages={aiMessages}
                aiLoading={aiLoading}
                aiError={aiError}
                aiCooldown={aiCooldown}
                aiQuestion={aiQuestion}
                onAiQuestionChange={onAiQuestionChange}
                onGetAiOpinion={onGetAiOpinion}
                onClearChat={onClearChat}
              />
            </div>
          </>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-[#8a3d20]">{copy.plan.noFeasiblePlan}</p>
            <div className="mt-5 border-t border-[#e8ede8] pt-5">
              <AiAdvisorPanel
                copy={copy}
                aiMessages={aiMessages}
                aiLoading={aiLoading}
                aiError={aiError}
                aiCooldown={aiCooldown}
                aiQuestion={aiQuestion}
                onAiQuestionChange={onAiQuestionChange}
                onGetAiOpinion={onGetAiOpinion}
                onClearChat={onClearChat}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}

type AiMessage = {
  role: "user" | "assistant";
  content: string;
  source?: "openai" | "offline";
  kind?: "deep";
};

function AiAdvisorPanel({
  copy,
  aiMessages,
  aiLoading,
  aiError,
  aiCooldown,
  aiQuestion,
  onAiQuestionChange,
  onGetAiOpinion,
  onClearChat,
}: {
  copy: Copy;
  aiMessages: AiMessage[];
  aiLoading: boolean;
  aiError: string | null;
  aiCooldown: number;
  aiQuestion: string;
  onAiQuestionChange: (value: string) => void;
  onGetAiOpinion: (opts?: { deepAnalysis?: boolean }) => void;
  onClearChat: () => void;
}) {
  const aiDisabled = aiLoading || aiCooldown > 0;
  const askLabel = aiLoading
    ? copy.ai.generating
    : aiCooldown > 0
      ? copy.ai.wait(aiCooldown)
      : copy.ai.ask;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="section-label">{copy.ai.advisor}</p>
          <p className="mt-1 text-sm text-[#58665e]">{copy.ai.description}</p>
        </div>
        {aiMessages.length > 0 && (
          <button
            type="button"
            onClick={onClearChat}
            className="inline-flex items-center gap-1 rounded-full border border-[#dfe5df] bg-white px-2.5 py-1 text-[11px] font-bold text-[#6c7971] hover:bg-[#f4f6f2]"
          >
            <X size={12} />
            {copy.aiChat.clearChat}
          </button>
        )}
      </div>

      {aiMessages.length > 0 && (
        <div className="mt-3 max-h-96 space-y-2.5 overflow-y-auto rounded-xl border border-[#e8ede8] bg-[#fafbf9] p-3">
          {aiMessages.map((msg, i) =>
            msg.role === "user" ? (
              <div key={i} className="ml-6 rounded-xl rounded-tr-sm bg-[#173f30] px-3 py-2 text-sm text-white">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-[#b9d3c4]">
                  <User size={11} />
                  {copy.aiChat.you}
                </div>
                {msg.content}
              </div>
            ) : (
              <div
                key={i}
                className="mr-2 rounded-xl rounded-tl-sm border border-[#dfe6df] bg-white px-3 py-2.5"
              >
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-[#245f43]">
                  <Bot size={12} />
                  {msg.kind === "deep"
                    ? copy.aiChat.deepAnalysis
                    : msg.source === "offline"
                      ? copy.ai.opinionOffline
                      : copy.ai.opinionLive}
                </div>
                <FormattedOpinion text={msg.content} />
              </div>
            ),
          )}
        </div>
      )}

      <textarea
        value={aiQuestion}
        onChange={(e) => onAiQuestionChange(e.target.value)}
        placeholder={aiMessages.length ? copy.aiChat.newQuestion : copy.ai.questionPlaceholder}
        rows={3}
        maxLength={500}
        className="mt-3 w-full rounded-xl border border-[#dce3dd] bg-[#f9faf8] px-3 py-2.5 text-sm leading-relaxed text-[#17231d] outline-none ring-[#00b14f] placeholder:text-[#9aa59f] focus:ring-2"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onGetAiOpinion()}
          disabled={aiDisabled}
          className="btn-touch border border-[#b9c8bd] bg-white text-[#173f30] disabled:opacity-60"
        >
          {aiLoading ? <Loader2 size={16} className="animate-spin" /> : <Bot size={16} />}
          {askLabel}
        </button>
        <button
          type="button"
          onClick={() => onGetAiOpinion({ deepAnalysis: true })}
          disabled={aiDisabled}
          className="btn-touch bg-[#00b14f] text-white shadow-[0_4px_14px_rgba(0,177,79,0.35)] hover:bg-[#00a047] disabled:opacity-60"
        >
          {aiLoading ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
          {copy.aiChat.deepAnalysis}
        </button>
      </div>

      {aiError && (
        <div className="mt-3 rounded-xl border border-[#f0cfb9] bg-[#fff8f3] p-3.5 text-sm text-[#92441f]">
          {aiError}
        </div>
      )}
    </div>
  );
}

function TankerDespatchPlanner({
  copy,
  tankerLoadMt,
  onTankerLoadChange,
  topPlans,
  preferFewerTanks,
  onPreferFewerTanksChange,
  penaltyRm,
  totalDespatchableMt,
  penaltyBands,
}: {
  copy: Copy;
  tankerLoadMt: number;
  onTankerLoadChange: (value: number) => void;
  topPlans: DespatchPlan[];
  preferFewerTanks: boolean;
  onPreferFewerTanksChange: (value: boolean) => void;
  penaltyRm: number | null;
  totalDespatchableMt: number;
  penaltyBands?: PenaltyBand[] | null;
}) {
  const hasStock = topPlans.length > 0;
  const loadsNeeded = tankerLoadMt > 0 ? Math.ceil(totalDespatchableMt / tankerLoadMt) : 0;
  const [tankersToday, setTankersToday] = useState(1);
  const bestOptionPenalty =
    penaltyBands && topPlans[0]
      ? calcTotalExposure(
          topPlans[0].sources.map((s) => ({ ffaPct: s.ffaPct, tonnageMt: s.mt })),
          penaltyBands,
        )
      : null;

  return (
    <section className="overflow-hidden rounded-2xl border border-[#d9e2da] bg-white shadow-sm">
      <div className="border-b border-[#e8ede8] bg-[#f8faf7] p-4 sm:p-5">
        <div className="flex items-center gap-2 font-bold text-[#173f30]">
          <Truck size={19} className="text-[#245f43]" />
          {copy.despatch.title}
        </div>
        <p className="mt-2 text-sm leading-relaxed text-[#58665e]">{copy.despatch.subtitle}</p>
        <div className="mt-4 flex flex-wrap items-start gap-3">
          <div className="max-w-xs flex-1 min-w-[180px]">
            <label className="text-xs font-bold text-[#6c7971]">{copy.despatch.tankerLoad}</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={1}
                step={1}
                value={tankerLoadMt || ""}
                onChange={(e) => onTankerLoadChange(Number(e.target.value) || 0)}
                className="w-full rounded-xl border border-[#dce3dd] bg-white px-3 py-2.5 text-sm font-semibold text-[#173f30] outline-none ring-[#00b14f] focus:ring-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <span className="shrink-0 text-sm font-bold text-[#58665e]">MT</span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[#758078]">{copy.despatch.tankerLoadHint}</p>
          </div>
          {totalDespatchableMt > 0 && tankerLoadMt > 0 && (
            <div className="flex flex-1 min-w-[220px] items-center gap-2 self-stretch rounded-xl bg-[#f6fae9] px-3 py-2.5">
              <Truck size={16} className="shrink-0 text-[#00713a]" />
              <p className="text-sm font-semibold text-[#173f30]">
                {copy.despatch.loadsNeeded(loadsNeeded, n(totalDespatchableMt, 0))}
              </p>
            </div>
          )}
        </div>
        <label className="mt-4 flex max-w-sm cursor-pointer items-start gap-2.5 rounded-xl border border-[#dce3dd] bg-white p-3">
          <input
            type="checkbox"
            checked={preferFewerTanks}
            onChange={(e) => onPreferFewerTanksChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[#173f30]"
          />
          <span>
            <span className="block text-sm font-bold text-[#173f30]">
              {copy.despatchPrefs.preferFewerTanks}
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-[#758078]">
              {copy.despatchPrefs.preferFewerTanksHint}
            </span>
          </span>
        </label>
      </div>
      <div className="p-4 sm:p-5">
        {!hasStock ? (
          <p className="text-sm leading-relaxed text-[#8a3d20]">
            {tankerLoadMt > 0 ? copy.despatch.noStock : copy.despatch.noPlans}
          </p>
        ) : (
          <>
            <p className="section-label">{copy.despatch.topPlans}</p>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {topPlans.map((plan, i) => (
                <DespatchOption
                  key={plan.sources.map((s) => `${s.name}-${s.mt}`).join("|")}
                  rank={i + 1}
                  plan={plan}
                  copy={copy}
                  highlighted={i === 0}
                  penaltyBands={penaltyBands}
                />
              ))}
            </div>
            {topPlans[0]?.shortfallMt > 0 && (
              <p className="mt-3 text-sm text-[#92441f]">
                {copy.despatch.shortfall(topPlans[0].shortfallMt)}
              </p>
            )}
            {penaltyRm !== null && penaltyRm > 0 && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-[#f0cfb9] bg-[#fff8f3] px-3 py-2.5 text-sm font-semibold text-[#92441f]">
                <Coins size={16} className="shrink-0" />
                {copy.penalty.totalExposure(n(penaltyRm, 0))}
              </div>
            )}

            {bestOptionPenalty !== null && (
              <div className="mt-4 rounded-xl border border-[#dce3dd] bg-[#f9fbf8] p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Truck size={16} className="shrink-0 text-[#245f43]" />
                  <span className="text-sm font-bold text-[#173f30]">{copy.despatch.todaysSummary}</span>
                </div>
                <div className="mt-2.5 flex flex-wrap items-end gap-3">
                  <label className="block">
                    <span className="field-label">{copy.despatch.tankersToday}</span>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={tankersToday || ""}
                      onChange={(e) => setTankersToday(Math.max(1, Number(e.target.value) || 1))}
                      className="mt-1 w-24 rounded-lg border border-[#dce3dd] bg-white px-3 py-2 text-sm font-semibold text-[#173f30] outline-none ring-[#00b14f] focus:ring-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    />
                  </label>
                  <div className="rounded-lg bg-white px-3 py-2">
                    <p className="text-[10px] font-bold uppercase text-[#7a867f]">
                      {copy.despatch.totalMtToday}
                    </p>
                    <p className="text-sm font-extrabold text-[#173f30]">
                      {n(tankersToday * topPlans[0].totalMt, 0)} MT
                    </p>
                  </div>
                  <div className="rounded-lg bg-white px-3 py-2">
                    <p className="text-[10px] font-bold uppercase text-[#7a867f]">
                      {copy.despatch.totalPenaltyToday}
                    </p>
                    <p className={`text-sm font-extrabold ${bestOptionPenalty > 0 ? "text-[#92441f]" : "text-[#00713a]"}`}>
                      RM {n(tankersToday * bestOptionPenalty, 0)}
                    </p>
                  </div>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-[#758078]">
                  {copy.despatch.todaysSummaryHint}
                </p>
              </div>
            )}
            <div className="mt-5 border-t border-[#e8ede8] pt-5">
              <Advice
                icon={<AlertTriangle size={17} />}
                title={copy.plan.beforeTransfer}
                text={copy.despatch.verifyBeforeLoad}
                warning
              />
            </div>
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
  penaltyBands,
}: {
  rank: number;
  plan: DespatchPlan;
  copy: Copy;
  highlighted: boolean;
  penaltyBands?: PenaltyBand[] | null;
}) {
  const penaltyRm = penaltyBands
    ? calcTotalExposure(
        plan.sources.map((s) => ({ ffaPct: s.ffaPct, tonnageMt: s.mt })),
        penaltyBands,
      )
    : null;

  return (
    <div
      className={`rounded-xl border p-2.5 ${
        highlighted ? "border-[#00b14f] bg-[#f6fae9]" : "border-[#dfe5dc] bg-[#f9fbf8]"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-bold text-[#173f30]">{copy.despatch.planRank(rank)}</span>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-bold text-[#58665e]">
            {copy.despatchPrefs.usesTanks(plan.sources.length)}
          </span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
              plan.meetsLimit ? "bg-[#d4f7e2] text-[#00713a]" : "bg-[#ffceb7] text-[#7c2d12]"
            }`}
          >
            {plan.meetsLimit ? copy.despatch.withinLimit : copy.despatch.aboveLimitShort}
          </span>
        </div>
      </div>
      <div className="despatch-sources">
        {plan.sources.map((source) => (
          <div key={source.name} className="plan-pill plan-pill--despatch py-2">
            <span className="text-[11px] text-[#708078]">{source.name}</span>
            <strong>{n(source.mt)} MT</strong>
            <span className="text-[10px] text-[#708078]">{n(source.ffaPct, 2)}% FFA</span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-xs font-bold text-[#3f4c46]">
        {copy.despatch.totalLoad(plan.totalMt)}
      </p>
      <p className="mt-1 text-xs font-bold text-[#00b14f]">{copy.despatch.loadFfa(plan.loadFfaPct)}</p>
      {penaltyRm !== null && (
        <p className={`mt-1 text-xs font-bold ${penaltyRm > 0 ? "text-[#92441f]" : "text-[#00713a]"}`}>
          {penaltyRm > 0 ? copy.despatch.optionPenalty(n(penaltyRm, 0)) : copy.despatch.optionNoPenalty}
        </p>
      )}
    </div>
  );
}

function TransferRateField({
  copy,
  label,
  value,
  onChange,
  autoTransfer,
  onUseAuto,
}: {
  copy: Copy;
  label: string;
  value: number;
  onChange: (v: number) => void;
  autoTransfer: boolean;
  onUseAuto: () => void;
}) {
  return (
    <div className="max-w-xs">
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <MiniField label={label} value={value} onChange={(v) => onChange(Math.max(0, v))} unit="MT/day" />
        </div>
        {autoTransfer ? (
          <span className="mb-0.5 inline-flex h-[42px] shrink-0 items-center gap-1 rounded-lg bg-[#d4f7e2] px-2.5 text-xs font-bold text-[#00713a]">
            <Wand2 size={12} />
            {copy.transferAuto.badge}
          </span>
        ) : (
          <button
            type="button"
            onClick={onUseAuto}
            className="mb-0.5 h-[42px] shrink-0 rounded-lg border border-[#dce3dd] bg-white px-2.5 text-xs font-bold text-[#173f30] hover:bg-[#f4f6f2]"
          >
            {copy.transferAuto.useAuto}
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-[#9aa59f]">{copy.transferAuto.hint}</p>
    </div>
  );
}

function LossOptimizerPanel({
  copy,
  results,
  hasProfile,
  maxTransferPerDayMt,
  onMaxTransferChange,
  autoTransfer,
  onUseAuto,
}: {
  copy: Copy;
  results: HoldVsDespatch[];
  hasProfile: boolean;
  maxTransferPerDayMt: number;
  onMaxTransferChange: (v: number) => void;
  autoTransfer: boolean;
  onUseAuto: () => void;
}) {
  const totalSavings = results.reduce((sum, r) => sum + r.savingsRm, 0);

  return (
    <Panel title={copy.lossOptimizer.title} subtitle={copy.lossOptimizer.subtitle} icon={<Scale size={19} />}>
      <TransferRateField
        copy={copy}
        label={copy.lossOptimizer.maxTransferLabel}
        value={maxTransferPerDayMt}
        onChange={onMaxTransferChange}
        autoTransfer={autoTransfer}
        onUseAuto={onUseAuto}
      />

      {!hasProfile || results.length === 0 ? (
        <p className="mt-4 text-sm text-[#58665e]">{copy.lossOptimizer.allGood}</p>
      ) : (
        <>
          <div className="mt-4 space-y-3">
            {results.map((r) => {
              const hold = r.recommendation === "hold";
              return (
                <div
                  key={r.tankName}
                  className={`rounded-xl border p-3 ${
                    hold ? "border-[#00b14f] bg-[#f6fae9]" : "border-[#efc7aa] bg-[#fff8f3]"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-bold text-[#173f30]">{r.tankName}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        hold ? "bg-[#d4f7e2] text-[#00713a]" : "bg-[#ffceb7] text-[#7c2d12]"
                      }`}
                    >
                      {hold ? copy.lossOptimizer.hold : copy.lossOptimizer.despatchNow}
                    </span>
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-[#53625a]">
                    {hold
                      ? r.bestDayFullyCompliant
                        ? copy.lossOptimizer.holdRecommendation(r.bestDay)
                        : copy.lossOptimizer.holdPartialRecommendation(r.bestDay, n(r.bestDayFfaPct, 2))
                      : copy.lossOptimizer.despatchNowRecommendation}
                  </p>
                  {hold && (
                    <p className="mt-1 text-xs text-[#708078]">
                      {copy.lossOptimizer.usingSources(
                        n(r.bestDayIncomingMt, 0),
                        n(r.bestDayTransferMt, 0),
                      )}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#708078]">
                    <span>
                      {copy.lossOptimizer.despatchNowPenalty}:{" "}
                      <strong className="text-[#92441f]">RM {n(r.despatchNowPenaltyRm, 0)}</strong>
                    </span>
                    <span className={r.savingsRm > 0 ? "font-bold text-[#00b14f]" : ""}>
                      {r.savingsRm > 0
                        ? `${copy.lossOptimizer.savingsIfHold}: RM ${n(r.savingsRm, 0)}`
                        : copy.lossOptimizer.noSavings}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {totalSavings > 0 && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-[#c8dfae] bg-[#f6fae9] px-3 py-2.5 text-sm font-semibold text-[#173f30]">
              <Scale size={16} className="shrink-0" />
              {copy.lossOptimizer.totalPotentialSavings(n(totalSavings, 0))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function BatchBlendPlanner({
  copy,
  tanks,
  selected,
  onToggleTank,
  target,
  maxTransferPerDayMt,
  onMaxTransferChange,
  autoTransfer,
  onUseAuto,
  result,
}: {
  copy: Copy;
  tanks: Tank[];
  selected: Set<number>;
  onToggleTank: (i: number) => void;
  target: number;
  maxTransferPerDayMt: number;
  onMaxTransferChange: (v: number) => void;
  autoTransfer: boolean;
  onUseAuto: () => void;
  result: BatchBlendResult | null;
}) {
  const reasonText = (reason: BatchBlendResult["reason"]) => {
    switch (reason) {
      case "no-spare-capacity":
        return copy.batchBlend.reasonNoSpareCapacity;
      case "no-low-ffa-source":
        return copy.batchBlend.reasonNoLowFfaSource;
      case "source-exhausted":
        return copy.batchBlend.reasonSourceExhausted;
      case "max-days-exceeded":
        return copy.batchBlend.reasonMaxDaysExceeded;
      default:
        return null;
    }
  };

  return (
    <Panel title={copy.batchBlend.title} subtitle={copy.batchBlend.subtitle} icon={<ArrowRightLeft size={19} />}>
      <p className="section-label">{copy.batchBlend.selectTanks}</p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {tanks.map((tank, i) => (
          <label
            key={tank.name}
            className={`flex cursor-pointer items-center gap-2 rounded-xl border p-2.5 text-sm ${
              selected.has(i) ? "border-[#00b14f] bg-[#f6fae9]" : "border-[#dfe5dc] bg-[#f9fbf8]"
            }`}
          >
            <input
              type="checkbox"
              checked={selected.has(i)}
              onChange={() => onToggleTank(i)}
              className="h-4 w-4 shrink-0 accent-[#173f30]"
            />
            <span className="min-w-0 truncate">
              <span className="block font-semibold text-[#173f30]">{tank.name}</span>
              <span className="block text-[11px] text-[#708078]">{n(tank.ffa, 2)}% FFA</span>
            </span>
          </label>
        ))}
      </div>

      <div className="mt-4">
        <TransferRateField
          copy={copy}
          label={copy.batchBlend.maxTransferLabel}
          value={maxTransferPerDayMt}
          onChange={onMaxTransferChange}
          autoTransfer={autoTransfer}
          onUseAuto={onUseAuto}
        />
      </div>

      <div className="mt-4 border-t border-[#e8ede8] pt-4">
        {selected.size < 2 || !result ? (
          <p className="text-sm text-[#58665e]">{copy.batchBlend.needAtLeastTwo}</p>
        ) : result.days === 0 ? (
          <div className="flex items-start gap-2 rounded-xl bg-[#f6fae9] p-3 text-sm text-[#173f30]">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[#00b14f]" />
            {copy.batchBlend.alreadyGood}
          </div>
        ) : result.feasible ? (
          <>
            <div className="flex items-start gap-2 rounded-xl bg-[#f6fae9] p-3 text-sm font-semibold text-[#173f30]">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[#00b14f]" />
              {copy.batchBlend.readyAfter(result.days ?? 0)}
            </div>
            {result.steps.length > 0 && (
              <div className="mt-3">
                <p className="section-label">{copy.batchBlend.stepsTitle}</p>
                <div className="mt-2 space-y-1.5">
                  {result.steps.map((s, i) => (
                    <div key={i} className="rounded-lg bg-[#f9fbf8] px-3 py-2 text-xs text-[#53625a]">
                      {copy.batchBlend.step(s.day, s.fromTank, s.toTank, n(s.mt, 0), n(s.toTankFfaAfter, 2))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-start gap-2 rounded-xl border border-[#efc7aa] bg-[#fff8f3] p-3 text-sm text-[#92441f]">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                {result.steps.length > 0
                  ? copy.batchBlend.partialProgress(result.steps[result.steps.length - 1].day)
                  : copy.batchBlend.notFeasible}
                {reasonText(result.reason) ? ` ${reasonText(result.reason)}` : ""}
              </span>
            </div>
            {result.steps.length > 0 && (
              <div className="mt-3">
                <p className="section-label">{copy.batchBlend.stepsTitle}</p>
                <div className="mt-2 space-y-1.5">
                  {result.steps.map((s, i) => (
                    <div key={i} className="rounded-lg bg-[#f9fbf8] px-3 py-2 text-xs text-[#53625a]">
                      {copy.batchBlend.step(s.day, s.fromTank, s.toTank, n(s.mt, 0), n(s.toTankFfaAfter, 2))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {result && result.steps.length > 0 && result.finalTanks.length > 0 && (
          <div className="mt-4">
            <p className="section-label">{copy.batchBlend.finalTitle}</p>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {result.finalTanks.map((t) => (
                <div key={t.name} className="rounded-lg bg-[#f9fbf8] p-2 text-center">
                  <p className="truncate text-[10px] text-[#708078]">{t.name}</p>
                  <p
                    className={`text-sm font-extrabold ${
                      t.ffa <= target ? "text-[#173f30]" : "text-[#92441f]"
                    }`}
                  >
                    {n(t.ffa, 2)}%
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

function DecisionSafeguards({
  copy,
  results,
  allocationTotal,
  target,
  anyProjectedBreach,
}: {
  copy: Copy;
  results: Result[];
  allocationTotal: number;
  target: number;
  anyProjectedBreach: boolean;
}) {
  const checks: [boolean, string][] = [
    [!results.some((r) => r.overflow), copy.safeguards.noOverflow],
    [allocationTotal === 100, copy.safeguards.allocation100],
    [results.every((r) => r.finalFFA <= target), copy.safeguards.finalFfaWithinLimit(target)],
    [!anyProjectedBreach, copy.safeguards.noProjectedBreach],
  ];

  return (
    <section className="rounded-2xl border border-[#d9e2da] bg-white p-4 shadow-sm sm:p-5">
      <p className="section-label">{copy.safeguards.title}</p>
      <div className="mt-4 space-y-3 text-sm">
        {checks.map(([ok, label], i) => (
          <div key={i} className="flex min-h-[44px] items-center justify-between gap-3">
            <span className="leading-snug text-[#53625a]">{label}</span>
            {ok ? (
              <CheckCircle2 size={20} className="shrink-0 text-[#00b14f]" />
            ) : (
              <AlertTriangle size={20} className="shrink-0 text-[#d2773d]" />
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

const PENALTY_STAT_COLOR = "#a4342c";

function PenaltyPanel({
  copy,
  profiles,
  activeProfile,
  onSelectProfile,
  onUpdateProfiles,
  penaltyPerTank,
  totalExposureRm,
}: {
  copy: Copy;
  profiles: BuyerProfile[];
  activeProfile: BuyerProfile | null;
  onSelectProfile: (id: string) => void;
  onUpdateProfiles: (updater: (profiles: BuyerProfile[]) => BuyerProfile[]) => void;
  penaltyPerTank: { name: string; rmPerMt: number; totalRm: number; band: PenaltyBand | null }[];
  totalExposureRm: number;
}) {
  const addProfile = () => {
    const fresh = createEmptyBuyerProfile(copy.penalty.newBuyer);
    onUpdateProfiles((prev) => [...prev, fresh]);
    onSelectProfile(fresh.id);
  };

  const deleteProfile = (id: string) => {
    onUpdateProfiles((prev) => prev.filter((p) => p.id !== id));
    const remaining = profiles.filter((p) => p.id !== id);
    if (remaining[0] && activeProfile?.id === id) onSelectProfile(remaining[0].id);
  };

  const renameActive = (name: string) => {
    if (!activeProfile) return;
    const id = activeProfile.id;
    onUpdateProfiles((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
  };

  const addBand = () => {
    if (!activeProfile) return;
    const id = activeProfile.id;
    const last = activeProfile.bands[activeProfile.bands.length - 1];
    const minFfaPct = last ? (last.maxFfaPct ?? last.minFfaPct + 0.2) : 4.81;
    onUpdateProfiles((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              bands: [
                ...p.bands,
                { id: newPenaltyBandId(), minFfaPct: Number(minFfaPct.toFixed(2)), maxFfaPct: null, deductionRmPerMt: 0 },
              ],
            }
          : p,
      ),
    );
  };

  const updateBand = (bandId: string, patch: Partial<PenaltyBand>) => {
    if (!activeProfile) return;
    const id = activeProfile.id;
    onUpdateProfiles((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, bands: p.bands.map((b) => (b.id === bandId ? { ...b, ...patch } : b)) } : p,
      ),
    );
  };

  const removeBand = (bandId: string) => {
    if (!activeProfile) return;
    const id = activeProfile.id;
    onUpdateProfiles((prev) =>
      prev.map((p) => (p.id === id ? { ...p, bands: p.bands.filter((b) => b.id !== bandId) } : p)),
    );
  };

  const exposedTanks = penaltyPerTank.filter((t) => t.totalRm > 0);

  return (
    <section className="overflow-hidden rounded-2xl border border-[#d9e2da] bg-white shadow-sm">
      <div className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 gap-3">
            <span className="mt-0.5 shrink-0 text-[#287451]">
              <Coins size={19} />
            </span>
            <div className="min-w-0">
              <h2 className="font-bold">{copy.penalty.title}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-[#758078]">{copy.penalty.subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={addProfile}
            className="btn-touch shrink-0 bg-[#00713a] text-white"
          >
            <Plus size={16} />
            {copy.penalty.addRefineryLabel}
          </button>
        </div>

        <p className="mt-4 text-xs font-bold uppercase tracking-wide text-[#6c7971]">
          {copy.penalty.selectClientLabel}
        </p>
        {profiles.length === 0 ? (
          <p className="mt-2 text-sm text-[#58665e]">{copy.penalty.noRefineries}</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {profiles.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onSelectProfile(p.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm font-bold transition-colors ${
                  activeProfile?.id === p.id
                    ? "border-[#00713a] bg-[#00713a] text-white"
                    : "border-[#dce3dd] bg-white text-[#173f30] hover:bg-[#f4f6f2]"
                }`}
              >
                <Coins size={14} />
                {p.name}
              </button>
            ))}
          </div>
        )}

        {activeProfile && (
          <div className="mt-4 space-y-3 border-t border-[#e8ede8] pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TextField
                label={copy.penalty.renameBuyer}
                value={activeProfile.name}
                onChange={renameActive}
                compact
              />
              {profiles.length > 1 && (
                <button
                  type="button"
                  onClick={() => deleteProfile(activeProfile.id)}
                  className="btn-touch border border-[#efd7ce] bg-white text-[#b45839]"
                >
                  <Trash2 size={16} />
                  {copy.penalty.deleteBuyer}
                </button>
              )}
            </div>

            {activeProfile.bands.length === 0 && (
              <p className="text-sm text-[#58665e]">{copy.penalty.noBands}</p>
            )}

            {activeProfile.bands.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-[#e8ede8] text-left text-[11px] font-bold uppercase tracking-wide text-[#6c7971]">
                      <th className="py-2 pr-2">{copy.penalty.bandColumn}</th>
                      <th className="py-2 pr-2">{copy.penalty.fromFfaColumn}</th>
                      <th className="py-2 pr-2">{copy.penalty.toFfaColumn}</th>
                      <th className="py-2 pr-2">{copy.penalty.deductionColumn}</th>
                      <th className="py-2 pr-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeProfile.bands.map((band, i) => (
                      <tr key={band.id} className="border-b border-[#f0f2ef] align-middle">
                        <td className="whitespace-nowrap py-2 pr-2 font-bold text-[#173f30]">
                          {copy.penalty.bandLevelLabel(i + 1)}
                        </td>
                        <td className="py-2 pr-2">
                          <NumericInput
                            label={copy.penalty.minFfa}
                            value={band.minFfaPct}
                            onChange={(v) => updateBand(band.id, { minFfaPct: v })}
                            className="numeric-input w-16"
                          />
                        </td>
                        <td className="py-2 pr-2">
                          <NullableNumericInput
                            label={copy.penalty.maxFfa}
                            value={band.maxFfaPct}
                            onChange={(v) => updateBand(band.id, { maxFfaPct: v })}
                            className="numeric-input w-16"
                          />
                        </td>
                        <td className="py-2 pr-2 font-semibold" style={{ color: PENALTY_STAT_COLOR }}>
                          <div className="flex items-center gap-1">
                            RM
                            <NumericInput
                              label={copy.penalty.deduction}
                              value={band.deductionRmPerMt}
                              onChange={(v) => updateBand(band.id, { deductionRmPerMt: v })}
                              className="numeric-input w-16"
                            />
                            /MT
                          </div>
                        </td>
                        <td className="py-2 pr-2 text-right">
                          <button
                            type="button"
                            onClick={() => removeBand(band.id)}
                            aria-label={copy.penalty.removeBand}
                            title={copy.penalty.removeBand}
                            className="remove-tank remove-tank--compact"
                          >
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1.5 text-xs text-[#8a9690]">{copy.penalty.noCeilingHint}</p>
              </div>
            )}

            <button
              type="button"
              onClick={addBand}
              className="btn-touch border border-[#b9c8bd] bg-white text-[#173f30]"
            >
              <Plus size={16} />
              {copy.penalty.addBand}
            </button>

            <div className="flex items-center justify-between gap-3 rounded-xl border border-[#efc7aa] bg-[#fff8f3] px-3.5 py-3">
              <span className="text-sm font-semibold text-[#7a4a32]">{copy.penalty.estimatedExposure}</span>
              <span className="text-lg font-extrabold" style={{ color: PENALTY_STAT_COLOR }}>
                RM {n(totalExposureRm, 0)}
              </span>
            </div>

            {exposedTanks.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {exposedTanks.map((t) => (
                  <div key={t.name} className="rounded-lg bg-[#f9fbf8] p-2 text-center">
                    <p className="truncate text-[10px] text-[#708078]">{t.name}</p>
                    <p className="text-sm font-extrabold text-[#7a4a32]">RM {n(t.totalRm, 0)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[#58665e]">{copy.penalty.noExposure}</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Plan how much of today's despatch goes to which refinery client — each
 *  refinery has its own tiered penalty bands (set up above), and the same
 *  blend FFA can cost a very different amount depending on who's buying it.
 *  This is a same-day planning scratchpad (which refineries, how much MT
 *  each) — it isn't saved to the mill's record, since it's re-entered fresh
 *  each despatch day rather than being part of the mill's ongoing state. */
function RefineryDespatchTable({
  copy,
  profiles,
  defaultFfaPct,
  tankerLoadMt,
  onTankerLoadChange,
}: {
  copy: Copy;
  profiles: BuyerProfile[];
  defaultFfaPct: number;
  tankerLoadMt: number;
  onTankerLoadChange: (v: number) => void;
}) {
  const [achievedFfa, setAchievedFfa] = useState(defaultFfaPct);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [volumes, setVolumes] = useState<Record<string, number>>({});

  const rows = profiles.map((p) => {
    const mt = volumes[p.id] ?? 0;
    const exposure = calcPenaltyExposure(achievedFfa, mt, p.bands);
    const lowestRate = p.bands.length
      ? Math.min(...p.bands.map((b) => b.deductionRmPerMt))
      : null;
    const lorries = mt > 0 && tankerLoadMt > 0 ? Math.ceil(mt / tankerLoadMt) : 0;
    return { profile: p, mt, exposure, lowestRate, lorries };
  });
  const selectedRows = rows.filter((r) => selected.has(r.profile.id));
  const totalPenaltyRm = selectedRows.reduce((s, r) => s + r.exposure.totalRm, 0);
  const totalLorries = selectedRows.reduce((s, r) => s + r.lorries, 0);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="overflow-hidden rounded-2xl border border-[#d9e2da] bg-white shadow-sm">
      <div className="p-4 sm:p-5">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 shrink-0 text-[#287451]">
            <Truck size={19} />
          </span>
          <div className="min-w-0">
            <h2 className="font-bold">{copy.refineryDespatch.title}</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-[#758078]">{copy.refineryDespatch.subtitle}</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <label className="block w-40">
            <span className="field-label">{copy.refineryDespatch.achievedFfaLabel}</span>
            <div className="field-shell">
              <NumericInput
                label={copy.refineryDespatch.achievedFfaLabel}
                value={achievedFfa}
                onChange={setAchievedFfa}
                className="numeric-input"
              />
              <span className="shrink-0 text-sm text-[#7a867f]">%</span>
            </div>
          </label>
          <label className="block w-40">
            <span className="field-label">{copy.refineryDespatch.tankerLoadLabel}</span>
            <div className="field-shell">
              <NumericInput
                label={copy.refineryDespatch.tankerLoadLabel}
                value={tankerLoadMt}
                onChange={onTankerLoadChange}
                className="numeric-input"
              />
              <span className="shrink-0 text-sm text-[#7a867f]">MT</span>
            </div>
          </label>
        </div>

        {profiles.length === 0 ? (
          <p className="mt-4 text-sm text-[#58665e]">{copy.refineryDespatch.noRefineries}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#e8ede8] text-left text-[11px] font-bold uppercase tracking-wide text-[#6c7971]">
                  <th className="py-2 pr-2"></th>
                  <th className="py-2 pr-2">{copy.refineryDespatch.refineryColumn}</th>
                  <th className="py-2 pr-2">{copy.refineryDespatch.policyColumn}</th>
                  <th className="py-2 pr-2">{copy.refineryDespatch.volumeColumn}</th>
                  <th className="py-2 pr-2">{copy.refineryDespatch.lorriesColumn}</th>
                  <th className="py-2 pr-2">{copy.refineryDespatch.ffaColumn}</th>
                  <th className="py-2 pr-2">{copy.refineryDespatch.tieredPenaltyColumn}</th>
                  <th className="py-2 pr-2 text-right">{copy.refineryDespatch.totalColumn}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ profile, mt, exposure, lowestRate, lorries }) => (
                  <tr key={profile.id} className="border-b border-[#f0f2ef] align-middle">
                    <td className="py-2 pr-2">
                      <input
                        type="checkbox"
                        checked={selected.has(profile.id)}
                        onChange={() => toggle(profile.id)}
                        className="h-4 w-4 accent-[#00713a]"
                        aria-label={profile.name}
                      />
                    </td>
                    <td className="max-w-[160px] truncate py-2 pr-2 font-bold text-[#173f30]" title={profile.name}>
                      {profile.name}
                    </td>
                    <td className="py-2 pr-2">
                      {lowestRate !== null ? (
                        <span className="inline-block whitespace-nowrap rounded-full bg-[#f4f6f2] px-2 py-0.5 text-[11px] font-bold text-[#6c7971]">
                          {copy.refineryDespatch.lowestRate(n(lowestRate, 2))}
                        </span>
                      ) : (
                        <span className="text-[11px] text-[#8a9690]">{copy.penalty.noBands}</span>
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      <NumericInput
                        label={copy.refineryDespatch.volumeColumn}
                        value={mt}
                        onChange={(v) => setVolumes((prev) => ({ ...prev, [profile.id]: Math.max(0, v) }))}
                        className="numeric-input w-20"
                      />
                    </td>
                    <td className="whitespace-nowrap py-2 pr-2 text-[#3f4c46]">
                      {lorries > 0 ? copy.refineryDespatch.lorryCount(lorries) : "—"}
                    </td>
                    <td className="whitespace-nowrap py-2 pr-2 text-[#3f4c46]">{n(achievedFfa, 2)}%</td>
                    <td className="whitespace-nowrap py-2 pr-2 font-semibold" style={{ color: PENALTY_STAT_COLOR }}>
                      RM {n(exposure.rmPerMt, 2)}/MT
                    </td>
                    <td className="whitespace-nowrap py-2 pr-2 text-right font-extrabold" style={{ color: PENALTY_STAT_COLOR }}>
                      RM {n(exposure.totalRm, 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {profiles.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#efc7aa] bg-[#fff8f3] px-3.5 py-3">
            <span className="text-sm font-semibold text-[#7a4a32]">
              {copy.refineryDespatch.totalToday(n(totalPenaltyRm, 0))}
            </span>
            {totalLorries > 0 && (
              <span className="text-sm font-semibold text-[#7a4a32]">
                {copy.refineryDespatch.lorryCount(totalLorries)}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

const FORECAST_LINE_COLORS = ["#173f30", "#3d9b62", "#c9873f", "#b45839", "#00b14f", "#6c7971"];

function FfaForecastPanel({
  copy,
  projections,
  target,
  riseFactorPerDay,
  onRiseFactorChange,
  horizonDays,
  onHorizonChange,
}: {
  copy: Copy;
  projections: { name: string; points: { day: number; ffaPct: number }[]; daysToLimit: number | null }[];
  target: number;
  riseFactorPerDay: number;
  onRiseFactorChange: (v: number) => void;
  horizonDays: number;
  onHorizonChange: (v: number) => void;
}) {
  const chartData = useMemo(() => {
    const rows: Record<string, number>[] = [];
    for (let day = 0; day <= horizonDays; day += 1) {
      const row: Record<string, number> = { day };
      projections.forEach((p) => {
        row[p.name] = p.points[day]?.ffaPct ?? p.points[p.points.length - 1]?.ffaPct ?? 0;
      });
      rows.push(row);
    }
    return rows;
  }, [projections, horizonDays]);

  return (
    <Panel title={copy.prediction.title} subtitle={copy.prediction.subtitle} icon={<TrendingUp size={19} />}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MiniField
          label={copy.prediction.riseFactorLabel}
          value={riseFactorPerDay * 100}
          onChange={(v) => onRiseFactorChange(v / 100)}
          unit="%"
        />
        <MiniField
          label={copy.prediction.horizonLabel}
          value={horizonDays}
          onChange={(v) => onHorizonChange(Math.max(1, Math.round(v)))}
          unit="days"
        />
      </div>

      {chartData.length > 0 && (
        <div className="mt-4 h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 22 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e8ede8" />
              <XAxis
                dataKey="day"
                tick={{ fontSize: 11, fill: "#4b5750" }}
                tickMargin={8}
                label={{
                  value: copy.prediction.daysAxis,
                  position: "bottom",
                  offset: 0,
                  fontSize: 12,
                  fontWeight: 700,
                  fill: "#3f4c46",
                }}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "#4b5750" }}
                width={52}
                tickMargin={6}
                label={{
                  value: copy.prediction.ffaAxis,
                  angle: -90,
                  position: "insideLeft",
                  offset: 12,
                  style: { textAnchor: "middle" },
                  fontSize: 12,
                  fontWeight: 700,
                  fill: "#3f4c46",
                }}
              />
              <Tooltip
                formatter={(value) => `${n(Number(value), 2)}%`}
                labelFormatter={(label) => `${copy.prediction.daysAxis} ${label}`}
                contentStyle={{ borderRadius: 10, border: "1px solid #dfe5df", fontSize: 12 }}
              />
              <ReferenceLine
                y={target}
                stroke="#c9483e"
                strokeDasharray="4 4"
                label={{ value: `${n(target, 2)}%`, position: "right", fontSize: 10, fill: "#c9483e" }}
              />
              {projections.map((p, i) => (
                <Line
                  key={p.name}
                  type="monotone"
                  dataKey={p.name}
                  stroke={FORECAST_LINE_COLORS[i % FORECAST_LINE_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="mt-4 space-y-2">
        {projections.map((p) => (
          <div
            key={p.name}
            className={`flex items-start gap-2 rounded-lg p-2.5 text-sm ${
              p.daysToLimit !== null ? "bg-[#fff8f3] text-[#92441f]" : "bg-[#f8faf7] text-[#58665e]"
            }`}
          >
            {p.daysToLimit !== null ? (
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            ) : (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-[#00b14f]" />
            )}
            <span>
              {p.daysToLimit !== null
                ? copy.prediction.willCross(p.name, p.daysToLimit)
                : copy.prediction.staysWithin(p.name)}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ProductionOptimizer({
  copy,
  suggestion,
  showScenarioCompare,
  onToggleScenarioCompare,
  scenarios,
  scenarioResults,
  onScenarioChange,
  baselineIncomingCpo,
  baselineMeetsTarget,
  baselineOverflow,
}: {
  copy: Copy;
  suggestion: SafeProductionSuggestion;
  showScenarioCompare: boolean;
  onToggleScenarioCompare: () => void;
  scenarios: { id: string; millCapacity: number; hours: number; utilisation: number; oer: number; incomingFFA: number }[];
  scenarioResults: { id: string; incomingCpo: number; meetsTarget: boolean; overflow: boolean; feasible: boolean }[];
  onScenarioChange: (id: string, key: "millCapacity" | "hours" | "utilisation" | "oer" | "incomingFFA", value: number) => void;
  baselineIncomingCpo: number;
  baselineMeetsTarget: boolean;
  baselineOverflow: boolean;
}) {
  const bindingLabel =
    suggestion.binding === "capacity"
      ? copy.production.bindingCapacity
      : suggestion.binding === "ffa"
        ? copy.production.bindingFfa
        : copy.production.bindingNone;

  return (
    <Panel title={copy.production.title} subtitle={copy.production.subtitle} icon={<Wand2 size={19} />}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-[#f6fae9] p-3">
          <p className="text-[11px] font-bold uppercase text-[#58665e]">{copy.production.safeIncoming}</p>
          <p className="mt-1 text-xl font-extrabold text-[#173f30]">{n(suggestion.maxSafeIncomingCpoMt)} MT</p>
          <p className="mt-1 text-xs text-[#58665e]">{bindingLabel}</p>
        </div>
        <div className="rounded-xl bg-[#f9fbf8] p-3">
          <p className="text-[11px] font-bold uppercase text-[#58665e]">{copy.production.suggestedHours}</p>
          <p className="mt-1 text-xl font-extrabold text-[#173f30]">
            {suggestion.suggestedHoursAtCurrentUtilisation !== null
              ? `${n(suggestion.suggestedHoursAtCurrentUtilisation)} hr`
              : "—"}
          </p>
        </div>
        <div className="rounded-xl bg-[#f9fbf8] p-3">
          <p className="text-[11px] font-bold uppercase text-[#58665e]">{copy.production.suggestedUtilisation}</p>
          <p className="mt-1 text-xl font-extrabold text-[#173f30]">
            {suggestion.suggestedUtilisationPctAtCurrentHours !== null
              ? `${n(suggestion.suggestedUtilisationPctAtCurrentHours, 0)}%`
              : "—"}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={onToggleScenarioCompare}
        className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-[#dfe5df] bg-white px-3 py-1.5 text-xs font-bold text-[#173f30]"
      >
        {copy.production.compareScenarios}
        <ChevronDown size={14} className={`transition-transform ${showScenarioCompare ? "rotate-180" : ""}`} />
      </button>

      {showScenarioCompare && (
        <div className="mt-3 space-y-3">
          <p className="text-xs leading-relaxed text-[#758078]">{copy.production.compareScenariosHint}</p>

          <div className="rounded-xl border border-[#dfe5dc] bg-[#f9fbf8] p-3">
            <p className="text-xs font-bold text-[#173f30]">{copy.production.scenarioBaseline}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <span className="text-[#58665e]">
                {copy.production.incomingCpo}: <strong className="text-[#173f30]">{n(baselineIncomingCpo)} MT</strong>
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  baselineMeetsTarget && !baselineOverflow
                    ? "bg-[#d4f7e2] text-[#00713a]"
                    : "bg-[#ffceb7] text-[#7c2d12]"
                }`}
              >
                {baselineMeetsTarget && !baselineOverflow ? copy.production.meetsLimit : copy.production.overLimit}
              </span>
            </div>
          </div>

          {scenarios.map((s, i) => {
            const result = scenarioResults.find((r) => r.id === s.id);
            return (
              <div key={s.id} className="rounded-xl border border-[#dfe5dc] bg-white p-3">
                <p className="text-xs font-bold text-[#173f30]">{copy.production.scenarioLabel(i + 1)}</p>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <MiniField
                    label={copy.forecast.capacity}
                    value={s.millCapacity}
                    onChange={(v) => onScenarioChange(s.id, "millCapacity", v)}
                    unit="MT/hr"
                  />
                  <MiniField
                    label={copy.forecast.operatingHours}
                    value={s.hours}
                    onChange={(v) => onScenarioChange(s.id, "hours", v)}
                    unit="hr"
                  />
                  <MiniField
                    label={copy.forecast.utilisation}
                    value={s.utilisation}
                    onChange={(v) => onScenarioChange(s.id, "utilisation", v)}
                    unit="%"
                  />
                  <MiniField
                    label={copy.forecast.expectedOer}
                    value={s.oer}
                    onChange={(v) => onScenarioChange(s.id, "oer", v)}
                    unit="%"
                  />
                  <MiniField
                    label={copy.forecast.incomingFfa}
                    value={s.incomingFFA}
                    onChange={(v) => onScenarioChange(s.id, "incomingFFA", v)}
                    unit="%"
                  />
                </div>
                {result && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                    <span className="text-[#58665e]">
                      {copy.production.incomingCpo}: <strong className="text-[#173f30]">{n(result.incomingCpo)} MT</strong>
                    </span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        result.feasible && result.meetsTarget && !result.overflow
                          ? "bg-[#d4f7e2] text-[#00713a]"
                          : "bg-[#ffceb7] text-[#7c2d12]"
                      }`}
                    >
                      {result.feasible && result.meetsTarget && !result.overflow
                        ? copy.production.meetsLimit
                        : copy.production.overLimit}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

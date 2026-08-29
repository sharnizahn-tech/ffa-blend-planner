export type Lang = "en" | "bm";

const n = (v: number, d = 1) =>
  v.toLocaleString("en-MY", { minimumFractionDigits: d, maximumFractionDigits: d });

export const translations = {
  en: {
    appTitle: "FFA Blend Planner",
    appSubtitle: "CPO quality decision support",
    ready: "Ready",
    footer:
      "Decision-support tool only · Final transfer requires authorised engineer verification",
    nav: { overview: "Overview", tanks: "Tanks", plan: "Plan" },
    metrics: {
      currentStock: "Current stock",
      highFfaStock: "High-FFA stock",
      expectedCpo: "Expected CPO",
      incomingFfa: "Incoming FFA",
      acrossTanks: (count: number) => `Across ${count} tanks`,
      actionRequired: "Action required",
      withinTarget: "Within target",
      fromFfb: (ffb: number) => `From ${n(ffb, 0)} MT FFB`,
      targetLe: (target: number) => `Target ≤ ${n(target, 2)}%`,
    },
    forecast: {
      title: "Production forecast",
      subtitle: "Estimate the CPO that must be routed",
      capacity: "Capacity",
      operatingHours: "Operating hours",
      utilisation: "Utilisation",
      expectedOer: "Expected OER",
      incomingFfa: "Incoming FFA",
      ffaTarget: "FFA target",
    },
    allocation: {
      mustEqual100: "Allocation total must equal 100%",
      addBst: "Add BST",
      useBestPlan: "Use best plan",
      applyRecommended: "Apply recommended allocation",
    },
    tanks: {
      title: "Tank readings & allocation",
      subtitle: "Add or remove BSTs to match the mill configuration",
      capacity: "Capacity",
      stockNow: "Stock now",
      ffaNow: "FFA now",
      allocation: "Allocation",
      finalStock: "Final stock",
      finalFfa: "Final FFA",
      filledAfter: (pct: number) => `${n(pct, 0)}% filled after`,
      remove: (name: string) => `Remove ${name}`,
      overflow: "Overflow",
      highFfa: "High FFA",
      withinTarget: "Within target",
    },
    alerts: {
      overflowTitle: "Tank overflow detected",
      overflowText:
        "One or more tanks exceed capacity with the current allocation. Adjust percentages or tank readings.",
    },
    plan: {
      smartRecommendation: "Smart recommendation",
      planChecked: "PLAN CHECKED",
      checkInput: "CHECK INPUT",
      safeAllocation: "A safe allocation is available",
      targetNotAchievable: "FFA target cannot be fully achieved",
      planBasis:
        "Based on tank capacity, current stock, FFA target and protection of acceptable-quality stock.",
      recommendedAllocation: "Recommended allocation",
      priorityAction: "Priority action",
      assessment: "Assessment",
      beforeTransfer: "Before transfer",
      priorityHighFfa: (mt: number, tanks: string) =>
        `${n(mt, 0)} MT above target${tanks ? ` (${tanks})` : ""}. Avoid adding more high-FFA CPO there unless no safer capacity is available. Prioritise controlled despatch or blending with verified low-FFA CPO.`,
      priorityAllOk:
        "All current tanks are within target. Protect acceptable stock and maintain sufficient free capacity.",
      assessmentMeetsTarget:
        "This plan stays within tank capacity and keeps calculated final FFA within target.",
      assessmentMinImpact:
        "No allocation can make every tank meet the target using this incoming FFA. This plan minimises quality impact and protects lower-FFA stock as far as practical.",
      beforeTransferText:
        "Engineer must verify latest tank dipping, laboratory FFA, available capacity and valve routing. This recommendation is not an approval.",
      noFeasiblePlan:
        "No feasible plan is available. Available capacity is lower than expected incoming CPO.",
    },
    ai: {
      advisor: "AI advisor",
      description:
        "Ask about your calculated plan in plain language — numbers always come from the engine.",
      questionPlaceholder:
        "Type a question, e.g. Can we send more CPO to BST 3? Why avoid BST 2?",
      ask: "Ask AI",
      generating: "Generating…",
      wait: (s: number) => `Wait ${s}s`,
      opinionLive: "AI opinion",
      opinionOffline: "Instant mill summary",
      offlineUnavailable: "Offline summary (OpenAI unavailable)",
      errorGeneric: "Unable to get AI opinion.",
    },
    safeguards: {
      title: "Decision safeguards",
      noOverflow: "No tank overflow",
      allocation100: "Allocation equals 100%",
      noHighFfa: "No high-FFA stock held",
      finalFfaLe: (target: number) => `Final FFA ≤ ${n(target, 2)}%`,
    },
  },
  bm: {
    appTitle: "Perancang Campuran FFA",
    appSubtitle: "Sokongan keputusan kualiti CPO",
    ready: "Sedia",
    footer:
      "Alat sokongan keputusan sahaja · Pemindahan akhir memerlukan pengesahan jurutera berwibawa",
    nav: { overview: "Ringkasan", tanks: "Tangki", plan: "Pelan" },
    metrics: {
      currentStock: "Stok semasa",
      highFfaStock: "Stok FFA tinggi",
      expectedCpo: "CPO dijangka",
      incomingFfa: "FFA masuk",
      acrossTanks: (count: number) => `Merentasi ${count} tangki`,
      actionRequired: "Tindakan diperlukan",
      withinTarget: "Dalam sasaran",
      fromFfb: (ffb: number) => `Daripada ${n(ffb, 0)} MT TBS`,
      targetLe: (target: number) => `Sasaran ≤ ${n(target, 2)}%`,
    },
    forecast: {
      title: "Ramalan pengeluaran",
      subtitle: "Anggar CPO yang perlu dialirkan",
      capacity: "Kapasiti",
      operatingHours: "Jam operasi",
      utilisation: "Utilisasi",
      expectedOer: "OER dijangka",
      incomingFfa: "FFA masuk",
      ffaTarget: "Sasaran FFA",
    },
    allocation: {
      mustEqual100: "Jumlah peruntukan mesti 100%",
      addBst: "Tambah BST",
      useBestPlan: "Guna pelan terbaik",
      applyRecommended: "Guna peruntukan disyorkan",
    },
    tanks: {
      title: "Bacaan tangki & peruntukan",
      subtitle: "Tambah atau buang BST mengikut konfigurasi kilang",
      capacity: "Kapasiti",
      stockNow: "Stok semasa",
      ffaNow: "FFA semasa",
      allocation: "Peruntukan",
      finalStock: "Stok akhir",
      finalFfa: "FFA akhir",
      filledAfter: (pct: number) => `${n(pct, 0)}% penuh selepas`,
      remove: (name: string) => `Buang ${name}`,
      overflow: "Melimpah",
      highFfa: "FFA tinggi",
      withinTarget: "Dalam sasaran",
    },
    alerts: {
      overflowTitle: "Limpahan tangki dikesan",
      overflowText:
        "Satu atau lebih tangki melebihi kapasiti dengan peruntukan semasa. Laraskan peratusan atau bacaan tangki.",
    },
    plan: {
      smartRecommendation: "Cadangan pintar",
      planChecked: "PELAN DISAHKAN",
      checkInput: "SEMAK INPUT",
      safeAllocation: "Peruntukan selamat tersedia",
      targetNotAchievable: "Sasaran FFA tidak boleh dicapai sepenuhnya",
      planBasis:
        "Berdasarkan kapasiti tangki, stok semasa, sasaran FFA dan perlindungan stok berkualiti baik.",
      recommendedAllocation: "Peruntukan disyorkan",
      priorityAction: "Tindakan keutamaan",
      assessment: "Penilaian",
      beforeTransfer: "Sebelum pemindahan",
      priorityHighFfa: (mt: number, tanks: string) =>
        `${n(mt, 0)} MT melebihi sasaran${tanks ? ` (${tanks})` : ""}. Elakkan menambah CPO FFA tinggi ke situ melainkan tiada kapasiti lebih selamat. Utamakan despatch terkawal atau campuran dengan CPO FFA rendah yang disahkan.`,
      priorityAllOk:
        "Semua tangki semasa dalam sasaran. Lindungi stok yang boleh diterima dan kekalkan ruang kosong yang mencukupi.",
      assessmentMeetsTarget:
        "Pelan ini kekal dalam kapasiti tangki dan mengekalkan FFA akhir yang dikira dalam sasaran.",
      assessmentMinImpact:
        "Tiada peruntukan boleh membuat setiap tangki memenuhi sasaran dengan FFA masuk ini. Pelan ini meminimumkan kesan kualiti dan melindungi stok FFA rendah sejauh mungkin.",
      beforeTransferText:
        "Jurutera mesti sahkan dipping tangki terkini, FFA makmal, kapasiti available dan laluan injap. Cadangan ini bukan kelulusan.",
      noFeasiblePlan:
        "Tiada pelan munasabah. Kapasiti available lebih rendah daripada CPO masuk dijangka.",
    },
    ai: {
      advisor: "Penasihat AI",
      description:
        "Tanya tentang pelan yang dikira — nombor sentiasa daripada enjin pengiraan.",
      questionPlaceholder:
        "Taip soalan, cth. Bolehkah hantar lebih CPO ke BST 3? Kenapa elak BST 2?",
      ask: "Tanya AI",
      generating: "Menjana…",
      wait: (s: number) => `Tunggu ${s}s`,
      opinionLive: "Pendapat AI",
      opinionOffline: "Ringkasan kilang",
      offlineUnavailable: "Ringkasan luar talian (OpenAI tidak tersedia)",
      errorGeneric: "Tidak dapat mendapatkan pendapat AI.",
    },
    safeguards: {
      title: "Safeguard keputusan",
      noOverflow: "Tiada limpahan tangki",
      allocation100: "Peruntukan sama dengan 100%",
      noHighFfa: "Tiada stok FFA tinggi",
      finalFfaLe: (target: number) => `FFA akhir ≤ ${n(target, 2)}%`,
    },
  },
} as const;

export type Copy = (typeof translations)[Lang];

export function getCopy(lang: Lang): Copy {
  return translations[lang];
}

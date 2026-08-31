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
      goodQuality: "Good quality",
      fromFfb: (ffb: number) => `From ${n(ffb, 0)} MT FFB`,
      ffaLimitNote: (limit: number) => `Limit ≤ ${n(limit, 2)}% · lower is better`,
    },
    forecast: {
      title: "Production forecast",
      subtitle: "Estimate the CPO that must be routed",
      capacity: "Capacity",
      operatingHours: "Operating hours",
      utilisation: "Utilisation",
      expectedOer: "Expected OER",
      incomingFfa: "Incoming FFA",
      ffaLimit: "Good FFA limit",
      ffaLimitHint: "4.8% is the maximum for good FFA — the lower, the better.",
    },
    allocation: {
      mustEqual100: "Allocation total must equal 100%",
      addBst: "Add tank",
      useBestPlan: "Use best plan",
      applyRecommended: "Apply recommended allocation",
    },
    tanks: {
      title: "Tank readings & allocation",
      subtitle: "Name each tank yourself (e.g. BST 3, BST 4 for production) and add or remove as needed",
      name: "Tank name",
      namePlaceholder: "e.g. BST 3",
      capacity: "Capacity",
      stockNow: "Stock now",
      ffaNow: "FFA now",
      allocation: "Allocation",
      finalStock: "Final stock",
      finalFfa: "Final FFA",
      filledAfter: (pct: number) => `${n(pct, 0)}% filled after`,
      remove: (name: string) => `Remove ${name}`,
      overflow: "Overflow",
      aboveLimit: "Above limit",
      goodFfa: "Good FFA",
      before: "Before",
      after: "After",
      beforeAfter: "Before → After",
      incomingQty: "Incoming quantity",
      remainingCapacity: "Remaining capacity",
      stock: "Stock",
      ffa: "FFA",
      expandTank: (name: string) => `Expand ${name}`,
      collapseTank: (name: string) => `Collapse ${name}`,
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
      limitNotAchievable: "Good FFA limit cannot be met for all tanks",
      planBasis:
        "Based on tank capacity, current stock, and the good FFA limit (lower FFA is better; 4.8% is the maximum for good quality).",
      recommendedAllocation: "Recommended allocation",
      priorityAction: "Priority action",
      assessment: "Assessment",
      beforeTransfer: "Before transfer",
      priorityHighFfa: (mt: number, tanks: string) =>
        `${n(mt, 0)} MT already above the good FFA limit${tanks ? ` (${tanks})` : ""}. Avoid adding more high-FFA CPO there unless no safer capacity is available. Prioritise low-FFA stock and controlled despatch.`,
      priorityAllOk:
        "All tanks are at or below the good FFA limit. Protect low-FFA stock and maintain free capacity.",
      assessmentMeetsLimit:
        "This plan stays within tank capacity and keeps final FFA at or below the good FFA limit. Lower final FFA is better.",
      assessmentMinImpact:
        "No allocation can keep every tank at or below the good FFA limit with this incoming FFA. This plan minimises quality impact and favours lower-FFA stock.",
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
      noHighFfa: "No stock above good FFA limit",
      finalFfaWithinLimit: (limit: number) =>
        `Final FFA ≤ ${n(limit, 2)}% (good limit · lower is better)`,
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
      goodQuality: "Kualiti baik",
      fromFfb: (ffb: number) => `Daripada ${n(ffb, 0)} MT TBS`,
      ffaLimitNote: (limit: number) => `Had ≤ ${n(limit, 2)}% · lebih rendah lebih baik`,
    },
    forecast: {
      title: "Ramalan pengeluaran",
      subtitle: "Anggar CPO yang perlu dialirkan",
      capacity: "Kapasiti",
      operatingHours: "Jam operasi",
      utilisation: "Utilisasi",
      expectedOer: "OER dijangka",
      incomingFfa: "FFA masuk",
      ffaLimit: "Had FFA baik",
      ffaLimitHint: "4.8% ialah maksimum untuk FFA baik — lebih rendah lebih baik.",
    },
    allocation: {
      mustEqual100: "Jumlah peruntukan mesti 100%",
      addBst: "Tambah tangki",
      useBestPlan: "Guna pelan terbaik",
      applyRecommended: "Guna peruntukan disyorkan",
    },
    tanks: {
      title: "Bacaan tangki & peruntukan",
      subtitle: "Namakan setiap tangki sendiri (cth. BST 3, BST 4 untuk pengeluaran) dan tambah atau buang mengikut keperluan",
      name: "Nama tangki",
      namePlaceholder: "cth. BST 3",
      capacity: "Kapasiti",
      stockNow: "Stok semasa",
      ffaNow: "FFA semasa",
      allocation: "Peruntukan",
      finalStock: "Stok akhir",
      finalFfa: "FFA akhir",
      filledAfter: (pct: number) => `${n(pct, 0)}% penuh selepas`,
      remove: (name: string) => `Buang ${name}`,
      overflow: "Melimpah",
      aboveLimit: "Melebihi had",
      goodFfa: "FFA baik",
      before: "Sebelum",
      after: "Selepas",
      beforeAfter: "Sebelum → Selepas",
      incomingQty: "Kuantiti masuk",
      remainingCapacity: "Kapasiti baki",
      stock: "Stok",
      ffa: "FFA",
      expandTank: (name: string) => `Kembang ${name}`,
      collapseTank: (name: string) => `Runtuhkan ${name}`,
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
      limitNotAchievable: "Had FFA baik tidak boleh dicapai untuk semua tangki",
      planBasis:
        "Berdasarkan kapasiti tangki, stok semasa, dan had FFA baik (FFA lebih rendah lebih baik; 4.8% ialah maksimum untuk kualiti baik).",
      recommendedAllocation: "Peruntukan disyorkan",
      priorityAction: "Tindakan keutamaan",
      assessment: "Penilaian",
      beforeTransfer: "Sebelum pemindahan",
      priorityHighFfa: (mt: number, tanks: string) =>
        `${n(mt, 0)} MT sudah melebihi had FFA baik${tanks ? ` (${tanks})` : ""}. Elakkan menambah CPO FFA tinggi ke situ melainkan tiada kapasiti lebih selamat. Utamakan stok FFA rendah dan despatch terkawal.`,
      priorityAllOk:
        "Semua tangki pada atau di bawah had FFA baik. Lindungi stok FFA rendah dan kekalkan ruang kosong.",
      assessmentMeetsLimit:
        "Pelan ini kekal dalam kapasiti tangki dan mengekalkan FFA akhir pada atau di bawah had FFA baik. FFA akhir lebih rendah lebih baik.",
      assessmentMinImpact:
        "Tiada peruntukan boleh mengekalkan setiap tangki pada atau di bawah had FFA baik dengan FFA masuk ini. Pelan ini meminimumkan kesan kualiti dan mengutamakan stok FFA rendah.",
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
      noHighFfa: "Tiada stok melebihi had FFA baik",
      finalFfaWithinLimit: (limit: number) =>
        `FFA akhir ≤ ${n(limit, 2)}% (had baik · lebih rendah lebih baik)`,
    },
  },
} as const;

export type Copy = (typeof translations)[Lang];

export function getCopy(lang: Lang): Copy {
  return translations[lang];
}

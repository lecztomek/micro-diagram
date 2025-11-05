import React, { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Widok kolumnowy (bez strzałek):
 * - kol.1: rooty (węzły, które NIGDY nie są targetem)
 * - klik w kol.1 → kol.2: bezpośrednie zależności root’a
 * - klik w kol.2 → kol.3: bezpośrednie zależności wybranego z kol.2
 * - ... i tak dalej (ścieżka wyboru = selections[])
 * - wiersze w kolumnach pokazują label (z wersją) + metryki dla krawędzi z rodzicem (jeśli jest)
 * - filtr po systemName (prod/qa/qa2), ręczne „Odśwież”, brak auto-intervalu
 */

const PROM_URL = "http://192.168.106.118:9090/api/v1/query"; // ⬅️ PODMIEŃ
const PROM_HEADERS: HeadersInit = {
  // Authorization: `Bearer ${TOKEN}`,
};

const WINDOW_OPTIONS = [
  { label: "1m", rps: "1m", err: "1m", p95: "5m" },
  { label: "5m", rps: "5m", err: "5m", p95: "10m" },
  { label: "15m", rps: "15m", err: "15m", p95: "15m" },
] as const;


type EdgeId = string;
type NodeId = string;

type EdgeRaw = {
  execGroup: string;
  execName: string;
  execVer: string;
  tgtGroup: string;
  tgtName: string;
  tgtVer: string;
};

type Graph = {
  nodeIds: NodeId[];
  nodeLabels: Record<NodeId, string>;
  edgesSeen: EdgeId[];
  metricsByEdge: Record<EdgeId, { rps: number; errorRate: number; p95?: number }>;
  rawByEdge: Record<EdgeId, EdgeRaw>;       // ⬅️ NOWE
};


/* --------------------- PromQL builder (z filtrem po systemName) --------------------- */

function buildQueries(env: string, p95Win = "10m") {
  const matcher = `{systemName="${env}"}`;
  const GROUP_BY = "(executableName, executableGroupName, executableVersion, targetServiceName, targetServiceVersion)";

  const Q_TOTAL = `
    sum by ${GROUP_BY} (
      xsp_proxy_request_duration_miliseconds_count${matcher}
    )
  `;

  // 200 lub 204 traktowane jako OK
  const Q_OK = `
    sum by ${GROUP_BY} (
      xsp_proxy_request_duration_miliseconds_count{systemName="${env}",status=~"200|204"}
    )
  `;

  const Q_P95 = `
    histogram_quantile(
      0.95,
      sum by (le, executableName, executableGroupName, executableVersion, targetServiceName, targetServiceVersion) (
        rate(xsp_proxy_request_duration_miliseconds_bucket${matcher}[${p95Win}])
      )
    )
  `;
  return { Q_TOTAL, Q_OK, Q_P95 };
}

// const COLUMN_BORDER = 1;        // masz borderRight: "1px solid ..."
// const CONNECTOR_OVERHANG = 8;   // ile ma wjechać „w tamtą stronę” (px)

// const THICK_MIN = 3;
// const THICK_MAX = 14;

const GRID_GAP = 12;     // taki jak w gridzie kolumn
const COLUMN_PAD = 12;   // taki jak w columnStyle.padding

// function thicknessFromRps(rps: number, relMax: number) {
//   if (!relMax || !isFinite(relMax)) return THICK_MIN;
//   const frac = Math.max(0, Math.min(1, rps / relMax));
//   return Math.round(THICK_MIN + frac * (THICK_MAX - THICK_MIN));
// }

// function relMaxForSiblings(parentId: NodeId | null, adj: Map<NodeId, NodeId[]>, metrics: Graph["metricsByEdge"]) {
//   if (!parentId) return 0;
//   const siblings = Array.from(new Set(adj.get(parentId) ?? []));
//   return siblings.reduce((acc, s) => {
//     const mm = metrics[`${parentId}->${s}`];
//     return Math.max(acc, mm?.rps ?? 0);
//   }, 0);
// }



function getSrcGroup(m: any) {
  return m?.executableGroupName ?? m?.sourceServiceGroupName;
}
function getSrcName(m: any) {
  return m?.executableName ?? m?.sourceServiceName;
}
function getSrcVersion(m: any) {
  return m?.executableVersion ?? m?.sourceServiceVersion;
}


async function promQuery(query: string) {
  const res = await fetch(`${PROM_URL}?query=${encodeURIComponent(query)}`, { headers: PROM_HEADERS });
  if (!res.ok) throw new Error(`Prometheus HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "success") throw new Error(`Prometheus error: ${json.error || "unknown"}`);
  return json.data?.result ?? [];
}

/* --------------------- Normalizacja i identyfikatory --------------------- */

function norm(s?: string) {
  return (s ?? "").trim().toLowerCase();
}

function appendVersion(label: string, verRaw?: string) {
  const ver = (verRaw ?? "").trim();
  return ver ? `${label} (v${ver})` : label;
}

// SOURCE: techniczne ID = 'group::name' (lowercase), label = "group.name (vX)" (lowercase)
function makeSourceId(m: any) {
  const g = norm(getSrcGroup(m));
  const n = norm(getSrcName(m));
  return g ? `${g}::${n}` : n;
}

function normalizeVersion3(raw?: string) {
  const s = (raw ?? "").trim();
  if (!s) return "";
  // wyciągamy tylko liczby, separowane czymkolwiek (., -, _, spacje)
  const parts = s.split(/[^\d]+/).filter(Boolean).map(x => String(parseInt(x, 10)));
  if (parts.length === 0) return "";
  while (parts.length < 3) parts.push("0");     // dopełnij do 3
  return parts.slice(0, 3).join(".");           // utnij do 3
}


function makeSourceLabel(m: any) {
  const g = norm(getSrcGroup(m)); // lowercase
  const n = norm(getSrcName(m));  // lowercase
  const base = g ? `${g}.${n}` : n;
  const ver = normalizeVersion3(getSrcVersion(m));
  return appendVersion(base, ver);
}

const DEFAULT_GROUP = "default";

function makeTargetId(m: any) {
  const g = norm(DEFAULT_GROUP);                // "default"
  const n = norm(m?.targetServiceName);
  return n ? `${g}::${n}` : n;                  // "default::liftams.eventtracking.filetransfer.loops"
}

function makeTargetLabel(m: any) {
  const base = (m?.targetServiceName ?? "").trim();
  return appendVersion(base, (m?.targetServiceVersion ?? "").trim());
}

/* --------------------- Pobranie całego grafu z Prometheusa --------------------- */

async function fetchGraphFromProm(env: string, p95Win = "10m"): Promise<Graph> {
  const { Q_TOTAL, Q_OK, Q_P95 } = buildQueries(env, p95Win);
  const [totalVec, okVec, p95Vec] = await Promise.all([
    promQuery(Q_TOTAL),
    promQuery(Q_OK),
    promQuery(Q_P95).catch(() => []),
  ]);

  const rawByEdge: Record<EdgeId, EdgeRaw> = {};
  const totalMap = new Map<EdgeId, number>();
  const okMap    = new Map<EdgeId, number>();
  const p95Map   = new Map<EdgeId, number>();
  const nodes = new Set<NodeId>();
  const edges = new Set<EdgeId>();
  const nodeLabels: Record<NodeId, string> = {};

  const collect = (vec: any[], sink: Map<EdgeId, number> | null) => {
    for (const s of vec) {
      const metric = s.metric ?? {};
      const srcId = makeSourceId(metric);
      const tgtId = makeTargetId(metric);
      if (!srcId || !tgtId) continue;

      const edgeId = `${srcId}->${tgtId}`;
      edges.add(edgeId); nodes.add(srcId); nodes.add(tgtId);

      if (!nodeLabels[srcId]) nodeLabels[srcId] = makeSourceLabel(metric);
      if (!nodeLabels[tgtId]) nodeLabels[tgtId] = makeTargetLabel(metric);

      // surowe etykiety do późniejszego matchera
      if (!rawByEdge[edgeId]) {
        rawByEdge[edgeId] = {
          execGroup: String(metric.executableGroupName ?? "").trim(),
          execName:  String(metric.executableName ?? "").trim(),
          execVer:   String(metric.executableVersion ?? "").trim(),
          tgtGroup:  String(metric.targetServiceGroupName ?? "").trim(),
          tgtName:   String(metric.targetServiceName ?? "").trim(),
          tgtVer:    String(metric.targetServiceVersion ?? "").trim(),
        };
      }

      if (sink) {
        const prev = sink.get(edgeId) ?? 0;
        const val = Number(s.value?.[1] ?? 0);
        sink.set(edgeId, prev + val); // ⬅️ akumulacja po wielu seriach
      }

    }
  };

  collect(totalVec, totalMap);
  collect(okVec,    okMap);
  collect(p95Vec,   p95Map);

  const metricsByEdge: Graph["metricsByEdge"] = {};
  for (const id of edges) {
    const total = totalMap.get(id) ?? 0;
    const ok    = okMap.get(id);
    // jeśli brakuje serii OK dla tej krawędzi, traktujemy to jak ok=0 (wszystko błędy)
    const okSafe = ok !== undefined ? ok : 0;

    const errs = Math.max(0, total - okSafe);
    const rps  = total / 60;
    const errorRate = total > 0 ? Math.min(1, errs / total) : 0;
    const p95 = p95Map.get(id);

    metricsByEdge[id] = { rps: Math.round(rps), errorRate, ...(p95 !== undefined ? { p95 } : {}) };
  }

  return { nodeIds: Array.from(nodes), nodeLabels, edgesSeen: Array.from(edges), metricsByEdge, rawByEdge };

}

type EdgeDetails = {
  path: string;
  perMin?: number;
  totalErrors: number;
  byStatus: Record<string, number>;
};


async function fetchEdgeErrorDetails(env: string, raw: EdgeRaw, _win: string): Promise<EdgeDetails[]> {
  // najpierw „dokładnie” (z wersjami)
  const exactLabels = {
    systemName: env,
    executableGroupName: raw.execGroup,
    executableName: raw.execName,
    executableVersion: raw.execVer,
    targetServiceGroupName: raw.tgtGroup,
    targetServiceName: raw.tgtName,
    targetServiceVersion: raw.tgtVer,
  };
  const exactNoStatus = buildLabelMatcherExact(exactLabels);
  const exactErrMatcher = exactNoStatus.replace(
    /\}$/,
    `${exactNoStatus.length > 1 ? "," : ""}status!~"200|204"}`
  );

  let vec = await promQuery(`
    sum by (path, status) (
      xsp_proxy_request_duration_miliseconds_count${exactErrMatcher}
    )
  `);

  // jeśli pusto/same zera – fallback bez wersji
  const onlyZeros = (arr: any[]) => (arr ?? []).every(s => Number(s?.value?.[1] ?? 0) === 0);
  if (!vec?.length || onlyZeros(vec)) {
    const relaxedLabels = {
      systemName: env,
      executableGroupName: raw.execGroup,
      executableName: raw.execName,
      targetServiceGroupName: raw.tgtGroup,
      targetServiceName: raw.tgtName,
    };
    const relaxedNoStatus = buildLabelMatcherExact(relaxedLabels);
    const relaxedErrMatcher = relaxedNoStatus.replace(
      /\}$/,
      `${relaxedNoStatus.length > 1 ? "," : ""}status!~"200|204"}`
    );

    vec = await promQuery(`
      sum by (path, status) (
        xsp_proxy_request_duration_miliseconds_count${relaxedErrMatcher}
      )
    `);
  }

  const acc = new Map<string, EdgeDetails>();
  for (const s of vec ?? []) {
    const m = s.metric ?? {};
    const path = String(m.path ?? "").trim() || "(brak path)";
    const status = String(m.status ?? "").trim() || "unknown";
    const val = Number(s.value?.[1] ?? 0);

    const cur = acc.get(path) ?? { path, totalErrors: 0, byStatus: {} };
    cur.totalErrors += val;
    cur.byStatus[status] = (cur.byStatus[status] ?? 0) + val;
    acc.set(path, cur);
  }
  return Array.from(acc.values()).sort((a, b) => b.totalErrors - a.totalErrors);
}




/* --------------------- Pomocnicze: rooty, adjacency, metryki dla par --------------------- */

function computeTargets(edgesSeen: EdgeId[]): Set<NodeId> {
  const targets = new Set<NodeId>();
  for (const e of edgesSeen) {
    const [, t] = e.split("->");
    targets.add(t);
  }
  return targets;
}

function computeRoots(g: Graph): NodeId[] {
  const targets = computeTargets(g.edgesSeen);
  return g.nodeIds.filter((n) => !targets.has(n));
}

function buildAdjacency(g: Graph): Map<NodeId, NodeId[]> {
  const adj = new Map<NodeId, NodeId[]>();
  for (const eid of g.edgesSeen) {
    const [s, t] = eid.split("->");
    if (!adj.has(s)) adj.set(s, []);
    adj.get(s)!.push(t);
  }
  // deduplikacja, sort wg „ważności” (err% desc, rps desc) jeśli mamy metryki dla znanego rodzica
  for (const [s, list] of adj) {
    const unique = Array.from(new Set(list));
    adj.set(s, unique);
  }
  return adj;
}

/* --------------------- UI helpers --------------------- */

function severityColor(errorRate: number): string {
  if (errorRate > 0.1) return "#dc2626"; // czerwony
  if (errorRate > 0.05) return "#f97316"; // pomarańczowy
  if (errorRate > 0.01) return "#eab308"; // żółty
  return "#16a34a"; // zielony
}

const ENV_OPTIONS = ["prod", "qa", "qa2"] as const;
type Env = typeof ENV_OPTIONS[number];

const STRIPE_W = 6; // szerokość pionowej kreski w px

function worstChildErrorRate(
  parent: NodeId,
  adj: Map<NodeId, NodeId[]>,
  metrics: Graph["metricsByEdge"]
): number {
  const children = Array.from(new Set(adj.get(parent) ?? []));
  if (children.length === 0) return 0;
  let maxErr = 0;
  for (const c of children) {
    const m = metrics[`${parent}->${c}`];
    if (m && m.errorRate > maxErr) maxErr = m.errorRate;
  }
  return maxErr;
}

function buildLabelMatcherExact(labels: Record<string, string | undefined>) {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    const vv = (v ?? "").trim();
    if (!vv) continue; // ⬅️ nie wymuszamy label=""
    const esc = vv.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    parts.push(`${k}="${esc}"`);
  }
  return `{${parts.join(",")}}`;
}

function splitEdgeId(eid: EdgeId | null): [NodeId | null, NodeId | null] {
  if (!eid) return [null, null];
  const i = eid.indexOf("->");
  if (i < 0) return [null, null];
  return [eid.slice(0, i), eid.slice(i + 2)];
}

// —— DONUT PROCENTU BŁĘDÓW (CSS conic-gradient) ——
function ErrorDonut({ percent }: { percent: number }) {
  const pct = Math.max(0, Math.min(100, percent));
  const track = "#e5e7eb";   // szary tor
  const fill  = "#dc2626";   // czerwony
  return (
    <div style={{ width: 120, height: 120, position: "relative" }}>
      <div
        style={{
          width: "100%", height: "100%", borderRadius: "50%",
          background: `conic-gradient(${fill} ${pct}%, ${track} 0)`,
        }}
      />
      <div
        style={{
          position: "absolute", inset: 12, background: "#fff", borderRadius: "50%",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: 800, fontSize: 20, color: "#111827"
        }}
      >
        {pct.toFixed(1)}%
      </div>
    </div>
  );
}

// —— POZIOMY PASEK „REL. RPS” (bez danych historycznych) ——
function RelBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ width: "100%", height: 10, background: "#e5e7eb", borderRadius: 999 }}>
      <div style={{ width: `${pct}%`, height: "100%", borderRadius: 999, background: "#0ea5e9" }} />
    </div>
  );
}

// —— LISTA PASKÓW DLA STATUSÓW ——
type StatusAgg = { code: string; perMin?: number; total: number };
function StatusBars({ rows }: { rows: EdgeDetails[] | undefined }) {
  if (!rows || !rows.length) return <div style={{ fontSize: 13, color: "#6b7280" }}>Brak błędów w oknie.</div>;

  // zagnieżdżone sumy po statusach
  const byStatus = new Map<string, StatusAgg>();
  for (const r of rows) {
    for (const [code, cnt] of Object.entries(r.byStatus)) {
      const cur = byStatus.get(code) ?? { code, perMin: 0, total: 0 };
      cur.total += cnt;
      // jeśli mamy perMin na wierszu, rozłóżmy proporcjonalnie po statusach (przybliżenie)
      if (r.perMin !== undefined && r.totalErrors > 0) {
        const frac = cnt / r.totalErrors;
        cur.perMin = (cur.perMin ?? 0) + r.perMin * frac;
      }
      byStatus.set(code, cur);
    }
  }

  const items = Array.from(byStatus.values()).sort((a, b) => b.total - a.total);
  const maxTotal = Math.max(...items.map(i => i.total));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "56px 1fr 64px", gap: 8 }}>
      {items.map(i => {
        const pct = maxTotal > 0 ? Math.min(100, Math.round((i.total / maxTotal) * 100)) : 0;
        return (
          <React.Fragment key={i.code}>
            <div style={{ fontWeight: 600, textAlign: "right", color: "#111827" }}>{i.code}</div>
            <div style={{ alignSelf: "center" }}>
              <div style={{ width: "100%", height: 10, background: "#f3f4f6", borderRadius: 999 }}>
                <div style={{ width: `${pct}%`, height: "100%", background: "#ef4444", borderRadius: 999 }} />
              </div>
            </div>
            <div style={{ textAlign: "right", color: "#111827" }}>
              {i.perMin !== undefined ? (
                <>
                  <div style={{ fontWeight: 600 }}>{Math.round(i.perMin)}/min</div>
                  <div style={{ fontSize: 11, color: "#6b7280" }}>{i.total}</div>
                </>
              ) : (
                <div style={{ fontWeight: 600 }}>{i.total}</div>
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}


/* =========================================================================================
 *  KOMPONENT
 * =======================================================================================*/
export default function MicroservicesColumns() {

  const [detailsEdge, setDetailsEdge] = useState<EdgeId | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [detailsCache, setDetailsCache] = useState<Record<EdgeId, EdgeDetails[]>>({});

  const [env, setEnv] = useState<Env>("prod");
  const [graph, setGraph] = useState<Graph>({
    nodeIds: [],
    nodeLabels: {},
    edgesSeen: [],
    metricsByEdge: {},
    rawByEdge: {},        // ← to było wymagane przez typ Graph
  });

  // selections[i] = id wybranego węzła w kolumnie i (0-based)
  const [selections, setSelections] = useState<NodeId[]>([]);
  const [winIdx, setWinIdx] = useState(1); // domyślnie 5m

  const roots = useMemo(() => computeRoots(graph), [graph]);
  const adj = useMemo(() => buildAdjacency(graph), [graph]);

  useEffect(() => {
    if (!detailsEdge) return;
    if (detailsCache[detailsEdge]) return;

    const raw = graph.rawByEdge[detailsEdge];
    if (!raw) return;

    const win = WINDOW_OPTIONS[winIdx].rps;
    setDetailsLoading(true);
    fetchEdgeErrorDetails(env, raw, win)
      .then((rows) => setDetailsCache((p) => ({ ...p, [detailsEdge]: rows })))
      .catch((e) => console.error("edge details failed", e))
      .finally(() => setDetailsLoading(false));
  }, [detailsEdge, env, graph.rawByEdge, winIdx, detailsCache]);


  useEffect(() => {
    const w = WINDOW_OPTIONS[winIdx];
    fetchGraphFromProm(env, w.p95)
      .then((g) => {
        setGraph(g);
        setSelections([]);
        setDetailsEdge(null);    // wyczyść panel
        setDetailsCache({});     // wyczyść cache
      })
      .catch((e) => { console.error(e); alert("Nie udało się pobrać danych z Prometheusa."); });
  }, [env, winIdx]);

  const refresh = useCallback(async () => {
    try {
      const w = WINDOW_OPTIONS[winIdx];
      const g = await fetchGraphFromProm(env, w.p95);
      setGraph(g);
    } catch (e) {
      console.error(e);
      alert("Nie udało się pobrać danych z Prometheusa.");
    }
  }, [env, winIdx]);


  // oblicz listę kolumn: [roots] + deps(selections[0]) + deps(selections[1]) + ...
  const columns: NodeId[][] = useMemo(() => {
    const result: NodeId[][] = [];
    result.push(roots);

    for (let i = 0; i < selections.length; i++) {
      const parent = selections[i];
      const children = Array.from(new Set(adj.get(parent) ?? []));

      // sort: najpierw problematyczne (errorRate desc), potem RPS desc, potem alfa
      children.sort((a, b) => {
        const ea = graph.metricsByEdge[`${parent}->${a}`]?.errorRate ?? 0;
        const eb = graph.metricsByEdge[`${parent}->${b}`]?.errorRate ?? 0;
        if (eb !== ea) return eb - ea;
        const ra = graph.metricsByEdge[`${parent}->${a}`]?.rps ?? 0;
        const rb = graph.metricsByEdge[`${parent}->${b}`]?.rps ?? 0;
        if (rb !== ra) return rb - ra;
        const la = (graph.nodeLabels[a] ?? a).toLowerCase();
        const lb = (graph.nodeLabels[b] ?? b).toLowerCase();
        return la.localeCompare(lb);
      });

      result.push(children);
    }
    return result;
  }, [roots, adj, selections, graph.metricsByEdge, graph.nodeLabels]);

  // kliknięcie elementu w kolumnie `colIdx`
  const onSelect = (colIdx: number, nodeId: NodeId) => {
    const next = selections.slice(0, colIdx); // ucinamy głębsze wybory
    next[colIdx] = nodeId;
    setSelections(next);
  };

  const columnStyle: React.CSSProperties = {
    minWidth: 260,
    maxWidth: 320,
    height: "calc(90vh - 88px)",
    overflowY: "auto",
    overflowX: "visible",     // ← DODANE: nie przycinaj w poziomie
    position: "relative",     // ← DODANE: dla zIndex potomków
    borderRight: "1px solid #e5e7eb",
    padding: COLUMN_PAD,
    zIndex: 100 
  };


  const itemStyle = (selected: boolean): React.CSSProperties => ({
    position: "relative",            // ⬅️ potrzebne dla paska
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "10px 12px",
    paddingRight: 12 + STRIPE_W,     // ⬅️ żeby treść nie nachodziła na pasek
    borderRadius: 12,
    border: selected ? "2px solid #ef4444" : "1px solid #e5e7eb",
    background: "#fff",
    cursor: "pointer",
    boxShadow: selected ? "0 2px 8px rgba(239,68,68,0.2)" : "0 2px 8px rgba(0,0,0,0.06)",
    marginBottom: 8,
  });

  return (
    <div style={{ width: "100%", height: "100%", background: "#f9fafb" }}>
      {/* Toolbar */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "#f9fafb", padding: 12, display: "flex", gap: 8, alignItems: "center", borderBottom: "1px solid #e5e7eb" }}>
        <label style={{ fontSize: 13, fontWeight: 600 }}>Środowisko:</label>
        <select
          value={env}
          onChange={(e) => setEnv(e.target.value as Env)}
          style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #e5e7eb", background: "#fff", fontSize: 13, cursor: "pointer" }}
          title="Filtruj po systemName"
        >
          {ENV_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>

        <button onClick={refresh} style={{ padding: "8px 14px", borderRadius: 16, background: "#0ea5e9", color: "#fff", border: "none", cursor: "pointer" }}>
          Odśwież
        </button>
        <label style={{ fontSize: 13, fontWeight: 600, marginLeft: 8 }}>Okres:</label>
       
        <select
          value={winIdx}
          onChange={(e) => setWinIdx(Number(e.target.value))}
          style={{ padding: "8px 10px", borderRadius: 12, border: "1px solid #e5e7eb", background: "#fff", fontSize: 13, cursor: "pointer" }}
          title="Okno czasowe dla rate()"
        >
          {WINDOW_OPTIONS.map((w, i) => (
            <option key={w.label} value={i}>{w.label}</option>
          ))}
        </select>


        {selections.length > 0 && (
          <button onClick={() => setSelections([])} style={{ padding: "8px 14px", borderRadius: 16, background: "#111", color: "#fff", border: "none", cursor: "pointer" }}>
            ← Wróć do rootów
          </button>
        )}
      </div>

      {/* Główna część: kolumny + panel szczegółów */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 480px",   // ⬅️ stały panel po prawej
          gap: 12,
          padding: 12,
        }}
      >
        {/* LEWO: Twoje kolumny */}
        <div>
            <div
              style={{
                display: "grid",
                gridAutoFlow: "column",
                gridAutoColumns: "minmax(260px, 320px)",
                gap: GRID_GAP,
                overflow: "visible",      // ← pozwól wychodzić elementom w gap
                position: "relative",     // ← porządek nakładania
              }}
            >

            {columns.map((items, colIdx) => {
              const parent = colIdx === 0 ? null : selections[colIdx - 1];
              const selectedId = selections[colIdx] ?? null;

              return (
                <div key={colIdx} style={columnStyle} className="msd-col">
                  {colIdx === 0 ? (
                    <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", marginBottom: 8, color: "#6b7280" }}>
                      Rooty
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", marginBottom: 8, color: "#6b7280" }}>
                      Zależności {graph.nodeLabels[parent!] ?? parent}
                    </div>
                  )}

                  {items.length === 0 && (
                    <div style={{ fontSize: 13, color: "#6b7280" }}>Brak elementów</div>
                  )}

                  {items.map((id) => {
                    const label = graph.nodeLabels[id] ?? id;
                    const isSelected = selectedId === id;

                    // → kolor paska po prawej
                    let stripeErrRate = 0;

                    // ★ metryki krawędzi + relMax
                    let edgeMetrics: { rps?: number; errorRate?: number } | undefined;
                    // let relMax = 0;

                    if (colIdx === 0) {
                      stripeErrRate = worstChildErrorRate(id, adj, graph.metricsByEdge);
                    } else {
                      const parentId = selections[colIdx - 1];
                      const mEdge = parentId ? graph.metricsByEdge[`${parentId}->${id}`] : undefined;
                      edgeMetrics = mEdge;
                      stripeErrRate = mEdge?.errorRate ?? 0;
                      // relatywne maksimum wśród rodzeństwa tego samego rodzica (potrzebne do grubości kreski)
                      //relMax = relMaxForSiblings(parentId ?? null, adj, graph.metricsByEdge);
                    }

                    const rawErr = Number.isFinite(stripeErrRate) ? stripeErrRate : 0;
                    const safeErr = Math.max(0, rawErr); // bez NaN/ujemnych
                    const stripeColor = severityColor(safeErr);

                    return (
                      <div
                        key={id}
                        style={itemStyle(isSelected)}
                        onClick={() => {
                          onSelect(colIdx, id);
                          if (colIdx >= 1) {
                            const parent = selections[colIdx - 1];
                            if (parent) setDetailsEdge(`${parent}->${id}`);
                          } else {
                            setDetailsEdge(null);
                          }
                        }}
                        title={label}
                      >
                        {/* pionowy pasek błędu */}
                        <div
                          style={{
                            position: "absolute",
                            top: 0,
                            right: 0,
                            width: STRIPE_W,
                            height: "100%",
                            background: stripeColor,
                            borderTopRightRadius: 10,
                            borderBottomRightRadius: 10,
                          }}
                        />

                        {colIdx >= 1 && edgeMetrics?.rps !== undefined && (() => {
                          // długość aż do krawędzi między kolumnami (+ delikatne nadbicie)
                          const CONNECTOR_OVERHANG = 6;   // zwiększ do 10-12, gdybyś chciał „wejść” głębiej
                          const COLUMN_BORDER = 1;        // masz borderRight: "1px solid ..."

                          // liczymy długość *raz* w JS, żeby nie było żadnych subpikseli po stronie CSS
                          const connectorWidthPx =
                            COLUMN_PAD + GRID_GAP + COLUMN_BORDER + CONNECTOR_OVERHANG;

                          // grubość z RPS
                          const relMax = (() => {
                            const parentId = selections[colIdx - 1];
                            if (!parentId) return 0;
                            const siblings = Array.from(new Set(adj.get(parentId) ?? []));
                            return siblings.reduce((acc, s) => {
                              const mm = graph.metricsByEdge[`${parentId}->${s}`];
                              return Math.max(acc, mm?.rps ?? 0);
                            }, 0);
                          })();

                          const thickness = Math.max(3, Math.round(
                            (edgeMetrics.rps! && relMax)
                              ? 3 + (edgeMetrics.rps! / relMax) * (14 - 3)
                              : 3
                          ));

                          return (
                            <div
                              style={{
                                position: "absolute",
                                top: "50%",
                                transform: "translateY(-50%)",
                                // wariant *beton*: jedziemy w lewo od lewej krawędzi boxa,
                                // NIE używamy marginów — wszystko w liczbie pikseli
                                left: -connectorWidthPx,
                                width: connectorWidthPx,
                                height: thickness,
                                background: "#38bdf8",          // niebieski
                                borderRadius: 999,
                                boxShadow: "0 0 0 0.5px rgba(0,0,0,0.04)",
                                zIndex: 999,
                                pointerEvents: "none",
                              }}
                              title={`RPS: ${edgeMetrics.rps}`}
                            />
                          );
                        })()}



                        {/* label */}
                        <div
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            color: "#111827",
                            whiteSpace: "normal",
                            wordBreak: "break-word",
                          }}
                        >
                          {label}
                        </div>
                      </div>
                    );
                  })}

                </div>
              );
            })}
          </div>
        </div>

        {/* PRAWO: PANEL SZCZEGÓŁÓW */}
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", color: "#6b7280", marginBottom: 8 }}>
            Szczegóły połączenia
          </div>

          {(() => {
            const [p, c] = splitEdgeId(detailsEdge);
            const parentLabel = p ? (graph.nodeLabels[p] ?? p) : null;
            const childLabel  = c ? (graph.nodeLabels[c] ?? c) : null;
            const rows = detailsCache[detailsEdge ?? ""];
            const m = detailsEdge ? graph.metricsByEdge[detailsEdge] : undefined;

            let relMax = 0;
            if (p) {
              const siblings = Array.from(new Set(adj.get(p) ?? []));
              relMax = siblings.reduce((acc, s) => {
                const mm = graph.metricsByEdge[`${p}->${s}`];
                return Math.max(acc, mm?.rps ?? 0);
              }, 0);
            }

            return (
              <>
                {/* Nagłówek pary */}
                <div style={{ fontSize: 13, marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, color: "#111827" }}>
                    {parentLabel} <span style={{ color: "#6b7280" }}>→</span> {childLabel}
                  </div>
                  <div style={{ color: "#6b7280" }}>Okno: {WINDOW_OPTIONS[winIdx].rps}</div>
                </div>

                {/* Donut + RPS */}
                <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: 16, alignItems: "center", marginBottom: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <ErrorDonut percent={m ? m.errorRate * 100 : 0} />
                    <div style={{ fontSize: 12, color: "#6b7280", marginLeft: -8 }}>Error rate</div>
                  </div>

                  <div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 6 }}>RPS</div>
                    <div style={{ fontSize: 36, fontWeight: 800, lineHeight: 1, color: "#111827" }}>
                      {m ? m.rps : 0}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                      <div style={{ fontSize: 12, color: "#6b7280", width: 64 }}>rel. RPS</div>
                      <RelBar value={m?.rps ?? 0} max={relMax} />
                    </div>
                  </div>
                </div>

                <hr style={{ border: 0, borderTop: "1px solid #e5e7eb", margin: "8px 0 16px" }} />

                {/* Błędy wg statusu */}
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>Błędy wg statusu</div>
                {detailsLoading && <div>Ładowanie danych…</div>}
                {!detailsLoading && <StatusBars rows={rows} />}

                <hr style={{ border: 0, borderTop: "1px solid #e5e7eb", margin: "16px 0" }} />

                {/* NAJGORSZE ŚCIEŻKI (PATH) */}
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>Najgorsze ścieżki (URL)</div>

                {(!rows || rows.length === 0) && (
                  <div style={{ fontSize: 13, color: "#6b7280" }}>Brak danych o ścieżkach.</div>
                )}

                {rows && rows.length > 0 && (
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 96px 1fr", columnGap: 8, rowGap: 8 }}>
                    <div style={{ fontWeight: 600 }}>Path</div>
                    <div style={{ fontWeight: 600, textAlign: "right" }}>Błędy</div>
                    <div style={{ fontWeight: 600, textAlign: "right" }}>Statusy</div>

                    {rows.slice(0, 200).map((r) => (
                      <React.Fragment key={r.path}>
                        {/* PATH — zawijany */}
                        <div
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            wordBreak: "break-word",
                            lineHeight: 1.3,
                            color: "#111827"
                          }}
                          title={r.path}
                        >
                          {r.path}
                        </div>

                        {/* LICZBA BŁĘDÓW */}
                        <div style={{ textAlign: "right", color: "#111827" }}>
                          {r.perMin !== undefined ? (
                            <>
                              {Math.round(r.perMin)} /min
                              <div style={{ fontSize: 11, color: "#6b7280" }}>
                                ≈ {r.totalErrors} w {WINDOW_OPTIONS[winIdx].err}
                              </div>
                            </>
                          ) : (
                            r.totalErrors
                          )}
                        </div>

                        {/* STATUSY — badge'e */}
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
                          {Object.entries(r.byStatus)
                            .sort((a, b) => b[1] - a[1])
                            .map(([st, cnt]) => (
                              <span
                                key={st}
                                style={{
                                  display: "inline-block",
                                  padding: "2px 6px",
                                  borderRadius: 8,
                                  border: "1px solid #e5e7eb",
                                  fontSize: 11,
                                  color: "#111827"
                                }}
                                title={`status ${st}: ${cnt}`}
                              >
                                {st}: {cnt}
                              </span>
                            ))}
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>


      </div>
    </div>
  );
}

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

type Graph = {
  nodeIds: NodeId[];
  nodeLabels: Record<NodeId, string>;                // id → label (z wersją)
  edgesSeen: EdgeId[];                                // "sourceId->targetId"
  metricsByEdge: Record<EdgeId, { rps: number; errorRate: number; p95?: number }>;
};

/* --------------------- PromQL builder (z filtrem po systemName) --------------------- */

function buildQueries(env: string, p95Win = "10m") {
  const matcher = `{systemName="${env}"}`;
  const GROUP_BY = "(executableName, executableGroupName, executableVersion, targetServiceName, targetServiceVersion)";

  // Wszystkie wywołania w "ostatniej minucie" (Twoja metryka już tak raportuje)
  const Q_TOTAL = `
    sum by ${GROUP_BY} (
      xsp_proxy_request_duration_miliseconds_count${matcher}
    )
  `;

  // Tylko sukcesy (HTTP 200) w "ostatniej minucie"
  const Q_OK = `
    sum by ${GROUP_BY} (
      xsp_proxy_request_duration_miliseconds_count{systemName="${env}",status="200"}
    )
  `;

  // p95 – jak wcześniej
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

  const totalMap = new Map<EdgeId, number>();
  const okMap    = new Map<EdgeId, number>();
  const p95Map   = new Map<EdgeId, number>();
  const nodes = new Set<NodeId>();
  const edges = new Set<EdgeId>();
  const nodeLabels: Record<NodeId, string> = {};

  const collect = (vec: any[], sink: Map<EdgeId, number> | null) => {
    for (const s of vec) {
      const m = s.metric ?? {};
      const srcId = makeSourceId(m);
      const tgtId = makeTargetId(m);
      if (!srcId || !tgtId) continue;

      const edgeId = `${srcId}->${tgtId}`;
      edges.add(edgeId); nodes.add(srcId); nodes.add(tgtId);
      if (!nodeLabels[srcId]) nodeLabels[srcId] = makeSourceLabel(m);
      if (!nodeLabels[tgtId]) nodeLabels[tgtId] = makeTargetLabel(m);

      if (sink) sink.set(edgeId, Number(s.value?.[1] ?? 0)); // calls in last minute
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

  return { nodeIds: Array.from(nodes), nodeLabels, edgesSeen: Array.from(edges), metricsByEdge };
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

function edgeKey(parent: NodeId | null, child: NodeId): EdgeId | null {
  return parent ? `${parent}->${child}` : null;
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


/* =========================================================================================
 *  KOMPONENT
 * =======================================================================================*/
export default function MicroservicesColumns() {
  const [env, setEnv] = useState<Env>("prod");
  const [graph, setGraph] = useState<Graph>({ nodeIds: [], nodeLabels: {}, edgesSeen: [], metricsByEdge: {} });

  // selections[i] = id wybranego węzła w kolumnie i (0-based)
  const [selections, setSelections] = useState<NodeId[]>([]);
  const [winIdx, setWinIdx] = useState(1); // domyślnie 5m

  const roots = useMemo(() => computeRoots(graph), [graph]);
  const adj = useMemo(() => buildAdjacency(graph), [graph]);

  useEffect(() => {
    const w = WINDOW_OPTIONS[winIdx];
    fetchGraphFromProm(env, w.p95)
      .then((g) => { setGraph(g); setSelections([]); })
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

  // styl kolumny i elementu
  const columnStyle: React.CSSProperties = {
    minWidth: 260,
    maxWidth: 320,
    height: "calc(90vh - 88px)",
    overflowY: "auto",
    borderRight: "1px solid #e5e7eb",
    padding: 12,
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


  // render metryk dla pary (rodzic → element)
  function MetricsLine({ parent, child }: { parent: NodeId | null; child: NodeId }) {
    const key = edgeKey(parent, child);
    if (!key) return null;
    const m = graph.metricsByEdge[key];
    if (!m) return null;

    const color = severityColor(m.errorRate);
    const err = (m.errorRate * 100).toFixed(1);
    const rps = m.rps;
    const p95 = m.p95 !== undefined ? ` • p95=${m.p95.toFixed(0)}ms` : "";
    return (
      <div style={{ fontSize: 12, color: "#374151" }}>
        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 6, background: color, marginRight: 6 }} />
        {err}% • {rps} rps{p95}
      </div>
    );
  }

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

      {/* Kolumny */}
      <div style={{ display: "grid", gridAutoFlow: "column", gridAutoColumns: "minmax(260px, 320px)", gap: 12, padding: 12 }}>
        {columns.map((items, colIdx) => {
          const parent = colIdx === 0 ? null : selections[colIdx - 1];
          const selectedId = selections[colIdx] ?? null;

          return (
            <div key={colIdx} style={columnStyle}>
              {colIdx === 0 ? (
                <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", marginBottom: 8, color: "#6b7280" }}>Rooty</div>
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

                // czy ma dzieci → licz max error i kolor paska
                const hasChildren = (adj.get(id)?.length ?? 0) > 0;
                const stripeColor = hasChildren
                  ? severityColor(worstChildErrorRate(id, adj, graph.metricsByEdge))
                  : null;

                return (
                  <div
                    key={id}
                    style={itemStyle(isSelected)}
                    onClick={() => onSelect(colIdx, id)}
                    title={label}
                  >
                    {/* pasek po prawej, przez całą wysokość kafelka */}
                    {stripeColor && (
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
                    )}

                    <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", whiteSpace: "normal", wordBreak: "break-word" }}>
                      {label}
                    </div>
                    <MetricsLine parent={colIdx === 0 ? null : selections[colIdx - 1]} child={id} />
                  </div>
                );
              })}

            </div>
          );
        })}
      </div>
    </div>
  );
}

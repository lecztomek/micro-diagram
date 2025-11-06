import { useEffect, useMemo, useState } from "react";
import { type ServiceNode } from "./MicroserviceDependencyNavigator";
import MicroserviceNavigatorWithTabs from "./MicroserviceNavigatorWithTabs";

/**
 * PrometheusBackedNavigator
 *
 * Adapter, który przenosi całą logikę pobierania i normalizacji danych z Prometheusa
 * (ze starego komponentu) do nowego widoku kolumnowego MicroserviceDependencyNavigator.
 *
 * – Używa tych samych zapytań (TOTAL/OK/P95) oraz identycznej normalizacji ID/etykiet
 * – Buduje drzewo ServiceNode[] (roots -> children ...) na podstawie grafu krawędzi
 * – Mapuje errorRate na status (healthy/degraded/down) i RPS na rpm
 * – Ma prosty toolbar: środowisko, okno czasowe, odśwież
 */

/* ================================ KONFIG ================================ */
const PROM_URL = "http://192.168.106.118:9090/api/v1/query"; // ⬅️ PODMIEŃ
const PROM_HEADERS: HeadersInit = {
  // Authorization: `Bearer ${TOKEN}`,
};

const ENV_OPTIONS = ["prod", "qa", "qa2"] as const;
const WINDOW_OPTIONS = [
  { label: "1m", rps: "1m", err: "1m", p95: "5m" },
  { label: "5m", rps: "5m", err: "5m", p95: "10m" },
  { label: "15m", rps: "15m", err: "15m", p95: "15m" },
] as const;

/* ================================ TYPY ================================ */

type EdgeId = string;
type NodeId = string;

interface EdgeRaw {
  execGroup: string;
  execName: string;
  execVer: string;
  tgtGroup: string;
  tgtName: string;
  tgtVer: string;
}

interface Graph {
  nodeIds: NodeId[];
  nodeLabels: Record<NodeId, string>;
  edgesSeen: EdgeId[];
  metricsByEdge: Record<EdgeId, { rps: number; errorRate: number; p95?: number }>;
  rawByEdge: Record<EdgeId, EdgeRaw>;
}

/* ============================ HELPERY PROM ============================ */

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

async function promQuery(query: string) {
  const res = await fetch(`${PROM_URL}?query=${encodeURIComponent(query)}`, { headers: PROM_HEADERS });
  if (!res.ok) throw new Error(`Prometheus HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "success") throw new Error(`Prometheus error: ${json.error || "unknown"}`);
  return json.data?.result ?? [];
}

/* =============================== NORMALIZACJA =============================== */

function norm(s?: string) {
  return (s ?? "").trim().toLowerCase();
}

function appendVersion(label: string, verRaw?: string) {
  const ver = (verRaw ?? "").trim();
  return ver ? `${label} (v${ver})` : label;
}

function getSrcGroup(m: any) { return m?.executableGroupName ?? m?.sourceServiceGroupName; }
function getSrcName(m: any) { return m?.executableName ?? m?.sourceServiceName; }
function getSrcVersion(m: any) { return m?.executableVersion ?? m?.sourceServiceVersion; }

function makeSourceId(m: any) {
  const g = norm(getSrcGroup(m));
  const n = norm(getSrcName(m));
  return g ? `${g}::${n}` : n;
}

function normalizeVersion3(raw?: string) {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const parts = s.split(/[^\d]+/).filter(Boolean).map(x => String(parseInt(x, 10)));
  if (parts.length === 0) return "";
  while (parts.length < 3) parts.push("0");
  return parts.slice(0, 3).join(".");
}

function makeSourceLabel(m: any) {
  const g = norm(getSrcGroup(m));
  const n = norm(getSrcName(m));
  const base = g ? `${g}.${n}` : n;
  const ver = normalizeVersion3(getSrcVersion(m));
  return appendVersion(base, ver);
}

const DEFAULT_GROUP = "default";
function makeTargetId(m: any) {
  const g = norm(DEFAULT_GROUP);
  const n = norm(m?.targetServiceName);
  return n ? `${g}::${n}` : n;
}
function makeTargetLabel(m: any) {
  const base = (m?.targetServiceName ?? "").trim();
  return appendVersion(base, (m?.targetServiceVersion ?? "").trim());
}


/* ============================ POBRANIE GRAFU ============================ */

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
        sink.set(edgeId, prev + val);
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
    const okSafe = ok !== undefined ? ok : 0;

    const errs = Math.max(0, total - okSafe);
    const rps  = total / 60;
    const errorRate = total > 0 ? Math.min(1, errs / total) : 0;
    const p95 = p95Map.get(id);

    metricsByEdge[id] = { rps: Math.round(rps), errorRate, ...(p95 !== undefined ? { p95 } : {}) };
  }

  return { nodeIds: Array.from(nodes), nodeLabels, edgesSeen: Array.from(edges), metricsByEdge, rawByEdge };
}

/* ============================== BUDOWANIE DRZEWA ============================== */

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
  for (const [s, list] of adj) {
    const unique = Array.from(new Set(list));
    adj.set(s, unique);
  }
  return adj;
}

function worstChildErrorRate(parent: NodeId, adj: Map<NodeId, NodeId[]>, metrics: Graph["metricsByEdge"]) {
  const children = Array.from(new Set(adj.get(parent) ?? []));
  if (children.length === 0) return 0;
  let maxErr = 0;
  for (const c of children) {
    const m = metrics[`${parent}->${c}`];
    if (m && m.errorRate > maxErr) maxErr = m.errorRate;
  }
  return maxErr;
}

function errorRateToStatus(err: number): ServiceNode["status"] {
  if (err > 0.1) return "down";
  if (err > 0.02) return "degraded";
  return "healthy";
}

function buildTree(g: Graph): ServiceNode[] {
  const adj = buildAdjacency(g);
  const roots = computeRoots(g);

  const memo = new Map<NodeId, ServiceNode>();

  const buildNode = (id: NodeId, parentId?: NodeId): ServiceNode => {
    if (memo.has(id)) return memo.get(id)!;

    // nazwa węzła
    const name = g.nodeLabels[id] ?? id;

    // status z najgorszego dziecka (dla rootów i "targetów bez dzieci" będzie healthy)
    const worstErr = worstChildErrorRate(id, adj, g.metricsByEdge);
    let status: ServiceNode["status"] = errorRateToStatus(worstErr);

    // rpm – jeśli ma rodzica, bierzemy metrykę krawędzi parent->id; dla rootów zostaw 0
    let rpm = 0;
    if (parentId) {
      rpm = g.metricsByEdge[`${parentId}->${id}`]?.rps ?? 0;
    }

    const node: ServiceNode = { id, name, status, rpm, children: [] };
    memo.set(id, node);

    const kids = Array.from(new Set(adj.get(id) ?? []));

    // sort: problematyczne (errorRate desc), potem rpm desc, potem alfa
    kids.sort((a, b) => {
      const ea = g.metricsByEdge[`${id}->${a}`]?.errorRate ?? 0;
      const eb = g.metricsByEdge[`${id}->${b}`]?.errorRate ?? 0;
      if (eb !== ea) return eb - ea;
      const ra = g.metricsByEdge[`${id}->${a}`]?.rps ?? 0;
      const rb = g.metricsByEdge[`${id}->${b}`]?.rps ?? 0;
      if (rb !== ra) return rb - ra;
      const la = (g.nodeLabels[a] ?? a).toLowerCase();
      const lb = (g.nodeLabels[b] ?? b).toLowerCase();
      return la.localeCompare(lb);
    });

    node.children = kids.map((kid) => buildNode(kid, id));
    return node;
  };

  return roots.map((r) => buildNode(r));
}

/* ================================ UI ADAPTER ================================ */

export default function PrometheusBackedNavigator() {
  const [env, setEnv] = useState<(typeof ENV_OPTIONS)[number]>("prod");
  const [winIdx, setWinIdx] = useState(1); // 5m
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);

  
  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const w = WINDOW_OPTIONS[winIdx];
      const g = await fetchGraphFromProm(env, w.p95);
      setGraph(g);
    } catch (e: any) {
      console.error(e);
      setError(e?.message ?? "Nie udało się pobrać danych z Prometheusa.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // auto-load przy pierwszym renderze + na zmianę env/okna
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, winIdx]);

  const roots: ServiceNode[] = useMemo(() => (graph ? buildTree(graph) : []), [graph]);
  

  return (
    <div className="w-full">
      {/* Toolbar */}
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-black/5 bg-white/80 backdrop-blur px-3 py-2">
        <label className="text-xs font-semibold text-neutral-600">Środowisko</label>
        <select
          value={env}
          onChange={(e) => setEnv(e.target.value as any)}
          className="rounded-xl border border-black/10 bg-white px-3 py-1.5 text-sm"
          title="Filtruj po systemName"
        >
          {ENV_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>

        <label className="ml-2 text-xs font-semibold text-neutral-600">Okres</label>
        <select
          value={winIdx}
          onChange={(e) => setWinIdx(Number(e.target.value))}
          className="rounded-xl border border-black/10 bg-white px-3 py-1.5 text-sm"
          title="Okno czasowe dla rate()"
        >
          {WINDOW_OPTIONS.map((w, i) => (
            <option key={w.label} value={i}>{w.label}</option>
          ))}
        </select>

        <button
          onClick={refresh}
          className="ml-2 rounded-xl bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Odśwież
        </button>

        <div className="ml-auto text-xs text-neutral-500">
          {loading ? "Ładowanie…" : graph ? `${graph.nodeIds.length} węzłów / ${graph.edgesSeen.length} krawędzi` : "—"}
        </div>
      </div>

      {/* Treść */}
      {error && (
        <div className="m-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

<div className="p-3">
  <MicroserviceNavigatorWithTabs
    data={roots}
    depth={3}          // grupowanie do 3. członu, np. a.b.c.d -> a.b.c
    maxColumns={6}
    showAllTab         // (opcjonalnie) doda tab zbiorczy "(Wszystkie)"
    onSelect={(node) => {
      console.debug("select:", node);
    }}
    renderNode={(node, isActive) => {
      const color =
        node.status === "down" ? "bg-red-500" :
        node.status === "degraded" ? "bg-amber-500" :
        "bg-emerald-500";
      return (
        <div className={`group relative flex rounded-2xl shadow-sm hover:shadow transition-all cursor-pointer overflow-hidden ${isActive ? "ring-2 ring-indigo-500" : "ring-1 ring-black/5"}`}>
          <span className={`${color} absolute inset-y-0 left-0 w-2`} aria-hidden="true" />
          <div className="flex w-full items-center gap-3 p-3 pl-5">
            <div className="truncate font-medium" title={node.name}>{node.name}</div>
          </div>
        </div>
      );
    }}
  />
</div>

    </div>
  );
}

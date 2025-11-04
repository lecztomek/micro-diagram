import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useEdgesState,
  useNodesState,
  Position,
} from "reactflow";
import "reactflow/dist/style.css";

/**
 * Mikroserwisy z Prometheusa — ręczne odświeżanie + wybór środowiska (systemName).
 * - Filtrujemy wyłącznie serie z systemName = wybrana wartość (prod/qa/qa2).
 * - Brak auto-odświeżania w interwale.
 */

const STORAGE_KEY = "microservices-layout-v1";

/* === KONFIG PROMETHEUSA === */
const PROM_URL = "http://192.168.106.118:9090/api/v1/query"; // ⬅️ PODMIEŃ
const PROM_HEADERS: HeadersInit = {
  // Authorization: `Bearer ${TOKEN}`, // ⬅️ jeśli potrzebujesz
};

/* === Wygląd krawędzi === */
function edgeColor(errorRate: number) {
  if (errorRate > 0.1) return "#dc2626";
  if (errorRate > 0.05) return "#f97316";
  if (errorRate > 0.01) return "#eab308";
  return "#16a34a";
}
function edgeWidth(rps: number) {
  return 0.75 + Math.log10(Math.max(1, rps)) * 1.3;
}

/* === Normalizacja/ID/etykiety === */
function norm(s?: string) {
  return (s ?? "").trim().toLowerCase();
}
function appendVersion(label: string, verRaw?: string) {
  const ver = (verRaw ?? "").trim();
  return ver ? `${label} (v${ver})` : label;
}

// ID źródła: separator '::' (żeby kropka w nazwie nie była separatorem)
function makeSourceId(m: any) {
  const g = norm(m?.sourceServiceGroupName);
  const n = norm(m?.sourceServiceName);
  return g ? `${g}::${n}` : n;
}
// Label źródła: ładnie z kropką + wersja
function makeSourceLabel(m: any) {
  const gRaw = (m?.sourceServiceGroupName ?? "").trim();
  const nRaw = (m?.sourceServiceName ?? "").trim();
  const base = gRaw ? `${gRaw}.${nRaw}` : nRaw;
  return appendVersion(base, (m?.sourceServiceVersion ?? "").trim());
}

// Target ID/LABEL — jak w danych (ID bez lowercasa, label + wersja)
function makeTargetId(m: any) {
  return (m?.targetServiceName ?? "").trim();
}
function makeTargetLabel(m: any) {
  const base = (m?.targetServiceName ?? "").trim();
  return appendVersion(base, (m?.targetServiceVersion ?? "").trim());
}

// Edge ID łączymy po '->' na bazie ID (techniczny, stabilny)
function makeEdgeId(m: any) {
  return `${makeSourceId(m)}->${makeTargetId(m)}`;
}

/* === Typy === */
type EdgeId = string;
type NodeId = string;
type Metrics = Record<EdgeId, { rps: number; errorRate: number; p95?: number }>;
type Graph = {
  nodeIds: NodeId[];
  nodeLabels: Record<NodeId, string>;
  metricsByEdge: Metrics;
  edgesSeen: EdgeId[];
};

/* === Budowa zapytań PromQL z filtrem systemName === */
function buildQueries(env: string) {
  const matcher = `{systemName="${env}"}`;
  // Count/RPS
  const Q_RPS = `
    sum by (sourceServiceName, sourceServiceGroupName, targetServiceName) (
      rate(xsp_proxy_request_duration_miliseconds_count${matcher}[1m])
    )
  `;
  // Errors 5xx
  const Q_ERR = `
    sum by (sourceServiceName, sourceServiceGroupName, targetServiceName) (
      rate(xsp_proxy_request_duration_miliseconds_count${matcher}{status=~"5.."}[1m])
    )
  `.replace(`${matcher}{`, `{systemName="${env}",`); // wstawiamy systemName razem z innymi matcherami

  // P95 z histogramu
  const Q_P95 = `
    histogram_quantile(
      0.95,
      sum by (le, sourceServiceName, sourceServiceGroupName, targetServiceName) (
        rate(xsp_proxy_request_duration_miliseconds_bucket${matcher}[5m])
      )
    )
  `;
  return { Q_RPS, Q_ERR, Q_P95 };
}

/* === Prometheus fetch === */
async function promQuery(query: string) {
  const res = await fetch(`${PROM_URL}?query=${encodeURIComponent(query)}`, { headers: PROM_HEADERS });
  if (!res.ok) throw new Error(`Prometheus HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "success") throw new Error(`Prometheus error: ${json.error || "unknown"}`);
  return json.data?.result ?? [];
}

async function fetchGraphFromProm(env: string): Promise<Graph> {
  const { Q_RPS, Q_ERR, Q_P95 } = buildQueries(env);

  const [rpsVec, errVec, p95Vec] = await Promise.all([
    promQuery(Q_RPS),
    promQuery(Q_ERR),
    promQuery(Q_P95).catch(() => []), // p95 opcjonalne
  ]);

  const rpsMap = new Map<EdgeId, number>();
  const errMap = new Map<EdgeId, number>();
  const p95Map = new Map<EdgeId, number>();
  const nodes = new Set<NodeId>();
  const edges = new Set<EdgeId>();
  const nodeLabels: Record<NodeId, string> = {};

  const collect = (vec: any[], sink: Map<EdgeId, number> | null) => {
    for (const s of vec) {
      const metric = s.metric ?? {};
      const edgeId = makeEdgeId(metric);
      const srcId = makeSourceId(metric);
      const tgtId = makeTargetId(metric);
      if (!srcId || !tgtId) continue;

      edges.add(edgeId);
      nodes.add(srcId);
      nodes.add(tgtId);

      if (!nodeLabels[srcId]) nodeLabels[srcId] = makeSourceLabel(metric);
      if (!nodeLabels[tgtId]) nodeLabels[tgtId] = makeTargetLabel(metric);

      if (sink) sink.set(edgeId, Number(s.value?.[1] ?? 0));
    }
  };

  collect(rpsVec, rpsMap);
  collect(errVec, errMap);
  collect(p95Vec, p95Map);

  const metricsByEdge: Metrics = {};
  for (const id of edges) {
    const rps = rpsMap.get(id) ?? 0;
    const errs = errMap.get(id) ?? 0;
    const errorRate = rps > 0 ? Math.min(0.4, errs / rps) : 0;
    const p95 = p95Map.get(id);
    metricsByEdge[id] = { rps: Math.round(rps), errorRate, ...(p95 !== undefined ? { p95 } : {}) };
  }

  return {
    nodeIds: Array.from(nodes),
    nodeLabels,
    metricsByEdge,
    edgesSeen: Array.from(edges),
  };
}

/* === Auto-layout dla nowych węzłów (siatka) === */
const GRID: [number, number] = [20, 20];
function autoPositionFor(index: number): { x: number; y: number } {
  const colWidth = 260;
  const rowHeight = 140;
  const col = index % 5;
  const row = Math.floor(index / 5);
  return { x: 80 + col * colWidth, y: 60 + row * rowHeight };
}

/* === Komponent === */
const ENV_OPTIONS = ["prod", "qa", "qa2"] as const;
type Env = typeof ENV_OPTIONS[number];

export default function MicroservicesDiagram() {
  const [env, setEnv] = useState<Env>("prod");
  const [graph, setGraph] = useState<Graph>({ nodeIds: [], nodeLabels: {}, metricsByEdge: {}, edgesSeen: [] });

  // Fallback input (import/eksport layoutu z pliku)
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Wczytaj zapisany układ przy starcie
  const savedLayout = useMemo(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as Record<string, { x: number; y: number }>;
    } catch {
      return null;
    }
  }, []);

  // Pierwszy fetch (dla domyślnego env)
  useEffect(() => {
    fetchGraphFromProm(env)
      .then(setGraph)
      .catch((e) => console.error("Prometheus fetch failed", e));
  }, []); // tylko raz na starcie

  // Fetch po zmianie środowiska (to Twoja akcja, nie auto-refresh w tle)
  useEffect(() => {
    // pomijamy pierwsze wywołanie z hooka powyżej — ale jeśli zostawimy,
    // to i tak zadziała poprawnie (dwa fetch-e dla 'prod' nie zrobią problemu).
    fetchGraphFromProm(env)
      .then(setGraph)
      .catch((e) => {
        console.error("Prometheus fetch failed", e);
        alert("Nie udało się pobrać danych z Prometheusa dla wybranego środowiska.");
      });
  }, [env]);

  // Ręczne odświeżanie (przycisk)
  const refreshGraph = useCallback(async () => {
    try {
      const g = await fetchGraphFromProm(env);
      setGraph(g);
    } catch (e) {
      console.error("Prometheus fetch failed", e);
      alert("Nie udało się pobrać danych z Prometheusa.");
    }
  }, [env]);

  // Budowa NODES (z etykietami + layout). Zawijanie/nadawanie szerokości.
  const initialNodes = useMemo(() => {
    return graph.nodeIds.map((nodeId, idx) => {
      const pos = savedLayout?.[nodeId] ?? autoPositionFor(idx);
      const label = graph.nodeLabels?.[nodeId] ?? nodeId;

      return {
        id: nodeId,
        type: "default",
        data: { label },
        position: pos,
        draggable: true,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          padding: "10px 12px",
          borderRadius: 12,
          border: "1px solid #e5e7eb",
          boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
          background: "white",
          fontSize: 13,
          fontWeight: 600,
          maxWidth: 240,
          width: "auto",
          whiteSpace: "normal",
          wordBreak: "break-word",
        } as React.CSSProperties,
      };
    });
  }, [graph.nodeIds, graph.nodeLabels, savedLayout]);

  // Budowa EDGES (z metrykami)
  const initialEdges = useMemo(() => {
    return graph.edgesSeen.map((edgeId) => {
      const [sourceId, targetId] = edgeId.split("->");
      const m = graph.metricsByEdge[edgeId] ?? { rps: 0, errorRate: 0 as number, p95: undefined as number | undefined };
      const labelCore = `${(m.errorRate * 100).toFixed(1)}% • ${m.rps} rps`;
      const label = m.p95 !== undefined ? `${labelCore} • p95=${m.p95.toFixed(0)}ms` : labelCore;

      return {
        id: edgeId,
        source: sourceId,
        target: targetId,
        type: "smoothstep",
        label,
        animated: m.errorRate > 0.05,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: { stroke: edgeColor(m.errorRate), strokeWidth: edgeWidth(m.rps) },
        labelStyle: { fontWeight: 700, fontSize: 11, fill: "#111827" },
        labelBgPadding: [3, 1],
        labelBgBorderRadius: 6,
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.85 },
      } as any;
    });
  }, [graph.edgesSeen, graph.metricsByEdge]);

  // Stany React Flow
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Podmiana struktury przy zmianie grafu (po zmianie env lub po odświeżeniu)
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Aktualizacja etykiet/stylów krawędzi przy zmianie metryk
  useEffect(() => {
    setEdges((eds) =>
      eds.map((e) => {
        const m = graph.metricsByEdge[e.id];
        if (!m) return e;
        const labelCore = `${(m.errorRate * 100).toFixed(1)}% • ${m.rps} rps`;
        const label = m.p95 !== undefined ? `${labelCore} • p95=${m.p95.toFixed(0)}ms` : labelCore;
        return {
          ...e,
          label,
          animated: m.errorRate > 0.05,
          style: { ...(e.style || {}), stroke: edgeColor(m.errorRate), strokeWidth: edgeWidth(m.rps) },
        };
      })
    );
  }, [graph.metricsByEdge, setEdges]);

  /* === Zapis/odczyt layoutu === */
  const supportsFS = () =>
    typeof window !== "undefined" &&
    // @ts-ignore
    !!(window.showOpenFilePicker && window.showSaveFilePicker);

  async function loadLayoutViaPicker() {
    // @ts-ignore
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Layout JSON", accept: { "application/json": [".json"] } }],
      multiple: false,
    });
    const file = await handle.getFile();
    const text = await file.text();
    return JSON.parse(text) as Record<string, { x: number; y: number }>;
  }

  async function saveLayoutViaPicker(layout: Record<string, { x: number; y: number }>) {
    // @ts-ignore
    const handle = await window.showSaveFilePicker({
      suggestedName: "microservices-layout.json",
      types: [{ description: "Layout JSON", accept: { "application/json": [".json"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" }));
    await writable.close();
  }

  function downloadFallback(layout: Record<string, { x: number; y: number }>) {
    const blob = new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "microservices-layout.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const extractLayout = useCallback(() => {
    const layout: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) layout[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    return layout;
  }, [nodes]);

  const saveLayoutLocal = useCallback(() => {
    const layout = extractLayout();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  }, [extractLayout]);

  const applyLayout = useCallback(
    (layout: Record<string, { x: number; y: number }>) => {
      if (!layout) return;
      setNodes((nds) =>
        nds.map((n) => ({
          ...n,
          position: layout[n.id] ?? n.position,
        }))
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    },
    [setNodes]
  );

  const resetLayout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setNodes((nds) =>
      nds.map((n, idx) => ({
        ...n,
        position: autoPositionFor(idx),
      }))
    );
  }, [setNodes]);

  const saveLayoutToDisk = useCallback(async () => {
    const layout = extractLayout();
    try {
      if (supportsFS()) {
        await saveLayoutViaPicker(layout);
      } else {
        downloadFallback(layout);
      }
    } catch (e) {
      console.error("save to disk error", e);
      alert("Nie udało się zapisać pliku.");
    }
  }, [extractLayout]);

  const loadLayoutFromDisk = useCallback(async () => {
    try {
      if (supportsFS()) {
        const layout = await loadLayoutViaPicker();
        applyLayout(layout);
      } else {
        fileInputRef.current?.click();
      }
    } catch (e) {
      console.error("load from disk error", e);
      alert("Nie udało się wczytać pliku.");
    }
  }, [applyLayout]);

  const onFilePicked = useCallback(
    async (ev: React.ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const layout = JSON.parse(text) as Record<string, { x: number; y: number }>;
        applyLayout(layout);
      } catch (e) {
        console.error("parse layout error", e);
        alert("Błędny plik layoutu.");
      } finally {
        ev.target.value = "";
      }
    },
    [applyLayout]
  );

  /* === UI === */
  const Legend = () => (
    <div
      style={{
        position: "fixed",
        right: 16,
        top: 16,
        zIndex: 50,
        background: "rgba(255,255,255,0.9)",
        backdropFilter: "blur(4px)",
        borderRadius: 16,
        boxShadow: "0 6px 20px rgba(0,0,0,0.08)",
        padding: 12,
        fontSize: 13,
        lineHeight: 1.3,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Legenda</div>
      <div>
        <div>Kolor krawędzi = error rate</div>
        <div>Grubość krawędzi = RPS</div>
        <div>Przeciągnij węzeł, aby zmienić układ</div>
        <div>Siatka 20×20 (snap)</div>
      </div>
    </div>
  );

  const Toolbar = () => (
    <div style={{ position: "fixed", left: 16, top: 16, zIndex: 50, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <label style={{ fontSize: 13, fontWeight: 600, marginRight: 4 }}>Środowisko:</label>
      <select
        value={env}
        onChange={(e) => setEnv(e.target.value as Env)}
        style={{
          padding: "8px 10px",
          borderRadius: 12,
          border: "1px solid #e5e7eb",
          background: "#fff",
          fontSize: 13,
          cursor: "pointer",
        }}
        title="Filtruj po systemName"
      >
        {ENV_OPTIONS.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>

      <button
        onClick={refreshGraph}
        style={{ padding: "8px 14px", borderRadius: 16, background: "#0ea5e9", color: "#fff", border: "none", cursor: "pointer", marginLeft: 8 }}
        title="Pobierz metryki z Prometheusa (ręcznie)"
      >
        Odśwież
      </button>

      <div style={{ width: 1, height: 24, background: "#d1d5db", margin: "0 8px" }} />

      <button
        onClick={saveLayoutLocal}
        style={{ padding: "8px 14px", borderRadius: 16, background: "#111", color: "#fff", border: "none", cursor: "pointer" }}
        title="Zapisz aktualny układ do localStorage"
      >
        Zapisz (przeglądarka)
      </button>
      <button
        onClick={resetLayout}
        style={{ padding: "8px 14px", borderRadius: 16, background: "#fff", color: "#111", border: "1px solid #e5e7eb", cursor: "pointer" }}
        title="Przywróć auto-layout"
      >
        Reset
      </button>
      <div style={{ width: 1, height: 24, background: "#d1d5db", margin: "0 8px" }} />
      <button
        onClick={loadLayoutFromDisk}
        style={{ padding: "8px 14px", borderRadius: 16, background: "#fff", color: "#111", border: "1px solid #e5e7eb", cursor: "pointer" }}
        title="Wczytaj układ z pliku (.json)"
      >
        Wczytaj z pliku…
      </button>
      <button
        onClick={saveLayoutToDisk}
        style={{ padding: "8px 14px", borderRadius: 16, background: "#fff", color: "#111", border: "1px solid #e5e7eb", cursor: "pointer" }}
        title="Zapisz układ do pliku (.json)"
      >
        Zapisz do pliku…
      </button>
      <input ref={fileInputRef} type="file" accept="application/json" onChange={onFilePicked} style={{ display: "none" }} />
    </div>
  );

  return (
    <div style={{ width: "100%", height: "90vh", background: "#f9fafb", borderRadius: 16, overflow: "hidden", position: "relative" }}>
      <Toolbar />
      <Legend />
      <ReactFlow
        style={{ width: "100%", height: "100%" }}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        snapToGrid
        snapGrid={GRID}
        nodesDraggable
        nodesConnectable={false}
        elevateEdgesOnSelect
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

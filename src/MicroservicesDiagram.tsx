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
 * Diagram mikroserwisów z możliwością ręcznego układania węzłów na siatce,
 * zapisem/odczytem UKŁADU z DYSKU (File System Access API + fallback)
 * oraz podglądem metryk (fake data).
 * 
 * ⚠️ Przeglądarka:
 * - Najwygodniej w Chrome/Edge (obsługa File System Access API: showOpenFilePicker, showSaveFilePicker).
 * - W innych przeglądarkach działa fallback: import przez <input type="file"> i export przez pobranie JSON.
 * 
 * Format pliku layoutu (JSON):
 * {
 *   "gw": {"x": 100, "y": 80},
 *   "auth": {"x": 400, "y": 40},
 *   ...
 * }
 * 
 * Jak podłączyć do Grafany/Prometheusa w przyszłości:
 * - w generateMetrics() zastąp wyliczenia realnym fetch'em do backendu
 *   (np. GET /graph/metrics) i mapuj do id krawędzi.
 */

const STORAGE_KEY = "microservices-layout-v1";

// Fake'owe mikroserwisy i połączenia. W prawdziwym świecie możesz je pobrać z API.
const baseServices = [
  { id: "gw", label: "api-gateway" },
  { id: "auth", label: "auth-service" },
  { id: "orders", label: "orders-service" },
  { id: "payments", label: "payments-service" },
  { id: "inventory", label: "inventory-service" },
  { id: "notify", label: "notification-service" },
];

const baseLinks = [
  { id: "gw->auth", source: "gw", target: "auth" },
  { id: "gw->orders", source: "gw", target: "orders" },
  { id: "orders->inventory", source: "orders", target: "inventory" },
  { id: "orders->payments", source: "orders", target: "payments" },
  { id: "payments->notify", source: "payments", target: "notify" },
];

// Generator fake'owych metryk: RPS i errorRate.
function generateMetrics() {
  const metrics = {} as Record<string, { rps: number; errorRate: number }>;
  for (const link of baseLinks) {
    const rps = Math.round(5 + Math.random() * 500); // 5..505
    const spike = Math.random() < 0.07 ? Math.random() * 0.25 : 0; // sporadyczne piki
    const baseline = Math.random() * 0.03; // 0..3%
    const errorRate = Math.min(0.4, baseline + spike); // max 40%
    metrics[link.id] = { rps, errorRate };
  }
  return metrics;
}

// Kolor krawędzi zależny od errorRate.
function edgeColor(errorRate: number) {
  if (errorRate > 0.1) return "#dc2626"; // czerwony (>=10%)
  if (errorRate > 0.05) return "#f97316"; // pomarańczowy (5-10%)
  if (errorRate > 0.01) return "#eab308"; // żółty (1-5%)
  return "#16a34a"; // zielony (<1%)
}

// Grubość krawędzi ~ log(RPS)
function edgeWidth(rps: number) {
  // mniejsze strzałki: cieńsze krawędzie
  return 0.75 + Math.log10(Math.max(1, rps)) * 1.3; // ~0.75..~4
}

// Domyślne pozycje startowe (siatka) – mogą być nadpisane layoutem z pliku/localStorage.
const defaultPositions: Record<string, { x: number; y: number }> = {
  gw: { x: 100, y: 80 },
  auth: { x: 400, y: 40 },
  orders: { x: 400, y: 160 },
  inventory: { x: 720, y: 160 },
  payments: { x: 720, y: 280 },
  notify: { x: 1040, y: 280 },
};

// Helpers dla zapisu/odczytu z dysku
const supportsFS = () =>
  typeof window !== "undefined" &&
  // @ts-ignore
  !!(window.showOpenFilePicker && window.showSaveFilePicker);

async function loadLayoutViaPicker() {
  // @ts-ignore
  const [handle] = await window.showOpenFilePicker({
    types: [{
      description: "Layout JSON",
      accept: { "application/json": [".json"] },
    }],
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
    types: [{
      description: "Layout JSON",
      accept: { "application/json": [".json"] },
    }],
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

export default function MicroservicesDiagram() {
  const [metrics, setMetrics] = useState(generateMetrics());

  // Sygnał do "ukrytego" inputa file (fallback odczytu).
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Wczytaj zapisany układ (pozycje węzłów) z localStorage przy starcie.
  const savedLayout = useMemo(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw) as Record<string, { x: number; y: number }>;
    } catch {
      return null;
    }
  }, []);

  const initialNodes = useMemo(() => {
    return baseServices.map((s) => ({
      id: s.id,
      type: "default",
      data: { label: s.label },
      position: savedLayout?.[s.id] ?? defaultPositions[s.id] ?? { x: 80, y: 80 },
      draggable: true,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        padding: 12,
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
        background: "white",
        fontSize: 14,
        fontWeight: 600,
      },
    }));
  }, [savedLayout]);

  const initialEdges = useMemo(() => {
    return baseLinks.map((l) => {
      const m = metrics[l.id];
      return {
        id: l.id,
        source: l.source,
        target: l.target,
        type: "smoothstep",
        label: `${(m.errorRate * 100).toFixed(1)}% • ${m.rps} rps`,
        animated: m.errorRate > 0.05,
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
        style: {
          stroke: edgeColor(m.errorRate),
          strokeWidth: edgeWidth(m.rps),
        },
        labelStyle: {
          fontWeight: 700,
          fontSize: 11,
          fill: "#111827",
        },
        labelBgPadding: [3, 1],
        labelBgBorderRadius: 6,
        labelBgStyle: { fill: "#ffffff", fillOpacity: 0.85 },
      } as any;
    });
  }, []);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Aktualizacja labeli i stylów krawędzi po każdej zmianie metryk.
  useEffect(() => {
    setEdges((eds) =>
      eds.map((e) => {
        const m = metrics[e.id];
        if (!m) return e;
        return {
          ...e,
          label: `${(m.errorRate * 100).toFixed(1)}% • ${m.rps} rps`,
          animated: m.errorRate > 0.05,
          type: "smoothstep",
          style: { ...(e.style || {}), stroke: edgeColor(m.errorRate), strokeWidth: edgeWidth(m.rps) },
        };
      })
    );
  }, [metrics, setEdges]);

  // Symulacja odświeżania metryk.
  useEffect(() => {
    const id = setInterval(() => setMetrics(generateMetrics()), 3000);
    return () => clearInterval(id);
  }, []);

  // Snap do siatki 20x20.
  const snapGrid: [number, number] = [20, 20];

  // Pobranie aktualnego layoutu z węzłów.
  const extractLayout = useCallback(() => {
    const layout: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) layout[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    return layout;
  }, [nodes]);

  // Zapis układu do localStorage.
  const saveLayoutLocal = useCallback(() => {
    const layout = extractLayout();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  }, [extractLayout]);

  // Reset układu do domyślnych pozycji.
  const resetLayout = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        position: defaultPositions[n.id] ?? { x: 80, y: 80 },
      }))
    );
  }, [setNodes]);

  // Wczytaj layout z obiektu i zastosuj.
  const applyLayout = useCallback((layout: Record<string, { x: number; y: number }>) => {
    if (!layout) return;
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        position: layout[n.id] ?? n.position,
      }))
    );
    // Opcjonalnie: zapisz w localStorage, aby wczytał się przy starcie.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  }, [setNodes]);

  // Zapis do PLIKU (FS API lub fallback)
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

  // Odczyt z PLIKU (FS API lub fallback input)
  const loadLayoutFromDisk = useCallback(async () => {
    try {
      if (supportsFS()) {
        const layout = await loadLayoutViaPicker();
        applyLayout(layout);
      } else {
        fileInputRef.current?.click(); // uruchomimy fallback <input>
      }
    } catch (e) {
      console.error("load from disk error", e);
      alert("Nie udało się wczytać pliku.");
    }
  }, [applyLayout]);

  // Obsługa fallback inputa file
  const onFilePicked = useCallback(async (ev: React.ChangeEvent<HTMLInputElement>) => {
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
      ev.target.value = ""; // wyczyść, by móc wybrać ten sam plik ponownie
    }
  }, [applyLayout]);

  // Podpowiedzi/legendy.
  const Legend = () => (
    <div style={{ position: 'fixed', right: 16, top: 16, zIndex: 50, background: 'rgba(255,255,255,0.9)', backdropFilter: 'blur(4px)', borderRadius: 16, boxShadow: '0 6px 20px rgba(0,0,0,0.08)', padding: 12, fontSize: 13, lineHeight: 1.3 }}>
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
    <div style={{ position: 'fixed', left: 16, top: 16, zIndex: 50, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button
        onClick={saveLayoutLocal}
        style={{ padding: '8px 14px', borderRadius: 16, background: '#111', color: '#fff', border: 'none', cursor: 'pointer' }}
        title="Zapisz aktualny układ do localStorage"
      >
        Zapisz (przeglądarka)
      </button>
      <button
        onClick={resetLayout}
        style={{ padding: '8px 14px', borderRadius: 16, background: '#fff', color: '#111', border: '1px solid #e5e7eb', cursor: 'pointer' }}
        title="Przywróć układ domyślny"
      >
        Reset
      </button>
      <div style={{ width: 1, height: 24, background: '#d1d5db', margin: '0 8px' }} />
      <button
        onClick={loadLayoutFromDisk}
        style={{ padding: '8px 14px', borderRadius: 16, background: '#fff', color: '#111', border: '1px solid #e5e7eb', cursor: 'pointer' }}
        title="Wczytaj układ z pliku (.json)"
      >
        Wczytaj z pliku…
      </button>
      <button
        onClick={saveLayoutToDisk}
        style={{ padding: '8px 14px', borderRadius: 16, background: '#fff', color: '#111', border: '1px solid #e5e7eb', cursor: 'pointer' }}
        title="Zapisz układ do pliku (.json)"
      >
        Zapisz do pliku…
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        onChange={onFilePicked}
        style={{ display: 'none' }}
      />
    </div>
  );

  return (
    <div style={{ width: '100%', height: '90vh', background: '#f9fafb', borderRadius: 16, overflow: 'hidden', position: 'relative' }}>
      <Toolbar />
      <Legend />
      <ReactFlow
        style={{ width: '100%', height: '100%' }}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        fitView
        snapToGrid
        snapGrid={[20, 20]}
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

import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight } from "lucide-react";

/**
 * MicroserviceDependencyNavigator
 *
 * Kolumnowy przegląd zależności między mikroserwisami (styl "Finder").
 * - Po lewej rooty. Kliknięcie pokazuje dzieci w następnej kolumnie.
 * - Strzałki (SVG) rysowane od aktywnego rodzica do jego dzieci.
 * - "Kolumny" są niewidoczne – to pionowe listy bez ramek.
 *
 * Props:
 *  - data?: ServiceNode[] – lista rootów
 *  - onSelect?: (node: ServiceNode) => void
 *  - maxColumns?: number – maksymalna liczba wyświetlanych kolumn (domyślnie 6)
 *  - renderNode?: (node: ServiceNode, isActive: boolean) => React.ReactNode – własny renderer kafelka
 */

export type ServiceNode = {
  id: string;
  name: string;
  status?: "healthy" | "degraded" | "down";
  /** opcjonalny ruch (requests per minute) używany do grubości krawędzi */
  rpm?: number;
  children?: ServiceNode[];
};

export type TestResult = { name: string; passed: boolean; details?: string };

// -------------------- Pomocnicze --------------------
export function computeColumns(
  roots: ServiceNode[],
  path: ServiceNode[],
  maxColumns: number
): ServiceNode[][] {
  const safeRoots = Array.isArray(roots) ? roots : [];
  const cols: ServiceNode[][] = [];
  cols.push(safeRoots);
  for (let depth = 0; depth < path.length; depth++) {
    const parent = path[depth];
    const kids = parent?.children ?? [];
    cols.push(kids);
    if (cols.length >= maxColumns) break;
  }
  return cols.slice(0, maxColumns);
}

/**
 * Mapuje rpm na grubość linii [minW,maxW] z normalizacją do lokalnego min/max.
 */
export function rpmToWidth(
  rpm: number,
  minRpm: number,
  maxRpm: number,
  minW = 1.5,
  maxW = 6
): number {
  const r = Number.isFinite(rpm) ? rpm : 0;
  const lo = Number.isFinite(minRpm) ? minRpm : 0;
  const hi = Number.isFinite(maxRpm) ? maxRpm : lo;
  if (hi <= lo) return (minW + maxW) / 2;
  const t = Math.min(1, Math.max(0, (r - lo) / (hi - lo)));
  return minW + t * (maxW - minW);
}

// -------------------- Komponent główny --------------------
export function MicroserviceDependencyNavigator({
  data,
  onSelect,
  maxColumns = 6,
  renderNode,
}: {
  data?: ServiceNode[];
  onSelect?: (node: ServiceNode) => void;
  maxColumns?: number;
  renderNode?: (node: ServiceNode, isActive: boolean) => React.ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Bezpieczny fallback, gdy `data` nie jest tablicą
  const safeData = Array.isArray(data) ? data : [];

  // Wybrana ścieżka (po jednym elemencie na kolumnę)
  const [path, setPath] = useState<ServiceNode[]>([]);

  // Mapowanie id -> element DOM, aby znać pozycje kafelków
  const nodeRefs = useRef(new Map<string, HTMLDivElement | null>());

  // Wyliczenie kolumn na podstawie ścieżki
  const columns: ServiceNode[][] = useMemo(
    () => computeColumns(safeData, path, maxColumns),
    [safeData, path, maxColumns]
  );

  useLayoutEffect(() => {
  recomputeArrows();

  const sc = scrollRef.current;
  const content = contentRef.current;

  const ro = new ResizeObserver(() => recomputeArrows());
  if (content) ro.observe(content);

  const onScroll = () => recomputeArrows();
  sc?.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });

  return () => {
    ro.disconnect();
    sc?.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onScroll);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [path, columns]);


  // Rysowanie strzałek (zróżnicowana grubość od rpm)
  type EdgeSeg = { d: string; width: number };
  const [edgesByDepth, setEdgesByDepth] = useState<EdgeSeg[][]>([]);

const recomputeArrows = () => {
  const scrollEl = scrollRef.current;
  const svg = svgRef.current;
  if (!scrollEl || !svg) return;

  // szer./wys. SVG = rozmiar zawartości (a nie viewportu)
  const W = (contentRef.current?.scrollWidth ?? scrollEl.scrollWidth);
  const H = (contentRef.current?.scrollHeight ?? scrollEl.scrollHeight);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));

  // offsety scrolla
  const scrollX = scrollEl.scrollLeft;
  const scrollY = scrollEl.scrollTop;

  // viewport, względem którego odejmujemy recty
  const viewportRect = scrollEl.getBoundingClientRect();

  const newEdges: EdgeSeg[][] = [];

  for (let depth = 0; depth < path.length; depth++) {
    const parent = path[depth];
    if (!parent) { newEdges.push([]); continue; }

    const parentKey = `${depth}:${parent.id}`;
    const parentEl = nodeRefs.current.get(parentKey);
    const children = parent.children ?? [];
    if (!parentEl || children.length === 0) { newEdges.push([]); continue; }

    const parentRect = parentEl.getBoundingClientRect();

    const parentX = (parentRect.right - viewportRect.left) + scrollX;
    const parentY = (parentRect.top   - viewportRect.top ) + parentRect.height / 2 + scrollY;

    const rpms = children.map(c => c.rpm ?? 0);
    const minR = rpms.length ? Math.min(...rpms) : 0;
    const maxR = rpms.length ? Math.max(...rpms) : 0;
    const depthEdges: EdgeSeg[] = [];

    for (const child of children) {
      const childKey = `${depth + 1}:${child.id}`;
      const childEl = nodeRefs.current.get(childKey);
      if (!childEl) continue;

      const childRect = childEl.getBoundingClientRect();
      const childX = (childRect.left - viewportRect.left) + scrollX;
      const childY = (childRect.top  - viewportRect.top ) + childRect.height / 2 + scrollY;

      const midX = parentX + (childX - parentX) * 0.5;
      const dMain = `M ${parentX} ${parentY} C ${midX} ${parentY}, ${midX} ${childY}, ${childX} ${childY}`;
      const width = rpmToWidth(child.rpm ?? 0, minR, maxR);

      depthEdges.push({ d: dMain, width });

      const arrowSize = 6;
      const angle = Math.atan2(childY - parentY, childX - parentX);
      const ax = childX, ay = childY;
      const a1x = ax - arrowSize * Math.cos(angle - Math.PI / 8);
      const a1y = ay - arrowSize * Math.sin(angle - Math.PI / 8);
      const a2x = ax - arrowSize * Math.cos(angle + Math.PI / 8);
      const a2y = ay - arrowSize * Math.sin(angle + Math.PI / 8);

      depthEdges.push({ d: `M ${ax} ${ay} L ${a1x} ${a1y}`, width });
      depthEdges.push({ d: `M ${ax} ${ay} L ${a2x} ${a2y}`, width });
    }

    newEdges.push(depthEdges);
  }

  setEdgesByDepth(newEdges);
};


  // Obserwuj resize i scroll, by odświeżać strzałki
  useLayoutEffect(() => {
    recomputeArrows();
    const ro = new ResizeObserver(() => recomputeArrows());
    if (containerRef.current) ro.observe(containerRef.current);
    const onScroll = () => recomputeArrows();
    containerRef.current?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      containerRef.current?.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, columns]);

  const handleClick = (node: ServiceNode, depth: number) => {
    // Przy kliknięciu – przytnij ścieżkę do tego poziomu i dodaj kliknięty node
    const next = [...path.slice(0, depth), node];
    setPath(next);
    onSelect?.(node);
    // Delikatne przewinięcie w prawo, gdy pojawi się nowa kolumna
    requestAnimationFrame(() => {
      containerRef.current?.scrollTo({ left: containerRef.current.scrollWidth, behavior: "smooth" });
    });
  };

  const renderTile = (node: ServiceNode, isActive: boolean) => {
    if (renderNode) return renderNode(node, isActive);
    const barColor =
      node.status === "down"
        ? "bg-red-500"
        : node.status === "degraded"
        ? "bg-amber-500"
        : "bg-emerald-500";

    // Kontener bez paddingu, overflow-hidden, aby pasek mógł iść od samej góry do dołu
    return (
      <div
        className={`group relative flex rounded-2xl shadow-sm hover:shadow transition-all cursor-pointer overflow-hidden ${
          isActive ? "ring-2 ring-indigo-500" : "ring-1 ring-black/5"
        }`}
      >
        {/* pionowy pasek statusu od góry do dołu */}
        <span className={`${barColor} absolute inset-y-0 left-0 w-2`} aria-hidden="true" />

        {/* zawartość z paddingiem i odsunięciem od paska */}
        <div className="flex items-center gap-3 p-3 pl-5 w-full">
          <div className="font-medium truncate" title={node.name}>{node.name}</div>
          {node.children && node.children.length > 0 && (
            <ChevronRight className="ml-auto h-4 w-4 opacity-60 group-hover:translate-x-0.5 transition-transform" />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="w-full h-[520px] relative">
      {/* Tło i przewijanie w poziomie */}
      <div ref={scrollRef} className="absolute inset-0 overflow-x-auto overflow-y-hidden">
        {/* SVG na strzałki */}
        <svg ref={svgRef} className="absolute inset-0 pointer-events-none">
          {edgesByDepth.map((edges, i) =>
            edges.map((e, j) => (
              <path
                key={`${i}-${j}`}
                d={e.d}
                strokeWidth={e.width}
                strokeOpacity={0.5}
                fill="none"
                className="stroke-indigo-500"
              />
            ))
          )}
        </svg>

        {/* Kolumny (bez widocznych ramek) */}
        <div ref={contentRef} className="relative flex gap-6 px-4 py-4 min-w-full">
          {columns.map((col, depth) => {
            const items = Array.isArray(col) ? col : [];
            return (
              <div key={depth} className="flex-shrink-0 w-120">
                <AnimatePresence mode="popLayout">
                  {items.length === 0 ? (
                    <div className="text-sm text-neutral-500 pt-2">Brak elementów</div>
                  ) : (
                    <motion.div
                      key={`${depth}-${path[depth]?.id ?? "none"}`}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.18 }}
                      className="grid gap-2"
                    >
                      {items.map((node) => {
                        const isActive = path[depth]?.id === node.id;
                        return (
                          <div
                            key={node.id}
                            ref={(el) => {
                              const key = `${depth}:${node.id}`;
                              if (el) {
                                nodeRefs.current.set(key, el);
                              } else {
                                nodeRefs.current.delete(key);
                              }
                            }}
                            onClick={() => handleClick(node, depth)}
                          >
                            {renderTile(node, isActive)}
                          </div>
                        );
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>

      {/* Gradienty krańcowe dla czytelności */}
      <div className="pointer-events-none absolute left-0 top-0 h-full w-6 bg-gradient-to-r from-white to-transparent" />
      <div className="pointer-events-none absolute right-0 top-0 h-full w-6 bg-gradient-to-l from-white to-transparent" />
    </div>
  );
}

// -------------------- Demo + Testy --------------------
export function DemoMicroservices() {
  const demo: ServiceNode[] = [
    {
      id: "gw",
      name: "gateway",
      status: "healthy",
      children: [
        {
          id: "auth",
          name: "auth-service",
          status: "degraded",
          children: [
            { id: "db-auth", name: "postgres-auth", status: "healthy", rpm: 50 },
            { id: "queue-auth1", name: "rabbitmq-auth", status: "healthy", rpm: 120 },
            { id: "queue-auth2", name: "rabbitmq-auth1", status: "healthy", rpm: 300 },
            { id: "queue-auth3", name: "rabbitmq-auth2", status: "healthy", rpm: 30 },
            { id: "queue-auth4", name: "rabbitmq-auth3", status: "healthy", rpm: 800 },
          ],
        },
        {
          id: "billing",
          name: "billing-service",
          status: "healthy",
          children: [
            { id: "db-bill", name: "postgres-billing", status: "healthy", rpm: 40 },
            { id: "pay", name: "payments-adapter", status: "down", rpm: 0 },
          ],
        },
      ],
    },
    {
      id: "reporting",
      name: "reporting",
      status: "healthy",
      children: [
        { id: "agg", name: "aggregator", status: "healthy", rpm: 25 },
        { id: "etl", name: "etl-jobs", status: "healthy", rpm: 10 },
      ],
    },
  ];

  return (
    <div className="p-4">
      <h2 className="text-xl font-semibold mb-3">Zależności mikroserwisów</h2>
      <MicroserviceDependencyNavigator data={demo} maxColumns={6} />
    </div>
  );
}

export function runTests(): TestResult[] {
  const results: TestResult[] = [];

  // Dane testowe
  const roots: ServiceNode[] = [
    {
      id: "r1",
      name: "root1",
      children: [
        { id: "c1", name: "child1" },
        { id: "c2", name: "child2", children: [{ id: "g1", name: "grand1" }] },
      ],
    },
    { id: "r2", name: "root2" },
  ];

  // Test 1: puste dane → tylko 1 kolumna (pusta)
  try {
    const cols = computeColumns([], [], 6);
    results.push({ name: "Empty data -> one empty column", passed: Array.isArray(cols) && cols.length === 1 && cols[0].length === 0 });
  } catch (e) {
    results.push({ name: "Empty data -> one empty column", passed: false, details: String(e) });
  }

  // Test 2: ścieżka root1 -> child2 → kolumny: [roots, children(root1), children(child2)]
  try {
    const path = [roots[0], roots[0].children![1]]; // root1, child2
    const cols = computeColumns(roots, path as ServiceNode[], 6);
    const ok =
      cols.length >= 3 &&
      cols[0].length === 2 && // roots
      cols[1].length === 2 && // children of root1
      cols[2].length === 1; // children of child2
    results.push({ name: "Path root1 -> child2 builds 3 columns", passed: ok });
  } catch (e) {
    results.push({ name: "Path root1 -> child2 builds 3 columns", passed: false, details: String(e) });
  }

  // Test 3: ograniczenie maxColumns
  try {
    const path = [roots[0], roots[0].children![1]];
    const cols = computeColumns(roots, path as ServiceNode[], 2);
    results.push({ name: "Respects maxColumns limit", passed: cols.length === 2 });
  } catch (e) {
    results.push({ name: "Respects maxColumns limit", passed: false, details: String(e) });
  }

  // Test 4: fallback dla undefined danych
  try {
    const cols = computeColumns([] as ServiceNode[], [], 6);
    results.push({ name: "Handles undefined data safely", passed: cols.length === 1 });
  } catch (e) {
    results.push({ name: "Handles undefined data safely", passed: false, details: String(e) });
  }

  // Dodatkowe testy
  // Test 5: rodzic bez dzieci tworzy pustą kolumnę
  try {
    const roots2: ServiceNode[] = [{ id: "a", name: "A", children: [] }];
    const path2 = [roots2[0]];
    const cols2 = computeColumns(roots2, path2, 6);
    results.push({ name: "Parent without children -> empty column", passed: cols2.length >= 2 && cols2[1].length === 0 });
  } catch (e) {
    results.push({ name: "Parent without children -> empty column", passed: false, details: String(e) });
  }

  // Test 6: długa ścieżka przycięta przez maxColumns
  try {
    const deep: ServiceNode = { id: "r", name: "r", children: [{ id: "c", name: "c", children: [{ id: "g", name: "g" }] }] };
    const cols3 = computeColumns([deep], [deep, deep.children![0]], 2);
    results.push({ name: "Long path trimmed by maxColumns", passed: cols3.length === 2 });
  } catch (e) {
    results.push({ name: "Long path trimmed by maxColumns", passed: false, details: String(e) });
  }

  // Test 7: rpmToWidth skaluje rosnąco
  try {
    const a = rpmToWidth(0, 0, 100);
    const b = rpmToWidth(100, 0, 100);
    results.push({ name: "rpmToWidth maps bounds", passed: a < b });
  } catch (e) {
    results.push({ name: "rpmToWidth maps bounds", passed: false, details: String(e) });
  }

  return results;
}

// Domyślny eksport – podgląd + uruchamianie testów
export default function Preview() {
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);

  return (
    <div className="p-4 space-y-4">
      <DemoMicroservices />

      <div className="rounded-xl border border-black/5 p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Testy komponentu</h3>
          <button
            className="rounded-xl px-3 py-1.5 text-sm bg-neutral-900 text-white hover:bg-neutral-800"
            onClick={() => setTestResults(runTests())}
          >
            Uruchom testy
          </button>
        </div>
        {testResults && (
          <ul className="mt-3 space-y-1 text-sm">
            {testResults.map((t, i) => (
              <li key={i}>
                <span className={t.passed ? "text-emerald-700" : "text-red-700"}>
                  {t.passed ? "✓" : "✗"} {t.name}
                </span>
                {t.details && <span className="text-neutral-500"> — {t.details}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

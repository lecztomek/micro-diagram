import React from "react";
import { MicroserviceDependencyNavigator } from "./MicroserviceDependencyNavigator"; // ⬅️ dopasuj ścieżkę importu

// --- Typy --------------------------------------------------------------

type Status = "healthy" | "degraded" | "down";

export type ServiceNode = {
  id: string;
  name: string;
  status?: Status;
  rpm?: number;
  children?: ServiceNode[];
};

/** Obcina nazwę do N członów rozdzielonych kropką.
 *  Dodatkowo:
 *  - spacje traktuje jak kropki,
 *  - zrzuca końcowy sufiks wersji typu " (v1.20.0)" (case-insensitive).
 */
export function groupKey(name: string, depth = 3): string {
  if (!name) return "(inne)";
  const base = String(name)
    .replace(/\s*\(v[\d.]+\)\s*$/i, "") // usuń końcowy sufiks wersji
    .replace(/\s+/g, ".")               // spacje => kropki
    .replace(/\.+/g, ".")               // sklej wielokrotne kropki
    .replace(/^\.+|\.+$/g, "");         // trim kropek z końców

  const parts = base.split(".");
  return parts.slice(0, Math.max(1, depth)).join(".") || "(inne)";
}

const STATUS_COLOR: Record<Status, string> = {
  healthy: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-red-500",
} as const;

// im wyżej, tym gorzej
function statusRank(s: Status | undefined) {
  return s === "down" ? 3 : s === "degraded" ? 2 : s === "healthy" ? 1 : 0;
}

function worstStatusInTree(node?: ServiceNode): Status {
  if (!node) return "healthy";
  let worst: Status = node.status ?? "healthy";
  const kids = node.children ?? [];
  for (const k of kids) {
    const wk = worstStatusInTree(k); // zawsze Status
    if (statusRank(wk) > statusRank(worst)) worst = wk;
    if (worst === "down") break; // szybkie wyjście
  }
  return worst;
}

function worstStatusInGroup(nodes: ServiceNode[]): Status {
  let worst: Status = "healthy";
  for (const n of nodes) {
    const w = worstStatusInTree(n);
    if (statusRank(w) > statusRank(worst)) worst = w;
    if (worst === "down") break;
  }
  return worst;
}

// --- Props -------------------------------------------------------------

export type TabsProps = {
  data?: ServiceNode[];
  /** Ile członów nazwy liczy prefiks grupy (domyślnie 3). */
  depth?: number;
  /** Maksymalna liczba kolumn w drzewku. Przekazywana do MicroserviceDependencyNavigator. */
  maxColumns?: number;
  onSelect?: (node: ServiceNode) => void;
  /** Własny renderer kafelka. Przekazywany dalej. */
  renderNode?: (node: ServiceNode, isActive: boolean) => React.ReactNode;
  /** Nazwa tabu startowego (musi odpowiadać jednej z grup) lub etykiecie ALL. */
  defaultTab?: string;
  /** Własna funkcja grupująca (zastępuje `depth`). */
  groupBy?: (node: ServiceNode) => string;
  /** Czy dodać tab zbiorczy obejmujący wszystkie rooty. */
  showAllTab?: boolean;
  /** Etykieta tabu zbiorczego. */
  allTabLabel?: string;
  /** Klasy dla kontenera zewnętrznego. */
  className?: string;
};

// --- Komponent ---------------------------------------------------------

/**
 * MicroserviceNavigatorWithTabs – lekki wrapper w OSOBNYM pliku.
 *
 * - Generuje taby dynamicznie na podstawie `data` (brak twardych prefixów).
 * - Każdy root trafia do dokładnie jednego tabu – brak duplikacji.
 * - W środku używa Twojego komponentu MicroserviceDependencyNavigator.
 */
export function MicroserviceNavigatorWithTabs({
  data,
  depth = 3,
  maxColumns = 6,
  onSelect,
  renderNode,
  defaultTab,
  groupBy,
  showAllTab = false,
  allTabLabel = "(Wszystkie)",
  className,
}: TabsProps) {
  const safeData = Array.isArray(data) ? data : [];

  // Zbuduj mapę grup → rooty
  const groups = React.useMemo(() => {
    const map: Record<string, ServiceNode[]> = {};
    for (const r of safeData) {
      const key = (groupBy ? groupBy(r) : groupKey(r.name, depth)) || "(inne)";
      if (!map[key]) map[key] = [];
      map[key].push(r);
    }
    return map;
  }, [safeData, groupBy, depth]);

  const baseTabs = React.useMemo(() => Object.keys(groups).sort(), [groups]);
  const tabs = React.useMemo(
    () => (showAllTab ? [allTabLabel, ...baseTabs] : baseTabs),
    [baseTabs, showAllTab, allTabLabel]
  );

  const [active, setActive] = React.useState<string>(() => {
    if (defaultTab && (defaultTab === allTabLabel || defaultTab in groups)) return defaultTab;
    return tabs[0] ?? ""; // osłona na brak tabów
  });

  // Jeśli lista tabów się zmieni (np. zmiana danych), zabezpiecz aktywny tab.
  React.useEffect(() => {
    if (!tabs.includes(active)) setActive(tabs[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.join("|"), active]);

  const rootsForActive = active === allTabLabel ? safeData : (groups[active] ?? []);

  return (
    <div className={className}>
      {/* Pasek tabów */}
      <div className="mb-3 flex flex-wrap items-center gap-2 gap-y-2">
        {tabs.map((t) => {
          const allRoots = t === allTabLabel ? safeData : (groups[t] ?? []);
          const count = allRoots.length;
          const isActive = t === active;
          const worst = worstStatusInGroup(allRoots);
          const stripe = STATUS_COLOR[worst];

          // --- PREZENTACJA: ukryj wiodące "default" w etykiecie taba ---
          const rawLabel = t;
          const cleaned = t === allTabLabel ? t : t.replace(/^default(?:\.|$)/i, "");
          const label = cleaned || rawLabel;

          return (
            <button
              key={t}
              onClick={() => setActive(t)}
              className={[
                "relative inline-flex items-center rounded-xl border text-[11px] transition-all",
                "px-2.5 py-1 pl-4",          // ciaśniejsze paddingi
                "bg-white",                   // brak szarego podświetlania
                isActive
                  ? "ring-2 ring-indigo-600 border-indigo-600 shadow"
                  : "border-black/10 hover:ring-1 hover:ring-neutral-300",
              ].join(" ")}
              title={`${label} (${count})`}
            >
              {/* pionowy pasek statusu jak w kafelkach */}
              <span
                aria-hidden
                className={`${stripe} absolute inset-y-0 left-0 w-2 rounded-l-xl`}
              />
              <span className="font-medium leading-tight whitespace-normal break-words">
                {label}
              </span>
              <span
                className={[
                  "ml-2 inline-flex h-3 min-w-[14px] items-center justify-center rounded-full px-[3px]",
                  "text-[9px] leading-none",
                  isActive
                    ? "bg-indigo-50 text-indigo-700 border border-indigo-200"
                    : "bg-black/5 text-neutral-700",
                ].join(" ")}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Drzewko – używa Twojego komponentu, klucz resetuje stan ścieżki przy zmianie tabu */}
      <div className="rounded-2xl border border-black/5">
        <MicroserviceDependencyNavigator
          key={active}
          data={rootsForActive}
          maxColumns={maxColumns}
          onSelect={onSelect}
          renderNode={renderNode}
        />
      </div>
    </div>
  );
}

export default MicroserviceNavigatorWithTabs;

import React from "react";
import { MicroserviceDependencyNavigator } from "./MicroserviceDependencyNavigator"; // ⬅️ Zmień ścieżkę importu na właściwą

// Typy – importuj z Twojego pliku jeśli je eksportujesz.
// Jeśli ServiceNode jest eksportowany, użyj: `import { ServiceNode } from "./MicroserviceDependencyNavigator";`
export type ServiceNode = {
  id: string;
  name: string;
  status?: "healthy" | "degraded" | "down";
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

/**
 * MicroserviceNavigatorWithTabs – lekki wrapper w OSOBNYM pliku.
 *
 * - Generuje taby dynamicznie na podstawie `data` (brak twardych prefixów).
 * - Każdy root trafia do dokładnie jednego tabu – brak duplikacji.
 * - W środku używa Twojego istniejącego komponentu MicroserviceDependencyNavigator.
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
    if (defaultTab && (defaultTab === allTabLabel || (defaultTab in groups))) return defaultTab;
    return tabs[0];
  });

  // Jeśli lista tabów się zmieni (np. zmiana danych), zabezpiecz aktywny tabu.
  React.useEffect(() => {
    if (!tabs.includes(active)) setActive(tabs[0]);
  }, [tabs.join("|"), active]);

  const rootsForActive = active === allTabLabel ? safeData : (groups[active] ?? []);

  return (
    <div className={className}>
      {/* Pasek tabów */}
      <div className="mb-3 flex flex-wrap items-center gap-2 gap-y-2">
        {tabs.map((t) => {
          const count = t === allTabLabel ? safeData.length : (groups[t]?.length ?? 0);
          const isActive = t === active;
          return (
            <button
              key={t}
              onClick={() => setActive(t)}
              className={`whitespace-nowrap rounded-xl px-3 py-1.5 text-sm border transition-all ${
                isActive
                  ? "bg-indigo-600 text-white border-indigo-600 shadow"
                  : "bg-white text-neutral-800 border-black/10 hover:bg-neutral-50"
              }`}
              title={`${t} (${count})`}
            >
              <span className="font-medium">{t}</span>
              <span className={`ml-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full text-xs ${
                isActive ? "bg-white/20" : "bg-black/5"
              }`}>
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

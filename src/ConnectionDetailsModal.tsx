import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink, Link as LinkIcon, Loader2 } from "lucide-react";

/* =====================================================================================
 * Typy
 * ===================================================================================*/
export type ServiceNode = {
  id: string;
  name: string;
  status?: "healthy" | "degraded" | "down";
  rpm?: number; // zachowane dla kompatybilności, nieużywane w UI
};

export type StatusItem = {
  code: string;     // np. 500, 404, "unknown"
  total: number;    // liczba zdarzeń w oknie
  perMin?: number;  // zachowane dla kompatybilności, nieużywane w UI
};

export type PathRow = {
  path: string;
  totalErrors: number;
  byStatus: Record<string, number>;
  perMin?: number; // zachowane dla kompatybilności, nieużywane w UI
};

export type ConnectionDetails = {
  label?: string;
  rpm?: number; // zachowane dla kompatybilności, nieużywane w UI
  errorRate?: number; // zachowane dla kompatybilności, nieużywane w UI
  meta?: Record<string, string | number | boolean | null | undefined>;
  url?: string;
  statuses?: StatusItem[];
  paths?: PathRow[];
};

/** Surowe etykiety do dokładnego matchowania */
export type EdgeLabelsExact = {
  systemName?: string;
  executableGroupName?: string;
  executableName?: string;
  executableVersion?: string;
  targetServiceGroupName?: string;
  targetServiceName?: string;
  targetServiceVersion?: string;
};

export type PromConfig = {
  url: string;                 // np. http://prometheus:9090/api/v1/query
  headers?: HeadersInit;
  /** domyślne środowisko (systemName), gdy nie podasz go w edgeLabelsExact */
  systemEnv?: string;
  /** mapowanie naszych pól -> nazwy labeli w metryce Prometheus */
  labelMap?: Partial<{
    systemName: string;
    executableGroupName: string;
    executableName: string;
    executableVersion: string;
    targetServiceGroupName: string;
    targetServiceName: string;
    targetServiceVersion: string;
    status: string; // jeśli inne niż "status"
    path: string;   // jeśli inne niż "path"
  }>;
};

/* =====================================================================================
 * UI helpers
 * ===================================================================================*/
function statusToBadgeColor(s?: ServiceNode["status"]) {
  switch (s) {
    case "down":
      return "bg-red-100 text-red-700 ring-red-200";
    case "degraded":
      return "bg-amber-100 text-amber-700 ring-amber-200";
    default:
      return "bg-emerald-100 text-emerald-700 ring-emerald-200";
  }
}

/*/* =====================================================================================
 * Prometheus helpers
 * ===================================================================================*/
function mapEdgeLabelsToMetric(labels: EdgeLabelsExact, prom?: PromConfig) {
  const m = {
    systemName: prom?.labelMap?.systemName ?? "systemName",
    executableGroupName: prom?.labelMap?.executableGroupName ?? "executableGroupName",
    executableName: prom?.labelMap?.executableName ?? "executableName",
    executableVersion: prom?.labelMap?.executableVersion ?? "executableVersion",
    targetServiceGroupName: prom?.labelMap?.targetServiceGroupName ?? "targetServiceGroupName",
    targetServiceName: prom?.labelMap?.targetServiceName ?? "targetServiceName",
    targetServiceVersion: prom?.labelMap?.targetServiceVersion ?? "targetServiceVersion",
  };
  const out: Record<string, string | undefined> = {};
  out[m.systemName] = labels.systemName ?? prom?.systemEnv;
  out[m.executableGroupName] = labels.executableGroupName;
  out[m.executableName] = labels.executableName;
  out[m.executableVersion] = labels.executableVersion;
  out[m.targetServiceGroupName] = labels.targetServiceGroupName;
  out[m.targetServiceName] = labels.targetServiceName;
  out[m.targetServiceVersion] = labels.targetServiceVersion;
  return out;
}

function buildLabelMatcherExact(labels: Record<string, string | undefined>) {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(labels)) {
    const vv = (v ?? "").trim();
    if (!vv) continue;
    // escapujemy backslash oraz cudzysłów dla PromQL
    const esc = vv.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    parts.push(`${k}="${esc}"`);
  }
  return `{${parts.join(",")}}`;
}


function addLabelToMatcher(matcher: string, kv: string) {
  // dodajemy label przed zamykającą "}"
  return matcher.replace(/\}$/u, `${matcher.length > 2 ? "," : ""}${kv}}`);
}

async function promQuery(prom: PromConfig, query: string) {
  const res = await fetch(`${prom.url}?query=${encodeURIComponent(query)}`, { headers: prom.headers });
  if (!res.ok) throw new Error(`Prometheus HTTP ${res.status}`);
  const json = await res.json();
  if (json.status !== "success") throw new Error(`Prometheus error: ${json.error || "unknown"}`);
  return json.data?.result ?? [];
}

/** Wbudowany fetcher – najpierw exact (z wersjami), potem relaxed (bez wersji) */
async function defaultFetchConnectionFromExact(
  prom: PromConfig,
  exact: EdgeLabelsExact
): Promise<ConnectionDetails> {
  const exactMatcher = buildLabelMatcherExact(
    mapEdgeLabelsToMetric(
      {
        systemName: exact.systemName ?? prom.systemEnv,
        executableGroupName: exact.executableGroupName,
        executableName: exact.executableName,
        executableVersion: exact.executableVersion,
        targetServiceGroupName: exact.targetServiceGroupName,
        targetServiceName: exact.targetServiceName,
        targetServiceVersion: exact.targetServiceVersion,
      },
      prom
    )
  );

  

  const makeQueries = (m: string) => {
    const statusKey = prom.labelMap?.status ?? "status";
    const pathKey = prom.labelMap?.path ?? "path";
    return {
      Q_TOTAL: `sum(xsp_proxy_request_duration_miliseconds_count${m})`,
      Q_OK: `sum(xsp_proxy_request_duration_miliseconds_count${addLabelToMatcher(m, `${statusKey}=~\"200|204\"`)})`,
      Q_ERR_BY_STATUS: `sum by (${statusKey}) (xsp_proxy_request_duration_miliseconds_count${addLabelToMatcher(m, `${statusKey}!~\"200|204\"`)})`,
      Q_ERR_BY_PATH: `sum by (${pathKey}, ${statusKey}) (xsp_proxy_request_duration_miliseconds_count${addLabelToMatcher(m, `${statusKey}!~\"200|204\"`)})`,
    };
  };

  async function runOnce(matcher: string) {
    const { Q_TOTAL, Q_OK, Q_ERR_BY_STATUS, Q_ERR_BY_PATH } = makeQueries(matcher);
    const [vTotal, vOk, vByStatus, vByPath] = await Promise.all([
      promQuery(prom, Q_TOTAL),
      promQuery(prom, Q_OK),
      promQuery(prom, Q_ERR_BY_STATUS),
      promQuery(prom, Q_ERR_BY_PATH),
    ]);

    // total pozostaje jeśli chcesz go użyć np. w diagnostyce, ale UI pokazuje tylko counts
    const total = Number(vTotal?.[0]?.value?.[1] ?? 0);

    const statuses: StatusItem[] = (vByStatus ?? []).map((s: any) => ({
      code: String(s.metric?.status ?? "unknown"),
      total: Number(s.value?.[1] ?? 0),
    }));

    const pathsMap = new Map<string, PathRow>();
    for (const s of vByPath ?? []) {
      const m = s.metric ?? {};
      const path = String(m.path ?? "").trim() || "(brak path)";
      const status = String(m.status ?? "").trim() || "unknown";
      const val = Number(s.value?.[1] ?? 0);
      const cur = pathsMap.get(path) ?? { path, totalErrors: 0, byStatus: {} as Record<string, number> };
      cur.totalErrors += val;
      cur.byStatus[status] = (cur.byStatus[status] ?? 0) + val;
      pathsMap.set(path, cur);
    }
    const paths = Array.from(pathsMap.values()).sort((a, b) => b.totalErrors - a.totalErrors);

    return { total, statuses, paths, raw: { vTotal, vOk, vByStatus, vByPath } } as any;
  }

  // 1) Exact
  const exactRes = await runOnce(exactMatcher);

  // Brak fallbacku: zawsze korzystamy z exact matchera, nawet jeśli dane są puste
  return {
    label: "HTTP",
    statuses: exactRes.statuses?.sort((a: StatusItem, b: StatusItem) => b.total - a.total),
    paths: exactRes.paths,
  };
}

/* =====================================================================================
 * API komponentu
 * ===================================================================================*/
export type EdgeFetcher = (ctx: {
  parent: ServiceNode | null;
  child: ServiceNode | null;
  edgeLabelsExact?: EdgeLabelsExact;
}) => Promise<ConnectionDetails | null>;

/**
 * Minimalne użycie:
 * <ConnectionDetailsModal
 *   open
 *   onClose={...}
 *   parent={p}
 *   child={c}
 *   prom={{ url: PROM_URL, systemEnv: "prod" }}
 *   edgeLabelsExact={{
 *     executableGroupName: "...",
 *     executableName: "...",
 *     executableVersion: "...",
 *     targetServiceName: "...",
 *     targetServiceVersion: "...",
 *     systemName: "prod"
 *   }}
 * />
 */
export default function ConnectionDetailsModal({
  open,
  onClose,
  parent,
  child,
  connection: connectionInitial,
  renderExtra,
  prom,
  buildDashboardUrl,
  fetchConnection,
  edgeLabelsExact,
}: {
  open: boolean;
  onClose: () => void;
  parent: ServiceNode | null;
  child: ServiceNode | null;
  connection?: ConnectionDetails;
  renderExtra?: (ctx: { parent: ServiceNode | null; child: ServiceNode | null }) => React.ReactNode;
  prom?: PromConfig;
  buildDashboardUrl?: (parent: ServiceNode, child: ServiceNode) => string | undefined;
  fetchConnection?: EdgeFetcher;
  edgeLabelsExact?: EdgeLabelsExact;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionDetails | undefined>(connectionInitial);

  const canAutoFetch = useMemo(
    () => open && !connectionInitial && parent && child && (fetchConnection || (prom && edgeLabelsExact)),
    [open, connectionInitial, parent, child, fetchConnection, prom, edgeLabelsExact]
  );

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!canAutoFetch) return;
      setLoading(true);
      setError(null);
      try {
        let conn: ConnectionDetails | null = null;
        if (fetchConnection) {
          conn = await fetchConnection({ parent, child, edgeLabelsExact });
        } else if (prom && edgeLabelsExact) {
          conn = await defaultFetchConnectionFromExact(prom, edgeLabelsExact);
        }
        if (cancelled) return;
        if (conn) {
          const url = parent && child ? buildDashboardUrl?.(parent, child) : undefined;
          setConnection({ ...conn, url: url ?? conn.url });
        } else {
          setConnection(undefined);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Nie udało się pobrać danych.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [canAutoFetch, fetchConnection, prom, parent, child, buildDashboardUrl, edgeLabelsExact]);

  useEffect(() => {
    setConnection(connectionInitial);
  }, [connectionInitial]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          {/* Card */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Szczegóły połączenia"
            className="absolute inset-x-0 mx-auto top-16 w-[90vw] max-w-[90vw] md:w-[80vw] md:max-w-[80vw]"
            initial={{ opacity: 0, y: 20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={{ duration: 0.18 }}
          >
            <div className="rounded-2xl bg-white shadow-xl ring-1 ring-black/5 overflow-hidden">
              <div className="flex items-start gap-3 p-4 border-b">
                <div className="flex items-center gap-2 text-sm text-neutral-600">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring ${statusToBadgeColor(parent?.status)}`}>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                    {parent?.name ?? "—"}
                  </span>
                  <LinkIcon className="h-4 w-4 text-neutral-400" />
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring ${statusToBadgeColor(child?.status)}`}>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                    {child?.name ?? "—"}
                  </span>
                </div>
                <button onClick={onClose} className="ml-auto rounded-full p-1 hover:bg-neutral-100" aria-label="Zamknij">
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* Body */}
              <div className="p-4 space-y-4">
                {/* Label */}
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-neutral-500">Label/typ połączenia:</span>
                  <span className="font-medium">{connection?.label ?? "—"}</span>
                </div>

                {/* Suma błędów (count) */}
                {connection?.statuses && connection.statuses.length > 0 && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-neutral-500">Suma błędów (w oknie):</span>
                    <span className="font-semibold">
                      {connection.statuses.reduce((acc, s) => acc + (s.total || 0), 0)}
                    </span>
                  </div>
                )}

                {/* Metadane */}
                {connection?.meta && (
                  <div>
                    <div className="text-xs text-neutral-500 mb-1">Metadane</div>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(connection.meta).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                          <span className="text-neutral-500">{k}</span>
                          <span className="font-medium ml-4 truncate" title={String(v)}>
                            {String(v)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* URL do dashboardu */}
                {connection?.url && (
                  <div className="flex items-center gap-3">
                    <a
                      href={connection.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-2 text-sm rounded-xl border px-3 py-1.5 hover:bg-neutral-50"
                    >
                      Otwórz dashboard <ExternalLink className="h-4 w-4" />
                    </a>
                    <a
                      href={connection.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-neutral-500 hover:underline inline-flex items-center gap-1"
                      title={connection.url}
                    >
                      {connection.url} <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                )}

                {/* Błędy wg statusu (counts) */}
                {connection?.statuses && connection.statuses.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs text-neutral-500">Statusy</div>
                    <div className="space-y-1.5">
                      {(() => {
                        const max = Math.max(...connection.statuses!.map((s) => s.total));
                        return connection.statuses!.map((s) => {
                          const pct = max > 0 ? Math.round((s.total / max) * 100) : 0;
                          return (
                            <div key={s.code} className="flex items-center gap-3">
                              <div className="w-16 text-right text-xs font-medium text-neutral-700">{s.code}</div>
                              <div className="flex-1 h-2 rounded-full bg-neutral-100 overflow-hidden">
                                <div className="h-full rounded-full bg-red-500" style={{ width: `${pct}%` }} />
                              </div>
                              <div className="w-28 text-right text-xs text-neutral-800">
                                <span className="font-semibold">{s.total}</span>
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}

                {/* Najgorsze ścieżki (URL) – counts tylko */}
                {connection?.paths && (
                  <div>
                    <div className="text-xs text-neutral-500 mb-1">Najgorsze ścieżki (URL)</div>
                    {connection.paths.length === 0 ? (
                      <div className="text-sm text-neutral-500">Brak danych o ścieżkach.</div>
                    ) : (
                      <div className="grid grid-cols-[minmax(0,1fr)_96px_1fr] gap-x-2 gap-y-2">
                        <div className="font-semibold text-sm">Path</div>
                        <div className="font-semibold text-sm text-right">Błędy</div>
                        <div className="font-semibold text-sm text-right">Statusy</div>

                        {connection.paths.slice(0, 200).map((r) => (
                          <React.Fragment key={r.path}>
                            <div className="text-sm text-neutral-800 break-words whitespace-pre-wrap" title={r.path}>
                              {r.path}
                            </div>
                            <div className="text-sm text-neutral-800 text-right">{r.totalErrors}</div>
                            <div className="flex flex-wrap gap-1 justify-end">
                              {Object.entries(r.byStatus)
                                .sort((a, b) => b[1] - a[1])
                                .map(([st, cnt]) => (
                                  <span
                                    key={st}
                                    className="inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] text-neutral-800"
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
                  </div>
                )}

                {/* Stany ładowania/błędu */}
                {loading && (
                  <div className="flex items-center gap-2 text-sm text-neutral-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Ładowanie danych…
                  </div>
                )}
                {error && <div className="text-sm text-red-600">{error}</div>}

                {/* Slot na dodatkowe szczegóły */}
                {renderExtra && <div className="pt-2 border-t">{renderExtra({ parent, child })}</div>}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}

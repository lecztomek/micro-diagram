import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink, Link as LinkIcon } from "lucide-react";

export type ServiceNode = {
  id: string;
  name: string;
  status?: "healthy" | "degraded" | "down";
  rpm?: number; // możesz przekazać też rps i przeliczyć wyżej
};

export type StatusItem = {
  code: string; // np. 500, 404, "unknown"
  total: number; // łączna liczba w oknie
  perMin?: number; // jeśli masz agregację /min – opcjonalne
};

export type ConnectionDetails = {
  /** opcjonalny opis/etykieta krawędzi (np. typ protokołu) */
  label?: string;
  /** przepływ – tu RPM (jeśli masz RPS zamień wcześniej na RPM) */
  rpm?: number;
  /** 0..1 */
  errorRate?: number;
  /** dodatkowe metadane – pokażemy w tabeli */
  meta?: Record<string, string | number | boolean | null | undefined>;
  /** link do dashboardu/alertów */
  url?: string;
  /** agregacja błędów wg statusów */
  statuses?: StatusItem[];
};

export function statusToBadgeColor(s?: ServiceNode["status"]) {
  switch (s) {
    case "down":
      return "bg-red-100 text-red-700 ring-red-200";
    case "degraded":
      return "bg-amber-100 text-amber-700 ring-amber-200";
    default:
      return "bg-emerald-100 text-emerald-700 ring-emerald-200";
  }
}

function errorRateBadgeColor(er?: number) {
  if (er == null || !isFinite(er)) return "bg-neutral-100 text-neutral-700 ring-neutral-200";
  if (er > 0.10) return "bg-red-100 text-red-700 ring-red-200";
  if (er > 0.05) return "bg-amber-100 text-amber-700 ring-amber-200";
  if (er > 0.01) return "bg-yellow-100 text-yellow-700 ring-yellow-200";
  return "bg-emerald-100 text-emerald-700 ring-emerald-200";
}

function fmtPct(er?: number) {
  if (er == null || !isFinite(er)) return "—";
  return `${(Math.max(0, Math.min(1, er)) * 100).toFixed(1)}%`;
}

/**
 * ConnectionDetailsModal
 *
 * Niewielki modal otwierany dla połączenia parent→child.
 * - Esc i klik w tło zamykają modal
 * - Animacje framer-motion
 * - Slot renderExtra do własnych detali
 */
export default function ConnectionDetailsModal({
  open,
  onClose,
  parent,
  child,
  connection,
  renderExtra,
}: {
  open: boolean;
  onClose: () => void;
  parent: ServiceNode | null;
  child: ServiceNode | null;
  connection?: ConnectionDetails;
  /** Opcjonalny slot na dodatkowe szczegóły */
  renderExtra?: (ctx: { parent: ServiceNode | null; child: ServiceNode | null }) => React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          {/* backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          {/* card */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Szczegóły połączenia"
            className="absolute inset-x-0 mx-auto top-16 w-full max-w-xl"
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
                <button
                  onClick={onClose}
                  className="ml-auto rounded-full p-1 hover:bg-neutral-100"
                  aria-label="Zamknij"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {/* body */}
              <div className="p-4 space-y-4">
                {/* Label */}
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-neutral-500">Label/typ połączenia:</span>
                  <span className="font-medium">{connection?.label ?? "—"}</span>
                </div>

                {/* RPM */}
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-neutral-500">RPM:</span>
                  <span className="font-medium">{connection?.rpm ?? child?.rpm ?? "—"}</span>
                </div>

                {/* Error rate */}
                <div className="flex items-center gap-3">
                  <div className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs ring ${errorRateBadgeColor(connection?.errorRate)}`}>
                    <span className="font-medium">Error rate</span>
                    <span className="font-semibold">{fmtPct(connection?.errorRate)}</span>
                  </div>
                  <div className="flex-1 h-2 rounded-full bg-neutral-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-red-500"
                      style={{ width: `${Math.min(100, Math.max(0, (connection?.errorRate ?? 0) * 100))}%` }}
                      title={fmtPct(connection?.errorRate)}
                    />
                  </div>
                </div>

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

                {/* Statusy */}
                {connection?.statuses && connection.statuses.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs text-neutral-500">Statusy</div>
                    <div className="space-y-1.5">
                      {(() => {
                        const max = Math.max(...connection.statuses!.map(s => s.total));
                        return connection.statuses!.map(s => {
                          const pct = max > 0 ? Math.round((s.total / max) * 100) : 0;
                          return (
                            <div key={s.code} className="flex items-center gap-3">
                              <div className="w-16 text-right text-xs font-medium text-neutral-700">{s.code}</div>
                              <div className="flex-1 h-2 rounded-full bg-neutral-100 overflow-hidden">
                                <div className="h-full rounded-full bg-red-500" style={{ width: `${pct}%` }} />
                              </div>
                              <div className="w-28 text-right text-xs text-neutral-700">
                                {typeof s.perMin === "number" ? (
                                  <span className="font-semibold">{Math.round(s.perMin)}/min</span>
                                ) : (
                                  <span className="font-semibold">{s.total}</span>
                                )}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  </div>
                )}

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

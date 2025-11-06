import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink, Link as LinkIcon } from "lucide-react";

export type ServiceNode = {
  id: string;
  name: string;
  status?: "healthy" | "degraded" | "down";
  rpm?: number;
};

export type ConnectionDetails = {
  /** opcjonalny opis/etykieta krawędzi (np. typ protokołu) */
  label?: string;
  /** przepływ (requests per minute) – jeśli masz */
  rpm?: number;
  /** dodatkowe metadane – pokażemy w tabeli */
  meta?: Record<string, string | number | boolean | null | undefined>;
  /** link do dashboardu/alertów */
  url?: string;
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

/**
 * ConnectionDetailsModal
 *
 * Niewielki modal otwierany dla połączenia parent→child.
 * - Esc i klik w tło zamykają modal
 * - Animacje framer-motion
 * - Dodatkowy slot na własny render detali połączenia
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
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-neutral-500">Label/typ połączenia:</span>
                  <span className="font-medium">{connection?.label ?? "—"}</span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-neutral-500">RPM:</span>
                  <span className="font-medium">{connection?.rpm ?? child?.rpm ?? "—"}</span>
                </div>

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

                {connection?.url && (
                  <a
                    href={connection.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 text-sm rounded-xl border px-3 py-1.5 hover:bg-neutral-50"
                  >
                    Otwórz dashboard <ExternalLink className="h-4 w-4" />
                  </a>
                )}

                {renderExtra && (
                  <div className="pt-2 border-t">{renderExtra({ parent, child })}</div>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body
  );
}

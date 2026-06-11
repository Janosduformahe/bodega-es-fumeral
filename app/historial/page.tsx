"use client";

import { useEffect, useMemo, useState } from "react";
import Tabs from "@/components/Tabs";
import { createClient } from "@/lib/supabase/client";
import { fmtFecha, type Movimiento } from "@/lib/types";

type MovConVino = Movimiento & {
  vinos: { bodega: string; nombre: string; anio: number | null } | null;
};

export default function HistorialPage() {
  const supabase = useMemo(() => createClient(), []);
  const [rows, setRows] = useState<MovConVino[] | null>(null);

  useEffect(() => {
    supabase
      .from("movimientos")
      .select("*, vinos(bodega, nombre, anio)")
      .order("created_at", { ascending: false })
      .limit(150)
      .then(({ data }) => setRows((data as MovConVino[]) || []));
  }, [supabase]);

  return (
    <>
      <Tabs />
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">Historial</div>
            <div className="page-sub">Últimos movimientos de toda la bodega</div>
          </div>
        </div>

        <div className="wine-list">
          {rows === null ? (
            <div className="empty">Cargando…</div>
          ) : rows.length === 0 ? (
            <div className="empty">Sin movimientos aún.</div>
          ) : (
            rows.map((h) => (
              <div className="wine-card" key={h.id}>
                <div className="wc-top">
                  <div className="wc-bodega">
                    {h.vinos
                      ? `${h.vinos.bodega} — ${h.vinos.nombre}${h.vinos.anio ? ` (${h.vinos.anio})` : ""}`
                      : `Vino #${h.vino_id}`}
                  </div>
                  <div className={`wc-stock ${h.qty < 0 ? "stock-zero" : "stock-ok"}`}>
                    {h.qty < 0 ? `−${-h.qty}` : `+${h.qty}`}
                  </div>
                </div>
                <div className="wc-meta">
                  {h.tipo} · {h.stock_prev}→{h.stock_nuevo} · {fmtFecha(h.created_at)}
                  {h.nota ? ` · ${h.nota}` : ""}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

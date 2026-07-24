"use client";

import { useEffect, useMemo, useState } from "react";
import Tabs from "@/components/Tabs";
import { IconWine } from "@/components/icons";
import { createClient } from "@/lib/supabase/client";
import type { Vino } from "@/lib/types";

type MovVenta = {
  vino_id: number;
  qty: number;
  created_at: string;
};

type Agregado = {
  vino: Vino;
  botellas: number;
  ingresos: number;
  beneficio: number | null; // null si no conocemos el coste
};

const PERIODOS = [
  { dias: 7, label: "7 días" },
  { dias: 30, label: "30 días" },
  { dias: 90, label: "90 días" },
  { dias: 0, label: "Todo" },
];

const eur = (n: number) =>
  n.toLocaleString("es-ES", { maximumFractionDigits: 0 }) + " €";

export default function VentasPage() {
  const supabase = useMemo(() => createClient(), []);
  const [dias, setDias] = useState(30);
  const [ventas, setVentas] = useState<MovVenta[] | null>(null);
  const [vinos, setVinos] = useState<Vino[]>([]);

  useEffect(() => {
    supabase
      .from("vinos")
      .select("*")
      .eq("activo", true)
      .then(({ data }) => setVinos((data as Vino[]) || []));
  }, [supabase]);

  useEffect(() => {
    setVentas(null);
    let q = supabase
      .from("movimientos")
      .select("vino_id, qty, created_at")
      .eq("tipo", "venta")
      .lt("qty", 0);
    if (dias > 0) {
      const desde = new Date(Date.now() - dias * 86400000).toISOString();
      q = q.gte("created_at", desde);
    }
    q.limit(5000).then(({ data }) => setVentas((data as MovVenta[]) || []));
  }, [supabase, dias]);

  const porId = useMemo(() => new Map(vinos.map((v) => [v.id, v])), [vinos]);

  const agregados = useMemo(() => {
    if (!ventas) return [];
    const mapa = new Map<number, Agregado>();
    for (const m of ventas) {
      const vino = porId.get(m.vino_id);
      if (!vino) continue;
      const botellas = -m.qty;
      const precio = Number(vino.precio) || 0;
      const coste = Number(vino.precio_compra) || 0;
      const prev = mapa.get(vino.id) ?? {
        vino,
        botellas: 0,
        ingresos: 0,
        beneficio: coste > 0 && precio > 0 ? 0 : null,
      };
      prev.botellas += botellas;
      prev.ingresos += botellas * precio;
      if (prev.beneficio !== null && coste > 0 && precio > 0) {
        prev.beneficio += botellas * (precio - coste);
      }
      mapa.set(vino.id, prev);
    }
    return [...mapa.values()];
  }, [ventas, porId]);

  const topBotellas = useMemo(
    () => [...agregados].sort((a, b) => b.botellas - a.botellas).slice(0, 10),
    [agregados]
  );
  const topBeneficio = useMemo(
    () =>
      agregados
        .filter((a) => a.beneficio !== null)
        .sort((a, b) => (b.beneficio ?? 0) - (a.beneficio ?? 0))
        .slice(0, 10),
    [agregados]
  );

  // Vinos con stock que no se han vendido en el periodo: dinero parado
  const sinRotacion = useMemo(() => {
    const vendidos = new Set(agregados.map((a) => a.vino.id));
    return vinos
      .filter((v) => v.stock > 0 && !vendidos.has(v.id))
      .map((v) => ({
        vino: v,
        valorCoste: v.stock * (Number(v.precio_compra) || 0),
        valorVenta: v.stock * (Number(v.precio) || 0),
      }))
      .sort((a, b) => (b.valorCoste || b.valorVenta) - (a.valorCoste || a.valorVenta))
      .slice(0, 10);
  }, [vinos, agregados]);

  const totBotellas = agregados.reduce((s, a) => s + a.botellas, 0);
  const totIngresos = agregados.reduce((s, a) => s + a.ingresos, 0);
  const conBeneficio = agregados.filter((a) => a.beneficio !== null);
  const totBeneficio = conBeneficio.reduce((s, a) => s + (a.beneficio ?? 0), 0);
  const cobertura =
    agregados.length > 0
      ? Math.round((conBeneficio.length / agregados.length) * 100)
      : 0;

  function FilaVino({
    pos,
    vino,
    principal,
    secundario,
  }: {
    pos: number;
    vino: Vino;
    principal: string;
    secundario: string;
  }) {
    return (
      <div className="an-row">
        <span className="an-pos">{pos}</span>
        <span className="an-text">
          <span className="an-name">
            {vino.bodega} — {vino.nombre}
            {vino.anio ? ` (${vino.anio})` : ""}
          </span>
          <span className="an-sub">{secundario}</span>
        </span>
        <span className="an-val">{principal}</span>
      </div>
    );
  }

  return (
    <>
      <Tabs />
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">Ventas</div>
            <div className="page-sub">
              Ingresos y beneficio estimados con los precios actuales de carta
            </div>
          </div>
        </div>

        <div className="chips-row" role="group" aria-label="Periodo">
          {PERIODOS.map((p) => (
            <button
              key={p.dias}
              className={`chip${dias === p.dias ? " on" : ""}`}
              style={{ "--dotc": "var(--brand)" } as React.CSSProperties}
              onClick={() => setDias(p.dias)}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="stats-grid">
          <div className="stat">
            <div className="stat-label">Botellas vendidas</div>
            <div className="stat-value">{totBotellas}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Ingresos</div>
            <div className="stat-value">{eur(totIngresos)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Beneficio</div>
            <div className="stat-value" style={{ color: "var(--green)" }}>
              {eur(totBeneficio)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Con coste conocido</div>
            <div className="stat-value">{cobertura}%</div>
          </div>
        </div>

        {ventas === null ? (
          <div className="empty">Cargando ventas…</div>
        ) : agregados.length === 0 ? (
          <div className="empty">
            <IconWine size={40} strokeWidth={1.25} />
            <em>Sin ventas registradas en este periodo</em>
          </div>
        ) : (
          <>
            <div className="section-hdr">
              <span className="section-hdr-label">Más vendidos (botellas)</span>
            </div>
            <div className="an-card">
              {topBotellas.map((a, i) => (
                <FilaVino
                  key={a.vino.id}
                  pos={i + 1}
                  vino={a.vino}
                  principal={`${a.botellas} bot.`}
                  secundario={`${eur(a.ingresos)} ingresos${
                    a.beneficio !== null ? ` · ${eur(a.beneficio)} beneficio` : ""
                  }`}
                />
              ))}
            </div>

            {topBeneficio.length > 0 && (
              <>
                <div className="section-hdr">
                  <span className="section-hdr-label">Más beneficio</span>
                </div>
                <div className="an-card">
                  {topBeneficio.map((a, i) => (
                    <FilaVino
                      key={a.vino.id}
                      pos={i + 1}
                      vino={a.vino}
                      principal={eur(a.beneficio ?? 0)}
                      secundario={`${a.botellas} bot. · margen ${
                        a.vino.precio_compra
                          ? `${eur(Number(a.vino.precio) - Number(a.vino.precio_compra))}/bot.`
                          : "—"
                      }`}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {sinRotacion.length > 0 && ventas !== null && (
          <>
            <div className="section-hdr">
              <span className="section-hdr-label">
                Sin rotación en el periodo (dinero parado)
              </span>
            </div>
            <div className="an-card">
              {sinRotacion.map((s, i) => (
                <FilaVino
                  key={s.vino.id}
                  pos={i + 1}
                  vino={s.vino}
                  principal={
                    s.valorCoste > 0 ? eur(s.valorCoste) : eur(s.valorVenta)
                  }
                  secundario={`${s.vino.stock} bot. paradas${
                    s.valorCoste > 0 ? " · a precio de coste" : " · a precio de carta"
                  }`}
                />
              ))}
            </div>
          </>
        )}

        <div className="an-nota">
          Nota: ingresos y beneficio se estiman con el precio de carta y el coste
          actuales de cada vino. El % de cobertura indica cuántas referencias
          vendidas tienen coste conocido.
        </div>
      </div>
    </>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Tabs from "@/components/Tabs";
import { IconWine } from "@/components/icons";
import { SubNav } from "@/components/analisis";
import { createClient } from "@/lib/supabase/client";
import type { Vino } from "@/lib/types";

type VentaRow = {
  vino_id: number;
  qty: number;
  tipo: string;
  created_at: string;
  precio_unit: number | null;
  coste_unit: number | null;
};

type Grupo = {
  clave: string;
  etiqueta: string;
  sub?: string;
  botellas: number;
  ingresos: number;
  beneficio: number;
  conCoste: number; // botellas con coste conocido
};

const PERIODOS = [
  { dias: 7, label: "7 días" },
  { dias: 30, label: "30 días" },
  { dias: 90, label: "90 días" },
  { dias: 0, label: "Todo" },
];

const MEDIDAS = [
  { key: "botellas" as const, label: "Botellas" },
  { key: "ingresos" as const, label: "Ingresos" },
  { key: "beneficio" as const, label: "Beneficio" },
];
type Medida = (typeof MEDIDAS)[number]["key"];

const eur = (n: number) =>
  n.toLocaleString("es-ES", { maximumFractionDigits: 0 }) + " €";
const num = (n: number) => n.toLocaleString("es-ES");

export default function VentasPage() {
  const supabase = useMemo(() => createClient(), []);
  const [dias, setDias] = useState(30);
  const [medida, setMedida] = useState<Medida>("botellas");
  // Las ventas reales son las del TPV (y las marcadas a mano). Las bajadas que
  // salen al importar un inventario NO son ventas: son el cuadre entre lo que
  // decía la app y lo que había en la estantería. Antes de conectar Hiopos eran
  // el único proxy de consumo y venían activadas; ahora sumarlas al mismo
  // periodo cuenta lo mismo dos veces, así que van apagadas por defecto.
  const [conAjustes, setConAjustes] = useState(false);
  const [ventas, setVentas] = useState<VentaRow[] | null>(null);
  const [vinos, setVinos] = useState<Vino[]>([]);

  useEffect(() => {
    supabase
      .from("vinos")
      .select("*")
      .eq("activo", true)
      .then(({ data }) => setVinos((data as Vino[]) || []));
  }, [supabase]);

  useEffect(() => {
    let cancelado = false;
    let q = supabase
      .from("movimientos")
      .select("vino_id, qty, tipo, created_at, precio_unit, coste_unit")
      .lt("qty", 0);
    if (!conAjustes) q = q.eq("tipo", "venta");
    if (dias > 0) {
      q = q.gte("created_at", new Date(Date.now() - dias * 86400000).toISOString());
    }
    q.limit(10000).then(({ data }) => {
      if (!cancelado) setVentas((data as VentaRow[]) || []);
    });
    return () => {
      cancelado = true;
    };
  }, [supabase, dias, conAjustes]);

  const porId = useMemo(() => new Map(vinos.map((v) => [v.id, v])), [vinos]);

  /** Agrega las ventas por una dimensión del vino */
  function agrupar(
    clavePor: (v: Vino) => { clave: string; etiqueta: string; sub?: string } | null
  ): Grupo[] {
    if (!ventas) return [];
    const mapa = new Map<string, Grupo>();
    for (const m of ventas) {
      const vino = porId.get(m.vino_id);
      if (!vino) continue;
      const k = clavePor(vino);
      if (!k) continue;
      const botellas = -m.qty;
      // Precio del momento de la venta (snapshot); si falta, el actual
      const pv = Number(m.precio_unit ?? vino.precio) || 0;
      const pc = Number(m.coste_unit ?? vino.precio_compra ?? 0) || 0;
      const g =
        mapa.get(k.clave) ??
        ({ ...k, botellas: 0, ingresos: 0, beneficio: 0, conCoste: 0 } as Grupo);
      g.botellas += botellas;
      g.ingresos += botellas * pv;
      if (pc > 0 && pv > 0) {
        g.beneficio += botellas * (pv - pc);
        g.conCoste += botellas;
      }
      mapa.set(k.clave, g);
    }
    return [...mapa.values()];
  }

  const porReferencia = useMemo(
    () =>
      agrupar((v) => ({
        clave: String(v.id),
        etiqueta: `${v.bodega} — ${v.nombre}`,
        sub: [v.anio ?? "", v.tipo, v.proveedor ?? ""].filter(Boolean).join(" · "),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ventas, porId]
  );
  const porProveedor = useMemo(
    () =>
      agrupar((v) => ({
        clave: v.proveedor?.trim() || "—",
        etiqueta: v.proveedor?.trim() || "Sin proveedor",
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ventas, porId]
  );
  const porTipo = useMemo(
    () => agrupar((v) => ({ clave: v.tipo, etiqueta: v.tipo })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ventas, porId]
  );
  const porPais = useMemo(
    () => agrupar((v) => ({ clave: v.pais, etiqueta: v.pais })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ventas, porId]
  );

  const valor = (g: Grupo) =>
    medida === "botellas" ? g.botellas : medida === "ingresos" ? g.ingresos : g.beneficio;
  const fmt = (n: number) => (medida === "botellas" ? `${num(n)} bot.` : eur(n));

  const totBotellas = porReferencia.reduce((s, g) => s + g.botellas, 0);
  const totIngresos = porReferencia.reduce((s, g) => s + g.ingresos, 0);
  const totBeneficio = porReferencia.reduce((s, g) => s + g.beneficio, 0);
  const margenMedio = totIngresos > 0 ? Math.round((totBeneficio / totIngresos) * 100) : 0;

  // Vinos con stock que no han vendido nada en el periodo
  const sinRotacion = useMemo(() => {
    const vendidos = new Set(porReferencia.map((g) => Number(g.clave)));
    return vinos
      .filter((v) => v.stock > 0 && !vendidos.has(v.id))
      .map((v) => ({
        vino: v,
        inmovilizado: v.stock * (Number(v.precio_compra) || Number(v.precio) || 0),
        aCoste: (Number(v.precio_compra) || 0) > 0,
      }))
      .sort((a, b) => b.inmovilizado - a.inmovilizado)
      .slice(0, 12);
  }, [vinos, porReferencia]);

  function Ranking({
    titulo,
    grupos,
    limite = 8,
  }: {
    titulo: string;
    grupos: Grupo[];
    limite?: number;
  }) {
    const orden = [...grupos].sort((a, b) => valor(b) - valor(a)).slice(0, limite);
    const max = Math.max(...orden.map(valor), 1);
    if (!orden.length) return null;
    return (
      <>
        <div className="section-hdr">
          <span className="section-hdr-label">{titulo}</span>
          <span className="section-hdr-count">
            {medida === "botellas" ? "botellas" : medida === "ingresos" ? "ingresos" : "beneficio"}
          </span>
        </div>
        <div className="an-card">
          {orden.map((g) => {
            const v = valor(g);
            const margen = g.ingresos > 0 ? Math.round((g.beneficio / g.ingresos) * 100) : null;
            return (
              <div
                className="bar-row"
                key={g.clave}
                title={`${g.etiqueta}: ${num(g.botellas)} botellas · ${eur(g.ingresos)} ingresos · ${eur(g.beneficio)} beneficio`}
              >
                <div className="bar-top">
                  <span className="bar-label">{g.etiqueta}</span>
                  <span className="bar-value">{fmt(v)}</span>
                </div>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${Math.max(2, (v / max) * 100)}%` }}
                  />
                </div>
                <div className="bar-sub">
                  {g.sub ? `${g.sub} · ` : ""}
                  {num(g.botellas)} bot. · {eur(g.ingresos)}
                  {margen !== null && g.beneficio > 0 ? ` · margen ${margen}%` : ""}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <>
      <Tabs />
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">Análisis</div>
            <div className="page-sub">Rotación, ingresos y margen por referencia</div>
          </div>
        </div>
        <SubNav />

        {/* Una sola fila de filtros que afecta a todo el panel */}
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
        <div className="chips-row" role="group" aria-label="Medida y origen">
          {MEDIDAS.map((m) => (
            <button
              key={m.key}
              className={`chip${medida === m.key ? " on" : ""}`}
              style={{ "--dotc": "var(--ink)" } as React.CSSProperties}
              onClick={() => setMedida(m.key)}
            >
              {m.label}
            </button>
          ))}
          <button
            className={`chip chip-toggle${conAjustes ? " on" : ""}`}
            style={{ "--dotc": "var(--muted2)" } as React.CSSProperties}
            aria-pressed={conAjustes}
            onClick={() => setConAjustes((c) => !c)}
            title="Sumar también los descuadres de los inventarios. No son ventas: es la diferencia entre lo que decía la app y lo que se contó en la estantería."
          >
            {conAjustes ? "✓ " : "+ "}Descuadres de inventario
          </button>
        </div>

        <div className="stats-grid">
          <div className="stat">
            <div className="stat-label">
              {conAjustes ? "Botellas salidas" : "Botellas vendidas"}
            </div>
            <div className="stat-value figura">{num(totBotellas)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Ingresos</div>
            <div className="stat-value figura">{eur(totIngresos)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Beneficio</div>
            <div className="stat-value figura" style={{ color: "var(--green)" }}>
              {eur(totBeneficio)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Margen medio</div>
            <div className="stat-value figura">{margenMedio}%</div>
          </div>
        </div>

        {ventas === null ? (
          <div className="empty">Cargando ventas…</div>
        ) : porReferencia.length === 0 ? (
          <div className="empty">
            <IconWine size={40} strokeWidth={1.25} />
            <em>Sin movimientos de salida en este periodo</em>
            <div style={{ fontSize: 13, marginTop: 8, color: "var(--hint)" }}>
              Prueba con un periodo más amplio o activa los ajustes de inventario.
            </div>
          </div>
        ) : (
          <>
            <Ranking titulo="Top referencias" grupos={porReferencia} limite={10} />
            <Ranking titulo="Por proveedor" grupos={porProveedor} />
            <Ranking titulo="Por tipo de vino" grupos={porTipo} />
            <Ranking titulo="Por país" grupos={porPais} limite={6} />
          </>
        )}

        {sinRotacion.length > 0 && ventas !== null && (
          <>
            <div className="section-hdr">
              <span className="section-hdr-label">Sin rotación · dinero parado</span>
              <span className="section-hdr-count">valor inmovilizado</span>
            </div>
            <div className="an-card">
              {sinRotacion.map((s) => (
                <div className="an-row" key={s.vino.id}>
                  <span className="an-text">
                    <span className="an-name">
                      {s.vino.bodega} — {s.vino.nombre}
                      {s.vino.anio ? ` (${s.vino.anio})` : ""}
                    </span>
                    <span className="an-sub">
                      {s.vino.stock} bot. paradas ·{" "}
                      {s.aCoste ? "a precio de coste" : "a precio de carta"}
                      {s.vino.proveedor ? ` · ${s.vino.proveedor}` : ""}
                    </span>
                  </span>
                  <span className="an-val">{eur(s.inmovilizado)}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="an-nota">
          {conAjustes
            ? "⚠ Estás sumando los descuadres de los inventarios, que NO son ventas: son la diferencia entre lo que decía la app y lo que se contó. Si el periodo coincide con ventas ya descargadas del TPV, lo mismo se cuenta dos veces. "
            : "Ventas reales: las del TPV de Hiopos más las marcadas a mano. "}
          Cada movimiento guarda el precio y el coste del momento, así que los
          importes son históricos y no cambian al retocar la carta. Lo que no
          tiene coste conocido suma en ingresos pero no en beneficio.
        </div>
      </div>
    </>
  );
}

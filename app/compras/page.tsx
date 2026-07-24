"use client";

import { useEffect, useMemo, useState } from "react";
import Tabs from "@/components/Tabs";
import { IconPackage } from "@/components/icons";
import { Ranking, SubNav, eur, num, type Grupo } from "@/components/analisis";
import { createClient } from "@/lib/supabase/client";
import type { Vino } from "@/lib/types";

type EntradaRow = {
  vino_id: number;
  qty: number;
  tipo: string;
  created_at: string;
  precio_unit: number | null;
  coste_unit: number | null;
};

const PERIODOS = [
  { dias: 30, label: "30 días" },
  { dias: 90, label: "90 días" },
  { dias: 365, label: "1 año" },
  { dias: 0, label: "Todo" },
];

const MEDIDAS = [
  { key: "botellas" as const, label: "Botellas" },
  { key: "gasto" as const, label: "Gasto" },
];
type Medida = (typeof MEDIDAS)[number]["key"];

export default function ComprasPage() {
  const supabase = useMemo(() => createClient(), []);
  const [dias, setDias] = useState(90);
  const [medida, setMedida] = useState<Medida>("gasto");
  const [conAjustes, setConAjustes] = useState(true);
  const [entradas, setEntradas] = useState<EntradaRow[] | null>(null);
  const [vinos, setVinos] = useState<Vino[]>([]);
  const [thresh, setThresh] = useState(1);
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    supabase
      .from("vinos")
      .select("*")
      .eq("activo", true)
      .then(({ data }) => setVinos((data as Vino[]) || []));
    supabase
      .from("ajustes")
      .select("valor")
      .eq("clave", "umbral_stock_bajo")
      .single()
      .then(({ data }) => data && setThresh(Number(data.valor) || 1));
  }, [supabase]);

  useEffect(() => {
    let cancelado = false;
    let q = supabase
      .from("movimientos")
      .select("vino_id, qty, tipo, created_at, precio_unit, coste_unit")
      .gt("qty", 0);
    if (!conAjustes) q = q.eq("tipo", "entrada");
    if (dias > 0) {
      q = q.gte("created_at", new Date(Date.now() - dias * 86400000).toISOString());
    }
    q.limit(10000).then(({ data }) => {
      if (!cancelado) setEntradas((data as EntradaRow[]) || []);
    });
    return () => {
      cancelado = true;
    };
  }, [supabase, dias, conAjustes]);

  const porId = useMemo(() => new Map(vinos.map((v) => [v.id, v])), [vinos]);

  function agrupar(
    clavePor: (v: Vino) => { clave: string; etiqueta: string; sub?: string } | null
  ): Grupo[] {
    if (!entradas) return [];
    const mapa = new Map<string, Grupo>();
    for (const m of entradas) {
      const vino = porId.get(m.vino_id);
      if (!vino) continue;
      const k = clavePor(vino);
      if (!k) continue;
      const botellas = m.qty;
      const pc = Number(m.coste_unit ?? vino.precio_compra ?? 0) || 0;
      const g =
        mapa.get(k.clave) ??
        ({ ...k, botellas: 0, importe: 0, beneficio: 0, conCoste: 0 } as Grupo);
      g.botellas += botellas;
      g.importe += botellas * pc;
      if (pc > 0) g.conCoste += botellas;
      mapa.set(k.clave, g);
    }
    return [...mapa.values()];
  }

  const deps = [entradas, porId];
  /* eslint-disable react-hooks/exhaustive-deps */
  const porProveedor = useMemo(
    () =>
      agrupar((v) => ({
        clave: v.proveedor?.trim() || "—",
        etiqueta: v.proveedor?.trim() || "Sin proveedor",
      })),
    deps
  );
  const porReferencia = useMemo(
    () =>
      agrupar((v) => ({
        clave: String(v.id),
        etiqueta: `${v.bodega} — ${v.nombre}`,
        sub: [v.anio ?? "", v.tipo, v.proveedor ?? ""].filter(Boolean).join(" · "),
      })),
    deps
  );
  const porTipo = useMemo(() => agrupar((v) => ({ clave: v.tipo, etiqueta: v.tipo })), deps);
  /* eslint-enable react-hooks/exhaustive-deps */

  const valor = (g: Grupo) => (medida === "botellas" ? g.botellas : g.importe);
  const fmt = (n: number) => (medida === "botellas" ? `${num(n)} bot.` : eur(n));
  const detalle = (g: Grupo) =>
    `${num(g.botellas)} bot. · ${eur(g.importe)}${
      g.botellas > 0 && g.importe > 0
        ? ` · ${eur(Math.round(g.importe / g.botellas))}/bot.`
        : ""
    }`;

  const totBotellas = porReferencia.reduce((s, g) => s + g.botellas, 0);
  const totGasto = porReferencia.reduce((s, g) => s + g.importe, 0);
  const costeMedio = totBotellas > 0 ? Math.round(totGasto / totBotellas) : 0;

  // Dinero inmovilizado hoy, por proveedor (stock actual × coste)
  const inmovilizado = useMemo(() => {
    const mapa = new Map<string, { etiqueta: string; valor: number; bot: number }>();
    for (const v of vinos) {
      if (v.stock <= 0) continue;
      const coste = Number(v.precio_compra) || 0;
      if (coste <= 0) continue;
      const k = v.proveedor?.trim() || "Sin proveedor";
      const g = mapa.get(k) ?? { etiqueta: k, valor: 0, bot: 0 };
      g.valor += v.stock * coste;
      g.bot += v.stock;
      mapa.set(k, g);
    }
    return [...mapa.values()].sort((a, b) => b.valor - a.valor);
  }, [vinos]);
  const totalInmovilizado = inmovilizado.reduce((s, g) => s + g.valor, 0);

  // Lista de reposición: bajo umbral o agotados, agrupada por proveedor
  const reponer = useMemo(() => {
    const mapa = new Map<string, Vino[]>();
    for (const v of vinos) {
      if (v.stock > thresh) continue;
      // Solo tiene sentido reponer lo que se ofrece o se ha vendido
      const k = v.proveedor?.trim() || "Sin proveedor";
      if (!mapa.has(k)) mapa.set(k, []);
      mapa.get(k)!.push(v);
    }
    return [...mapa.entries()]
      .map(([prov, lista]) => ({
        prov,
        lista: lista.sort((a, b) => a.stock - b.stock),
      }))
      .sort((a, b) => b.lista.length - a.lista.length);
  }, [vinos, thresh]);

  const reponerEnCarta = useMemo(
    () =>
      reponer
        .map((g) => ({ ...g, lista: g.lista.filter((v) => v.en_carta) }))
        .filter((g) => g.lista.length),
    [reponer]
  );
  const hayCarta = vinos.some((v) => v.en_carta);
  const listaPedido = hayCarta ? reponerEnCarta : reponer;

  function copiarPedido() {
    const texto = listaPedido
      .map(
        (g) =>
          `${g.prov}\n` +
          g.lista
            .map(
              (v) =>
                `  · ${v.bodega} — ${v.nombre}${v.anio ? ` (${v.anio})` : ""}: quedan ${v.stock}`
            )
            .join("\n")
      )
      .join("\n\n");
    navigator.clipboard?.writeText(`Reposición de bodega\n\n${texto}`).then(() => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    });
  }

  return (
    <>
      <Tabs />
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">Análisis</div>
            <div className="page-sub">Gasto por proveedor y reposición</div>
          </div>
        </div>
        <SubNav />

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
            title="Incluir las subidas de stock registradas en los inventarios, no solo los albaranes"
          >
            {conAjustes ? "✓ " : "+ "}Ajustes de inventario
          </button>
        </div>

        <div className="stats-grid">
          <div className="stat">
            <div className="stat-label">Botellas entradas</div>
            <div className="stat-value figura">{num(totBotellas)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Gasto</div>
            <div className="stat-value figura">{eur(totGasto)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Coste medio</div>
            <div className="stat-value figura">{eur(costeMedio)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Proveedores</div>
            <div className="stat-value figura">
              {porProveedor.filter((g) => g.clave !== "—").length}
            </div>
          </div>
        </div>

        {entradas === null ? (
          <div className="empty">Cargando compras…</div>
        ) : porReferencia.length === 0 ? (
          <div className="empty">
            <IconPackage size={40} strokeWidth={1.25} />
            <em>Sin entradas en este periodo</em>
            <div style={{ fontSize: 13, marginTop: 8, color: "var(--hint)" }}>
              Se llena con los albaranes y las subidas de stock del inventario.
            </div>
          </div>
        ) : (
          <>
            <Ranking
              titulo="Gasto por proveedor"
              nota={medida === "gasto" ? "coste" : "botellas"}
              grupos={porProveedor}
              valor={valor}
              fmt={fmt}
              detalle={detalle}
            />
            <Ranking
              titulo="Referencias más compradas"
              grupos={porReferencia}
              valor={valor}
              fmt={fmt}
              detalle={detalle}
              limite={10}
            />
            <Ranking
              titulo="Por tipo de vino"
              grupos={porTipo}
              valor={valor}
              fmt={fmt}
              detalle={detalle}
              limite={5}
            />
          </>
        )}

        {inmovilizado.length > 0 && (
          <>
            <div className="section-hdr">
              <span className="section-hdr-label">Valor en bodega ahora mismo</span>
              <span className="section-hdr-count">{eur(totalInmovilizado)} a coste</span>
            </div>
            <div className="an-card">
              {inmovilizado.slice(0, 8).map((g) => (
                <div className="an-row" key={g.etiqueta}>
                  <span className="an-text">
                    <span className="an-name">{g.etiqueta}</span>
                    <span className="an-sub">{g.bot} botellas en stock</span>
                  </span>
                  <span className="an-val">{eur(g.valor)}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {listaPedido.length > 0 && (
          <>
            <div className="section-hdr">
              <span className="section-hdr-label">
                Para reponer {hayCarta ? "(solo lo que está en carta)" : ""}
              </span>
              <span className="section-hdr-count">≤{thresh} bot.</span>
            </div>
            <div className="an-card">
              {listaPedido.map((g) => (
                <div className="pedido-grupo" key={g.prov}>
                  <div className="pedido-prov">
                    {g.prov}
                    <span className="pedido-count">{g.lista.length}</span>
                  </div>
                  {g.lista.slice(0, 6).map((v) => (
                    <div className="pedido-item" key={v.id}>
                      <span className="pedido-vino">
                        {v.bodega} — {v.nombre}
                        {v.anio ? ` (${v.anio})` : ""}
                      </span>
                      <span className={`pedido-stock${v.stock === 0 ? " cero" : ""}`}>
                        {v.stock}
                      </span>
                    </div>
                  ))}
                  {g.lista.length > 6 && (
                    <div className="pedido-item pedido-mas">
                      y {g.lista.length - 6} más…
                    </div>
                  )}
                </div>
              ))}
            </div>
            <button className="btn-copiar" onClick={copiarPedido}>
              {copiado ? "✓ Copiado al portapapeles" : "Copiar lista de reposición"}
            </button>
          </>
        )}

        <div className="an-nota">
          El gasto usa el coste de compra del momento de cada entrada. &quot;Valor en
          bodega&quot; es el stock actual valorado a precio de coste, solo de las
          referencias con coste conocido.
        </div>
      </div>
    </>
  );
}

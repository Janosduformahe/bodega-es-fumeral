"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type Grupo = {
  clave: string;
  etiqueta: string;
  sub?: string;
  botellas: number;
  importe: number; // ingresos (ventas) o gasto (compras)
  beneficio: number;
  conCoste: number;
};

export const eur = (n: number) =>
  n.toLocaleString("es-ES", { maximumFractionDigits: 0 }) + " €";
export const num = (n: number) => n.toLocaleString("es-ES");

/** Sub-navegación entre los dos paneles de análisis */
export function SubNav() {
  const pathname = usePathname();
  return (
    <div className="subnav">
      <Link href="/ventas" className={`subnav-item${pathname === "/ventas" ? " on" : ""}`}>
        Ventas
      </Link>
      <Link href="/compras" className={`subnav-item${pathname === "/compras" ? " on" : ""}`}>
        Compras
      </Link>
    </div>
  );
}

/** Ranking de magnitud: barras de un solo tono, valor en la punta */
export function Ranking({
  titulo,
  nota,
  grupos,
  valor,
  fmt,
  limite = 8,
  detalle,
}: {
  titulo: string;
  nota?: string;
  grupos: Grupo[];
  valor: (g: Grupo) => number;
  fmt: (n: number) => string;
  limite?: number;
  detalle: (g: Grupo) => string;
}) {
  const orden = [...grupos].sort((a, b) => valor(b) - valor(a)).slice(0, limite);
  const max = Math.max(...orden.map(valor), 1);
  if (!orden.length) return null;
  return (
    <>
      <div className="section-hdr">
        <span className="section-hdr-label">{titulo}</span>
        {nota && <span className="section-hdr-count">{nota}</span>}
      </div>
      <div className="an-card">
        {orden.map((g) => {
          const v = valor(g);
          return (
            <div className="bar-row" key={g.clave} title={`${g.etiqueta}: ${detalle(g)}`}>
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
                {detalle(g)}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Tabs from "@/components/Tabs";
import {
  IconCheck,
  IconChevronDown,
  IconClock,
  IconSearch,
  IconSliders,
  IconWine,
  IconX,
} from "@/components/icons";
import { createClient } from "@/lib/supabase/client";
import {
  fmtFecha,
  nombreVino,
  type Movimiento,
  type TipoVino,
  type Vino,
} from "@/lib/types";

const TIPOS: TipoVino[] = ["Espumoso", "Blanco", "Rosado", "Tinto", "Dulce"];
const TIPO_DOT: Record<TipoVino, string> = {
  Tinto: "var(--w-tinto)",
  Blanco: "var(--w-blanco)",
  Rosado: "var(--w-rosado)",
  Espumoso: "var(--w-espumoso)",
  Dulce: "var(--w-dulce)",
};
const ORDENES: { v: string; label: string }[] = [
  { v: "bodega", label: "Por bodega (A–Z)" },
  { v: "stock", label: "Stock: menos primero" },
  { v: "stock_desc", label: "Stock: más primero" },
  { v: "precio", label: "Precio: más caro primero" },
  { v: "anio", label: "Añada: más reciente primero" },
];

const sc = (s: number, t: number) =>
  s === 0 ? "stock-zero" : s <= t ? "stock-low" : "stock-ok";

/** Fila de alerta: desliza hacia el lado (o ×) para descartar */
function AlertRow({ vino, onDismiss }: { vino: Vino; onDismiss: () => void }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const startX = useRef<number | null>(null);

  function dismiss() {
    setLeaving(true);
    setTimeout(onDismiss, 220);
  }

  return (
    <div className="alert-track">
      <span className="alert-track-check" aria-hidden="true">
        <IconCheck size={16} /> Visto
      </span>
      <div
        className={`alert-row${vino.stock === 1 ? " critical" : ""}${dragging ? " dragging" : ""}${leaving ? " leaving" : ""}`}
        style={{
          transform: `translateX(${dx}px)`,
          opacity: leaving ? 0 : 1 - Math.min(Math.abs(dx) / 220, 0.5),
        }}
        onPointerDown={(e) => {
          startX.current = e.clientX;
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (startX.current === null) return;
          setDx(e.clientX - startX.current);
        }}
        onPointerUp={() => {
          setDragging(false);
          startX.current = null;
          if (Math.abs(dx) > 72) dismiss();
          else setDx(0);
        }}
        onPointerCancel={() => {
          setDragging(false);
          startX.current = null;
          setDx(0);
        }}
      >
        <span className="ar-qty">{vino.stock}</span>
        <span className="ar-text">
          <span className="ar-name">{vino.bodega}</span>
          <span className="ar-sub">
            {vino.nombre}
            {vino.anio ? ` · ${vino.anio}` : ""}
          </span>
        </span>
        <button
          className="ac-x"
          aria-label={`Descartar alerta de ${vino.bodega} ${vino.nombre}`}
          onClick={dismiss}
        >
          <IconX size={15} />
        </button>
      </div>
    </div>
  );
}

export default function InventarioPage() {
  const supabase = useMemo(() => createClient(), []);
  const [wines, setWines] = useState<Vino[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [thresh, setThresh] = useState(1);
  const [mult, setMult] = useState(1.8);
  const [showSettings, setShowSettings] = useState(false);
  const [dismissed, setDismissed] = useState<Record<string, number>>({});
  const [alertsOpen, setAlertsOpen] = useState(false);

  const [q, setQ] = useState("");
  const [filtTipo, setFiltTipo] = useState("");
  const [filtPais, setFiltPais] = useState("");
  const [filtStock, setFiltStock] = useState("");
  const [sortBy, setSortBy] = useState("bodega");
  const [sheet, setSheet] = useState<null | "filtros">(null);

  const [modal, setModal] = useState<{ mode: "venta" | "entrada"; vino: Vino } | null>(null);
  const [mQty, setMQty] = useState("1");
  const [mNote, setMNote] = useState("");
  const [saving, setSaving] = useState(false);
  const qtyRef = useRef<HTMLInputElement>(null);

  const [histVino, setHistVino] = useState<Vino | null>(null);
  const [histRows, setHistRows] = useState<Movimiento[] | null>(null);

  const loadWines = useCallback(async () => {
    const { data } = await supabase
      .from("vinos")
      .select("*")
      .eq("activo", true)
      .order("bodega");
    if (data) setWines(data as Vino[]);
    setLoaded(true);
  }, [supabase]);

  useEffect(() => {
    loadWines();
    supabase
      .from("ajustes")
      .select("clave, valor")
      .then(({ data }) => {
        for (const a of data ?? []) {
          if (a.clave === "umbral_stock_bajo") setThresh(Number(a.valor));
          if (a.clave === "multiplicador_precio") setMult(Number(a.valor) || 1.8);
          if (a.clave === "alertas_descartadas")
            setDismissed((a.valor as Record<string, number>) ?? {});
        }
      });

    const channel = supabase
      .channel("vinos-cambios")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "vinos" },
        (payload) => {
          if (payload.eventType === "UPDATE") {
            const v = payload.new as Vino;
            setWines((prev) => prev.map((w) => (w.id === v.id ? v : w)));
          } else if (payload.eventType === "INSERT") {
            const v = payload.new as Vino;
            setWines((prev) =>
              [...prev, v].sort((a, b) => a.bodega.localeCompare(b.bodega))
            );
          }
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, loadWines]);

  useEffect(() => {
    if (modal) setTimeout(() => qtyRef.current?.focus(), 100);
  }, [modal]);

  async function updateThresh(v: number) {
    setThresh(v);
    await supabase.from("ajustes").update({ valor: v }).eq("clave", "umbral_stock_bajo");
  }

  async function updateMult(v: number) {
    setMult(v);
    if (v >= 1 && v <= 5) {
      await supabase
        .from("ajustes")
        .update({ valor: v })
        .eq("clave", "multiplicador_precio");
    }
  }

  async function dismissAlert(vino: Vino) {
    const next = { ...dismissed, [vino.id]: vino.stock };
    setDismissed(next);
    await supabase.from("ajustes").update({ valor: next }).eq("clave", "alertas_descartadas");
  }

  async function confirmMovimiento() {
    if (!modal) return;
    const qty = parseInt(mQty) || 0;
    if (qty <= 0) return;
    if (modal.mode === "venta" && qty > modal.vino.stock) {
      alert(`Solo hay ${modal.vino.stock} botellas`);
      return;
    }
    setSaving(true);
    const { data, error } = await supabase.rpc("registrar_movimiento", {
      p_vino_id: modal.vino.id,
      p_tipo: modal.mode,
      p_qty: modal.mode === "venta" ? -qty : qty,
      p_nota: mNote.trim() || null,
    });
    setSaving(false);
    if (error) {
      alert("Error: " + error.message);
      return;
    }
    if (typeof navigator !== "undefined") navigator.vibrate?.(10);
    const v = data as Vino;
    setWines((prev) => prev.map((w) => (w.id === v.id ? v : w)));
    setModal(null);
    setMQty("1");
    setMNote("");
  }

  async function openHist(vino: Vino) {
    setHistVino(vino);
    setHistRows(null);
    const { data } = await supabase
      .from("movimientos")
      .select("*")
      .eq("vino_id", vino.id)
      .order("created_at", { ascending: false })
      .limit(60);
    setHistRows((data as Movimiento[]) || []);
  }

  const paises = useMemo(() => [...new Set(wines.map((w) => w.pais))].sort(), [wines]);

  const list = useMemo(() => {
    const ql = q.toLowerCase();
    const filtered = wines.filter((w) => {
      if (filtTipo && w.tipo !== filtTipo) return false;
      if (filtPais && w.pais !== filtPais) return false;
      if (filtStock === "ok" && w.stock === 0) return false;
      if (filtStock === "low" && (w.stock === 0 || w.stock > thresh)) return false;
      if (filtStock === "zero" && w.stock !== 0) return false;
      if (
        ql &&
        !(
          w.bodega.toLowerCase().includes(ql) ||
          w.nombre.toLowerCase().includes(ql) ||
          String(w.anio ?? "").includes(ql) ||
          (w.uva ?? "").toLowerCase().includes(ql)
        )
      )
        return false;
      return true;
    });
    filtered.sort((a, b) => {
      if (sortBy === "stock") return a.stock - b.stock;
      if (sortBy === "stock_desc") return b.stock - a.stock;
      if (sortBy === "precio") return b.precio - a.precio;
      if (sortBy === "anio") return (b.anio ?? 9999) - (a.anio ?? 9999);
      return a.bodega.localeCompare(b.bodega);
    });
    return filtered;
  }, [wines, q, filtTipo, filtPais, filtStock, sortBy, thresh]);

  // Secciones por tipo (estilo carta) cuando no hay tipo elegido y el orden lo permite
  const sections = useMemo(() => {
    if (filtTipo || sortBy !== "bodega") return null;
    const out: { tipo: TipoVino; wines: Vino[] }[] = [];
    for (const t of TIPOS) {
      const arr = list.filter((w) => w.tipo === t);
      if (arr.length) out.push({ tipo: t, wines: arr });
    }
    return out;
  }, [list, filtTipo, sortBy]);

  const total = wines.reduce((s, w) => s + w.stock, 0);
  const sinStock = wines.filter((w) => w.stock === 0).length;
  const bajo = wines.filter((w) => w.stock > 0 && w.stock <= thresh).length;
  const alertWines = wines
    .filter((w) => w.stock > 0 && w.stock <= thresh && dismissed[w.id] !== w.stock)
    .sort((a, b) => a.stock - b.stock);

  const hoy = new Date().toLocaleDateString("es-ES", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  function WineCard({ w }: { w: Vino }) {
    return (
      <div
        className={`wine-card t-${w.tipo}${w.stock === 0 ? " agotado" : ""}`}
        aria-label={`${nombreVino(w)}, ${w.tipo}, ${w.stock} botellas`}
      >
        <div className="wc-top">
          <div className="wc-bodega">{w.bodega}</div>
          <div className={`wc-stock ${sc(w.stock, thresh)}`} key={w.stock}>
            {w.stock}
          </div>
        </div>
        <div className="wc-meta">
          {w.nombre}
          {w.anio ? ` · ${w.anio}` : ""}
        </div>
        <div className="wc-meta2">
          {w.uva && w.uva !== "—" ? `${w.uva} · ` : ""}
          {w.pais}
        </div>
        <div className="wc-bottom">
          <div className="wc-badges">
            {w.precio > 0 && <span className="badge b-price">{w.precio} €</span>}
            {(w.precio_compra ?? 0) > 0 && (
              <span
                className="badge b-coste"
                title="Precio de compra (proveedor)"
              >
                coste{" "}
                {Number(w.precio_compra).toLocaleString("es-ES", {
                  maximumFractionDigits: 2,
                })}{" "}
                €
              </span>
            )}
          </div>
          <div className="wc-actions">
            <button
              className="btn-h"
              title="Historial"
              aria-label={`Ver historial de ${w.bodega} ${w.nombre}`}
              onClick={() => openHist(w)}
            >
              <IconClock size={18} />
            </button>
            <button
              className="btn-v"
              title="Venta"
              aria-label={`Registrar venta de ${w.bodega} ${w.nombre}`}
              onClick={() => setModal({ mode: "venta", vino: w })}
            >
              −
            </button>
            <button
              className="btn-e"
              title="Entrada"
              aria-label={`Registrar entrada de ${w.bodega} ${w.nombre}`}
              onClick={() => setModal({ mode: "entrada", vino: w })}
            >
              +
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <Tabs />
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">Mi Bodega</div>
            <div className="page-sub">{hoy}</div>
          </div>
          <button
            className={`btn-alert-toggle${showSettings ? " active" : ""}`}
            onClick={() => setShowSettings((s) => !s)}
          >
            <IconSliders size={14} /> Alertas
          </button>
        </div>

        <div className="stats-grid" role="group" aria-label="Resumen y filtros rápidos">
          <button
            className={`stat${filtStock === "" ? " active" : ""}`}
            onClick={() => setFiltStock("")}
          >
            <div className="stat-label">Referencias</div>
            <div className="stat-value">{wines.length}</div>
          </button>
          <button
            className={`stat${filtStock === "ok" ? " active" : ""}`}
            onClick={() => setFiltStock(filtStock === "ok" ? "" : "ok")}
          >
            <div className="stat-label">Botellas</div>
            <div className="stat-value">{total}</div>
          </button>
          <button
            className={`stat${filtStock === "low" ? " active" : ""}`}
            onClick={() => setFiltStock(filtStock === "low" ? "" : "low")}
          >
            <div className="stat-label">Stock bajo</div>
            <div className="stat-value warn">{bajo}</div>
          </button>
          <button
            className={`stat${filtStock === "zero" ? " active" : ""}`}
            onClick={() => setFiltStock(filtStock === "zero" ? "" : "zero")}
          >
            <div className="stat-label">Sin stock</div>
            <div className="stat-value danger">{sinStock}</div>
          </button>
        </div>

        {alertWines.length > 0 && (
          <div className="alerts-card">
            <button
              className="alerts-bar"
              onClick={() => setAlertsOpen((o) => !o)}
              aria-expanded={alertsOpen}
            >
              <span className="alerts-title">Quedan pocas botellas</span>
              <span
                className={`alerts-count${alertWines.some((w) => w.stock === 1) ? " has-critical" : ""}`}
              >
                {alertWines.length}
              </span>
              {alertsOpen && <span className="alerts-hint">desliza para descartar</span>}
              <IconChevronDown
                size={14}
                strokeWidth={2.5}
                className={`alerts-chevron${alertsOpen ? " open" : ""}`}
              />
            </button>
            {alertsOpen &&
              alertWines.map((w) => (
                <AlertRow key={w.id} vino={w} onDismiss={() => dismissAlert(w)} />
              ))}
          </div>
        )}

        {showSettings && (
          <div className="settings-panel">
            <div className="settings-title">Umbral de alerta de stock bajo</div>
            <div className="settings-row">
              <span className="settings-label">Avisar cuando queden ≤</span>
              <input
                type="range"
                min={1}
                max={12}
                step={1}
                aria-label="Umbral de alerta de stock bajo"
                value={thresh}
                onChange={(e) => updateThresh(parseInt(e.target.value))}
              />
              <span className="settings-val">{thresh}</span>
              <span className="settings-label">bot.</span>
            </div>
            <div className="settings-note">
              Las alertas descartadas vuelven si el stock cambia. Compartido por todo el
              equipo.
            </div>
            <div className="settings-title" style={{ marginTop: 16 }}>
              Precio de venta automático
            </div>
            <div className="settings-row">
              <span className="settings-label">Coste del albarán ×</span>
              <input
                type="number"
                inputMode="decimal"
                min={1}
                max={5}
                step={0.1}
                aria-label="Multiplicador de precio de venta"
                className="settings-mult"
                value={mult}
                onChange={(e) => updateMult(parseFloat(e.target.value) || 0)}
              />
              <span className="settings-label">
                → una botella de 100 € se vende a {Math.max(5, Math.round((100 * (mult || 0)) / 5) * 5)} €
              </span>
            </div>
            <div className="settings-note">
              Se aplica al crear referencias nuevas desde albaranes (redondeado a 5 €).
              El precio siempre se puede ajustar a mano después.
            </div>
          </div>
        )}

        <div className="controls">
          <div className="search-wrap">
            <IconSearch size={16} />
            <input
              type="search"
              placeholder="Buscar bodega, vino, añada, uva…"
              aria-label="Buscar en el inventario"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        <div className="chips-row" role="group" aria-label="Filtrar por tipo de vino">
          <button
            className={`chip${filtTipo === "" ? " on" : ""}`}
            style={{ "--dotc": "var(--brand)" } as React.CSSProperties}
            onClick={() => setFiltTipo("")}
          >
            Todos
          </button>
          {TIPOS.map((t) => (
            <button
              key={t}
              className={`chip${filtTipo === t ? " on" : ""}`}
              style={{ "--dotc": TIPO_DOT[t] } as React.CSSProperties}
              onClick={() => setFiltTipo(filtTipo === t ? "" : t)}
            >
              <span className="dot" aria-hidden="true" />
              {t}
            </button>
          ))}
          <button
            className={`chip${filtPais || sortBy !== "bodega" ? " on" : ""}`}
            style={{ "--dotc": "var(--brand)" } as React.CSSProperties}
            onClick={() => setSheet("filtros")}
          >
            <IconSliders size={14} />
            {filtPais || (sortBy !== "bodega" ? "Orden" : "Filtros")}
            {filtPais && sortBy !== "bodega" ? " · orden" : ""}
          </button>
        </div>

        <div className="section-hdr">
          <span className="section-hdr-label">Vinos</span>
          <span className="section-hdr-count">{list.length} vinos</span>
        </div>

        <div className="wine-list">
          {!loaded ? (
            <div className="empty">Cargando bodega…</div>
          ) : list.length === 0 ? (
            <div className="empty">
              <IconWine size={40} strokeWidth={1.25} />
              <em>Nada con ese nombre en la cava</em>
            </div>
          ) : sections ? (
            sections.map((sec) => (
              <div key={sec.tipo} style={{ display: "contents" }}>
                <div className="wine-sec">
                  <span
                    className="wine-sec-name"
                    style={{ "--dotc": TIPO_DOT[sec.tipo] } as React.CSSProperties}
                  >
                    <span className="dot" aria-hidden="true" />
                    {sec.tipo}s
                  </span>
                  <span className="wine-sec-rule" aria-hidden="true" />
                  <span className="wine-sec-count">{sec.wines.length}</span>
                </div>
                {sec.wines.map((w) => (
                  <WineCard key={w.id} w={w} />
                ))}
              </div>
            ))
          ) : (
            list.map((w) => <WineCard key={w.id} w={w} />)
          )}
        </div>
      </div>

      {sheet === "filtros" && (
        <div
          className="overlay"
          onClick={(e) => e.target === e.currentTarget && setSheet(null)}
        >
          <div className="hist-modal">
            <div className="grabber" aria-hidden="true" />
            <div className="modal-title">Filtrar y ordenar</div>
            <div className="sheet-sec">
              <span className="eyebrow">Orden</span>
              <div>
                {ORDENES.map((o) => (
                  <button
                    key={o.v}
                    className={`sheet-row${sortBy === o.v ? " sel" : ""}`}
                    onClick={() => setSortBy(o.v)}
                  >
                    {o.label}
                    {sortBy === o.v && (
                      <span className="check">
                        <IconCheck size={16} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <div className="sheet-sec">
              <span className="eyebrow">País</span>
              <div className="sheet-opts">
                <button
                  className={`sheet-row${filtPais === "" ? " sel" : ""}`}
                  onClick={() => setFiltPais("")}
                >
                  Todos los países
                  {filtPais === "" && (
                    <span className="check">
                      <IconCheck size={16} />
                    </span>
                  )}
                </button>
                {paises.map((p) => (
                  <button
                    key={p}
                    className={`sheet-row${filtPais === p ? " sel" : ""}`}
                    onClick={() => setFiltPais(filtPais === p ? "" : p)}
                  >
                    {p}
                    {filtPais === p && (
                      <span className="check">
                        <IconCheck size={16} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="btn-confirm"
              style={{ width: "100%", marginTop: 14 }}
              onClick={() => setSheet(null)}
            >
              Ver {list.length} vinos
            </button>
          </div>
        </div>
      )}

      {modal && (
        <div
          className="overlay"
          onClick={(e) => e.target === e.currentTarget && setModal(null)}
        >
          <div className="modal">
            <div className="grabber" aria-hidden="true" />
            <div className="modal-title">
              {modal.mode === "venta" ? "Registrar venta" : "Registrar entrada"}
            </div>
            <div className="modal-sub">{nombreVino(modal.vino)}</div>
            <label className="modal-label">
              {modal.mode === "venta" ? "Botellas vendidas" : "Botellas recibidas"}
            </label>
            <input
              ref={qtyRef}
              className="modal-input"
              type="number"
              inputMode="numeric"
              min={1}
              value={mQty}
              onChange={(e) => setMQty(e.target.value)}
            />
            <label className="modal-label" style={{ marginTop: -6 }}>
              Nota (opcional)
            </label>
            <input
              className="modal-note"
              type="text"
              placeholder="Mesa, proveedor, evento…"
              value={mNote}
              onChange={(e) => setMNote(e.target.value)}
            />
            <div className="modal-btns">
              <button className="btn-cancel" onClick={() => setModal(null)}>
                Cancelar
              </button>
              <button className="btn-confirm" onClick={confirmMovimiento} disabled={saving}>
                {saving
                  ? "Guardando…"
                  : modal.mode === "venta"
                    ? "Confirmar venta"
                    : "Confirmar entrada"}
              </button>
            </div>
          </div>
        </div>
      )}

      {histVino && (
        <div
          className="overlay"
          onClick={(e) => e.target === e.currentTarget && setHistVino(null)}
        >
          <div className="hist-modal">
            <div className="grabber" aria-hidden="true" />
            <div className="modal-title" style={{ marginBottom: 2 }}>
              {histVino.bodega}
            </div>
            <div className="modal-sub">
              {histVino.nombre}
              {histVino.anio ? ` — ${histVino.anio}` : ""}
            </div>
            <div>
              {histRows === null ? (
                <div style={{ color: "var(--hint)", fontSize: 13, padding: "12px 0" }}>
                  Cargando…
                </div>
              ) : histRows.length === 0 ? (
                <div style={{ color: "var(--hint)", fontSize: 13, padding: "12px 0" }}>
                  Sin movimientos aún.
                </div>
              ) : (
                histRows.map((h) => (
                  <div className="hist-row" key={h.id}>
                    <span className={h.qty < 0 ? "hist-v" : "hist-e"}>
                      {h.qty < 0 ? `−${-h.qty}` : `+${h.qty}`} {h.tipo}
                    </span>
                    <span style={{ color: "var(--muted2)" }}>
                      {h.stock_prev}→{h.stock_nuevo}
                    </span>
                    <div className="hist-meta">
                      {fmtFecha(h.created_at)}
                      {h.nota && (
                        <>
                          <br />
                          <span style={{ color: "var(--hint)" }}>{h.nota}</span>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
            <button className="btn-close-hist" onClick={() => setHistVino(null)}>
              Cerrar
            </button>
          </div>
        </div>
      )}
    </>
  );
}

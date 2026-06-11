"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Tabs from "@/components/Tabs";
import { createClient } from "@/lib/supabase/client";
import { fmtFecha, nombreVino, type Movimiento, type Vino } from "@/lib/types";

const PAIS_BADGE: Record<string, string> = {
  España: "b-es",
  Francia: "b-fr",
  Italia: "b-it",
  Argentina: "b-ar",
};
const cc = (p: string) => PAIS_BADGE[p] || "b-ot";
const sc = (s: number, t: number) =>
  s === 0 ? "stock-zero" : s <= t ? "stock-low" : "stock-ok";
const wcc = (s: number, t: number) => (s === 0 ? " zero" : s <= t ? " low" : "");

export default function InventarioPage() {
  const supabase = useMemo(() => createClient(), []);
  const [wines, setWines] = useState<Vino[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [thresh, setThresh] = useState(3);
  const [showSettings, setShowSettings] = useState(false);

  const [q, setQ] = useState("");
  const [filtTipo, setFiltTipo] = useState("");
  const [filtPais, setFiltPais] = useState("");
  const [filtStock, setFiltStock] = useState("");
  const [sortBy, setSortBy] = useState("bodega");

  // modal venta/entrada
  const [modal, setModal] = useState<{ mode: "venta" | "entrada"; vino: Vino } | null>(null);
  const [mQty, setMQty] = useState("1");
  const [mNote, setMNote] = useState("");
  const [saving, setSaving] = useState(false);
  const qtyRef = useRef<HTMLInputElement>(null);

  // modal historial
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
      .select("valor")
      .eq("clave", "umbral_stock_bajo")
      .single()
      .then(({ data }) => {
        if (data) setThresh(Number(data.valor));
      });

    // Realtime: cualquier cambio de stock en otro dispositivo se refleja aquí
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
    await supabase
      .from("ajustes")
      .update({ valor: v })
      .eq("clave", "umbral_stock_bajo");
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

  const paises = useMemo(
    () => [...new Set(wines.map((w) => w.pais))].sort(),
    [wines]
  );

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
      if (sortBy === "tipo")
        return a.tipo.localeCompare(b.tipo) || a.bodega.localeCompare(b.bodega);
      if (sortBy === "precio") return b.precio - a.precio;
      if (sortBy === "anio") return (b.anio ?? 9999) - (a.anio ?? 9999);
      return a.bodega.localeCompare(b.bodega);
    });
    return filtered;
  }, [wines, q, filtTipo, filtPais, filtStock, sortBy, thresh]);

  const total = wines.reduce((s, w) => s + w.stock, 0);
  const sinStock = wines.filter((w) => w.stock === 0).length;
  const bajo = wines.filter((w) => w.stock > 0 && w.stock <= thresh).length;
  const alertWines = wines.filter((w) => w.stock > 0 && w.stock <= thresh);

  return (
    <>
      <Tabs />
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">Mi Bodega</div>
            <div className="page-sub">Es Fumeral · Gestión de inventario</div>
          </div>
          <button
            className={`btn-alert-toggle${showSettings ? " active" : ""}`}
            onClick={() => setShowSettings((s) => !s)}
          >
            ⚙ Alertas
          </button>
        </div>

        <div className="stats-grid">
          <div className="stat">
            <div className="stat-label">Referencias</div>
            <div className="stat-value">{wines.length}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Botellas</div>
            <div className="stat-value">{total}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Stock bajo (≤{thresh})</div>
            <div className="stat-value warn">{bajo}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Sin stock</div>
            <div className="stat-value danger">{sinStock}</div>
          </div>
        </div>

        {alertWines.length > 0 && (
          <div className="alert-panel">
            <div className="alert-header">⚠ Stock bajo — pendiente de pedir</div>
            <div>
              {alertWines.map((w) => (
                <div className="alert-item" key={w.id}>
                  {w.bodega} — {w.nombre}
                  {w.anio ? ` (${w.anio})` : ""} — <strong>{w.stock} bot.</strong>
                </div>
              ))}
            </div>
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
                value={thresh}
                onChange={(e) => updateThresh(parseInt(e.target.value))}
              />
              <span className="settings-val">{thresh}</span>
              <span className="settings-label">bot.</span>
            </div>
            <div className="settings-note">
              Los vinos con 0 botellas siempre aparecen en rojo. El umbral es
              compartido por todo el equipo.
            </div>
          </div>
        )}

        <div className="controls">
          <div className="search-wrap">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="search"
              placeholder="Buscar bodega, vino, añada, uva…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="selects-row">
            <select value={filtTipo} onChange={(e) => setFiltTipo(e.target.value)}>
              <option value="">Todos los tipos</option>
              <option>Espumoso</option>
              <option>Blanco</option>
              <option>Rosado</option>
              <option>Tinto</option>
              <option>Dulce</option>
            </select>
            <select value={filtPais} onChange={(e) => setFiltPais(e.target.value)}>
              <option value="">Todos los países</option>
              {paises.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="selects-row">
            <select value={filtStock} onChange={(e) => setFiltStock(e.target.value)}>
              <option value="">Todo el stock</option>
              <option value="ok">Con stock</option>
              <option value="low">Stock bajo</option>
              <option value="zero">Sin stock</option>
            </select>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="bodega">Orden: bodega</option>
              <option value="stock">Orden: stock ↑</option>
              <option value="stock_desc">Orden: stock ↓</option>
              <option value="tipo">Orden: tipo</option>
              <option value="precio">Orden: precio</option>
              <option value="anio">Orden: añada</option>
            </select>
          </div>
        </div>

        <div className="section-hdr">
          <span className="section-hdr-label">Referencias</span>
          <span className="section-hdr-count">{list.length} vinos</span>
        </div>

        <div className="wine-list">
          {!loaded ? (
            <div className="empty">Cargando bodega…</div>
          ) : list.length === 0 ? (
            <div className="empty">No se encontraron vinos</div>
          ) : (
            list.map((w) => (
              <div className={`wine-card${wcc(w.stock, thresh)}`} key={w.id}>
                <div className="wc-top">
                  <div className="wc-bodega">{w.bodega}</div>
                  <div className={`wc-stock ${sc(w.stock, thresh)}`}>{w.stock}</div>
                </div>
                <div className="wc-meta">
                  {w.anio ? `${w.anio} · ` : ""}
                  {w.nombre}
                  {w.uva && w.uva !== "—" ? ` · ${w.uva}` : ""}
                </div>
                <div className="wc-bottom">
                  <div className="wc-badges">
                    <span className={`badge ${cc(w.pais)}`}>{w.pais}</span>
                    <span className="badge b-tipo">{w.tipo}</span>
                    {w.precio > 0 && (
                      <span className="badge b-price">{w.precio}€</span>
                    )}
                  </div>
                  <div className="wc-actions">
                    <button
                      className="btn-v"
                      title="Venta"
                      onClick={() => setModal({ mode: "venta", vino: w })}
                    >
                      −
                    </button>
                    <button
                      className="btn-e"
                      title="Entrada"
                      onClick={() => setModal({ mode: "entrada", vino: w })}
                    >
                      +
                    </button>
                    <button className="btn-h" title="Historial" onClick={() => openHist(w)}>
                      ✎
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {modal && (
        <div
          className="overlay"
          onClick={(e) => e.target === e.currentTarget && setModal(null)}
        >
          <div className="modal">
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
                    <span style={{ color: "var(--muted)" }}>
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

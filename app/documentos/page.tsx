"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Tabs from "@/components/Tabs";
import {
  IconFileUp,
  IconPackage,
  IconReceipt,
  IconTable,
  IconTrash,
  IconWine,
} from "@/components/icons";
import { createClient } from "@/lib/supabase/client";
import { ES_OTRO_ARTICULO } from "@/lib/ventas-tpv";
import {
  fmtFecha,
  type DocumentoRow,
  type ResultadoDocumento,
  type TipoDocumento,
} from "@/lib/types";

const TIPO_LABEL: Record<TipoDocumento, string> = {
  albaran: "Albarán",
  cierre: "Cierre caja",
  excel: "Excel",
  carta: "Carta",
};

type VinoBusca = {
  id: number;
  bodega: string;
  nombre: string;
  anio: number | null;
  precio: number;
  stock: number;
};

const etiquetaVino = (v: VinoBusca) =>
  `${v.bodega} — ${v.nombre}${v.anio ? ` (${v.anio})` : ""}`;

/** Buscador de una referencia del catálogo para resolver a mano */
function BuscadorVino({
  catalogo,
  excluidos,
  onPick,
}: {
  catalogo: VinoBusca[];
  excluidos: Set<number>;
  onPick: (v: VinoBusca) => void;
}) {
  const [q, setQ] = useState("");
  const res = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (t.length < 2) return [];
    const palabras = t.split(/\s+/);
    return catalogo
      .filter((v) => {
        if (excluidos.has(v.id)) return false;
        const s = `${v.bodega} ${v.nombre} ${v.anio ?? ""}`.toLowerCase();
        return palabras.every((p) => s.includes(p));
      })
      .slice(0, 6);
  }, [q, catalogo, excluidos]);

  return (
    <div className="busca">
      <input
        className="busca-input"
        type="search"
        placeholder="Buscar en el inventario…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {res.map((v) => (
        <button key={v.id} className="busca-item" onClick={() => onPick(v)}>
          <span className="busca-nom">{etiquetaVino(v)}</span>
          <span className="busca-meta">
            {v.stock} bot. · {v.precio}€
          </span>
        </button>
      ))}
      {q.trim().length >= 2 && !res.length && (
        <div className="busca-vacio">Sin resultados</div>
      )}
    </div>
  );
}

export default function DocumentosPage() {
  const supabase = useMemo(() => createClient(), []);
  const [docType, setDocType] = useState<TipoDocumento>("albaran");
  const [dragover, setDragover] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{
    documento_id: number;
    resultado: ResultadoDocumento;
    fileName: string;
    tipo: TipoDocumento;
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const [bajando, setBajando] = useState(false);
  const [bajadas, setBajadas] = useState<Set<number>>(new Set());
  const [history, setHistory] = useState<DocumentoRow[]>([]);
  // Vista previa del documento subido, para cotejar con lo extraído
  const [vista, setVista] = useState<{
    url: string;
    nombre: string;
    tipo: "pdf" | "imagen" | "hoja";
  } | null>(null);
  // En cierres, enseñar también la comida y bebida que no es vino
  const [verTodo, setVerTodo] = useState(false);
  // Revisión de la carta: sugerencias aceptadas y resoluciones manuales
  const [sugOk, setSugOk] = useState<Set<number>>(new Set());
  const [manual, setManual] = useState<Map<string, VinoBusca>>(new Map());
  const [catalogo, setCatalogo] = useState<VinoBusca[]>([]);

  const fileRef = useRef<HTMLInputElement>(null);
  const fileExcelRef = useRef<HTMLInputElement>(null);

  async function loadHistory() {
    const { data } = await supabase
      .from("documentos")
      .select("id,tipo,nombre_archivo,modelo_ia,resultado,aplicado,created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    setHistory((data as DocumentoRow[]) || []);
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addLog(msg: string) {
    setLog((l) => [...l, msg]);
  }

  async function handleFile(file: File | undefined | null) {
    if (!file || processing) return;
    setError("");
    setPending(null);
    setProcessing(true);
    setLog([`📄 Subiendo ${file.name} (${Math.round(file.size / 1024)} KB)…`]);

    // Vista previa local: el fichero no se vuelve a descargar del servidor
    if (vista) URL.revokeObjectURL(vista.url);
    const n = file.name.toLowerCase();
    setVista({
      url: URL.createObjectURL(file),
      nombre: file.name,
      tipo: n.endsWith(".pdf") || file.type === "application/pdf"
        ? "pdf"
        : /\.(jpe?g|png|webp|gif|heic)$/.test(n) || file.type.startsWith("image/")
          ? "imagen"
          : "hoja",
    });

    try {
      addLog("🤖 Analizando con IA…");
      const form = new FormData();
      form.append("file", file);
      form.append("tipo", docType);
      const resp = await fetch("/api/documentos", { method: "POST", body: form });
      // Vercel puede devolver texto plano (p. ej. timeout) en vez de JSON
      const texto = await resp.text();
      let data: { documento_id?: number; resultado?: ResultadoDocumento; error?: string };
      try {
        data = JSON.parse(texto);
      } catch {
        throw new Error(
          resp.status === 504 || /timeout|timed out/i.test(texto)
            ? "El servidor tardó demasiado. Vuelve a intentarlo."
            : `Error del servidor (${resp.status}): ${texto.slice(0, 120)}`
        );
      }
      if (!resp.ok) throw new Error(data.error || `Error ${resp.status}`);
      if (!data.documento_id || !data.resultado) throw new Error("Respuesta inválida del servidor");
      addLog("✓ Documento leído. Revisa la previsualización.");
      setSugOk(new Set());
      setManual(new Map());
      setVerTodo(false);
      setPending({
        documento_id: data.documento_id,
        resultado: data.resultado,
        fileName: file.name,
        tipo: docType,
      });
      if ((docType === "carta" || docType === "cierre") && !catalogo.length) {
        const { data: vs } = await supabase
          .from("vinos")
          .select("id, bodega, nombre, anio, precio, stock")
          .eq("activo", true)
          .order("bodega");
        setCatalogo((vs as VinoBusca[]) || []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
    } finally {
      setProcessing(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragover(false);
    handleFile(e.dataTransfer.files[0]);
  }

  /** Reabre un documento sin aplicar (p. ej. el cierre que deja el cron cada
   *  madrugada) en el panel de revisión. Sin esto, los cierres automáticos
   *  llegaban a la lista pero no había forma de revisarlos ni aplicarlos. */
  async function revisar(d: DocumentoRow) {
    if (d.aplicado || !d.resultado || processing) return;
    setError("");
    cerrarVista();
    setSugOk(new Set());
    setManual(new Map());
    setVerTodo(false);
    setPending({
      documento_id: d.id,
      resultado: d.resultado,
      fileName: d.nombre_archivo,
      tipo: d.tipo,
    });
    if ((d.tipo === "carta" || d.tipo === "cierre") && !catalogo.length) {
      const { data: vs } = await supabase
        .from("vinos")
        .select("id, bodega, nombre, anio, precio, stock")
        .eq("activo", true)
        .order("bodega");
      setCatalogo((vs as VinoBusca[]) || []);
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function triggerFileInput() {
    if (docType === "excel") {
      if (fileExcelRef.current) {
        fileExcelRef.current.value = "";
        fileExcelRef.current.click();
      }
    } else if (fileRef.current) {
      fileRef.current.value = "";
      fileRef.current.click();
    }
  }

  /** Lista final de un cierre de TPV: casados + sugerencias + manuales */
  function itemsTpv() {
    const r = pending!.resultado;
    const items = [...(r.tpv_items ?? [])];
    (r.carta_sugerencias ?? []).forEach((s, i) => {
      if (sugOk.has(i))
        items.push({ vino_id: s.vino_id, qty: -(s.qty ?? 0), texto: s.texto });
    });
    for (const [texto, v] of manual) {
      const linea = (r.carta_sin_casar ?? []).find((x) => x.texto === texto);
      items.push({ vino_id: v.id, qty: -(linea?.qty ?? 0), texto });
    }
    return items.filter((i) => i.qty !== 0);
  }

  async function aplicarTpv() {
    if (!pending) return;
    const items = itemsTpv();
    const bot = items.reduce((s, i) => s + Math.abs(i.qty), 0);
    if (!confirm(`Se descontarán ${bot} botellas de ${items.length} referencias.\n\n¿Aplicar?`))
      return;
    setApplying(true);
    const { data, error } = await supabase.rpc("aplicar_movimientos", {
      p_documento_id: pending.documento_id,
      p_items: items,
    });
    setApplying(false);
    if (error) {
      setError("Error al aplicar: " + error.message);
      return;
    }
    const res = data as { movimientos_aplicados: number; alias_guardados: number };
    alert(
      `✓ ${res.movimientos_aplicados} movimientos aplicados.\n${res.alias_guardados} nombres del TPV recordados para el próximo cierre.`
    );
    setPending(null);
    loadHistory();
  }

  /** Lista final de la carta: casadas + sugerencias aceptadas + manuales */
  function itemsCarta() {
    const r = pending!.resultado;
    const items = [...(r.carta_items ?? [])];
    (r.carta_sugerencias ?? []).forEach((s, i) => {
      if (sugOk.has(i))
        items.push({ vino_id: s.vino_id, precio: s.precio, texto: s.texto });
    });
    for (const [texto, v] of manual) {
      const linea = (r.carta_sin_casar ?? []).find((x) => x.texto === texto);
      items.push({ vino_id: v.id, precio: linea?.precio ?? null, texto });
    }
    // Una referencia no puede entrar dos veces
    const vistos = new Set<number>();
    return items.filter((i) => !vistos.has(i.vino_id) && vistos.add(i.vino_id));
  }

  async function aplicarCarta() {
    if (!pending) return;
    const items = itemsCarta();
    const fuera = catalogo.length - items.length;
    if (
      !confirm(
        `Se marcarán ${items.length} referencias EN carta y ${fuera > 0 ? fuera : 0} quedarán FUERA de carta.\n\nNo se toca el stock. ¿Aplicar?`
      )
    )
      return;
    setApplying(true);
    const { data, error } = await supabase.rpc("aplicar_carta", {
      p_documento_id: pending.documento_id,
      p_items: items,
    });
    setApplying(false);
    if (error) {
      setError("Error al aplicar: " + error.message);
      return;
    }
    const res = data as {
      en_carta: number;
      fuera_de_carta: number;
      precios_actualizados: number;
      alias_guardados: number;
    };
    alert(
      `✓ Carta aplicada.\n\n${res.en_carta} referencias en carta · ${res.fuera_de_carta} fuera\n${res.precios_actualizados} precios actualizados\n${res.alias_guardados} nombres recordados para la próxima carta`
    );
    setPending(null);
    loadHistory();
  }

  const esTpv = () => !!pending?.resultado.tpv_items;

  async function aplicar() {
    if (!pending) return;
    if (pending.tipo === "carta") return aplicarCarta();
    if (esTpv()) return aplicarTpv();
    // Un albarán real tiene 5-20 líneas. Uno con decenas es casi seguro un
    // inventario completo subido por la vía equivocada: aplicarlo SUMARÍA todo
    // el recuento al stock como si fuera una compra (pasó el 04/08: +1.371).
    const lineas =
      (pending.resultado.movimientos?.length ?? 0) +
      (pending.resultado.nuevas_referencias?.length ?? 0);
    if (pending.tipo === "albaran" && lineas > 40) {
      if (
        !confirm(
          `⚠ Este albarán tiene ${lineas} líneas.\n\nUn albarán normal tiene menos de 20: esto parece un INVENTARIO completo. Si lo aplicas, se SUMARÁN todas esas botellas al stock como si fueran una compra.\n\nSi es el recuento del inventario, cancela y súbelo con el tipo «Excel».\n\n¿Aplicar de todas formas?`
        )
      )
        return;
    }
    setApplying(true);
    const { data, error } = await supabase.rpc("aplicar_documento", {
      p_documento_id: pending.documento_id,
    });
    setApplying(false);
    if (error) {
      setError("Error al aplicar: " + error.message);
      return;
    }
    const res = data as {
      movimientos_aplicados: number;
      referencias_nuevas: number;
      precios_actualizados: number;
      en_carta: number;
      fuera_de_carta: number;
    };
    alert(
      docType === "carta"
        ? `✓ Carta aplicada: ${res.en_carta} referencias en carta, ${res.fuera_de_carta} fuera${
            res.precios_actualizados ? `, ${res.precios_actualizados} precios actualizados` : ""
          }.`
        : `✓ Aplicado: ${res.movimientos_aplicados} movimientos${
            res.referencias_nuevas ? `, ${res.referencias_nuevas} referencias nuevas` : ""
          }${res.precios_actualizados ? `, ${res.precios_actualizados} precios` : ""}.`
    );
    setPending(null);
    cerrarVista();
    loadHistory();
  }

  /** Elimina un documento sin aplicar (pruebas, duplicados…). La política de
   *  la base de datos solo permite borrar documentos no aplicados. */
  async function eliminarDoc(d: DocumentoRow) {
    if (d.aplicado) return;
    if (!confirm(`¿Eliminar "${d.nombre_archivo}"?\n\nNo se ha aplicado nada al inventario; solo desaparece de la lista.`))
      return;
    const { error } = await supabase.from("documentos").delete().eq("id", d.id);
    if (error) {
      setError("No se pudo eliminar: " + error.message);
      return;
    }
    if (pending?.documento_id === d.id) setPending(null);
    loadHistory();
  }

  async function darDeBajaLote(ids: number[], etiqueta: string) {
    if (!ids.length) return;
    if (!confirm(`¿Dar de baja ${ids.length} referencias ${etiqueta}?\n\nDesaparecerán del inventario; el historial se conserva.`))
      return;
    setBajando(true);
    const { data, error } = await supabase.rpc("dar_de_baja", { p_ids: ids });
    setBajando(false);
    if (error) {
      setError("Error al dar de baja: " + error.message);
      return;
    }
    setBajadas((prev) => new Set([...prev, ...ids]));
    alert(`✓ ${data} referencias dadas de baja.`);
  }

  async function descartar() {
    if (!pending) return;
    // el documento queda registrado pero sin aplicar
    setPending(null);
    cerrarVista();
    loadHistory();
  }

  function cerrarVista() {
    if (vista) URL.revokeObjectURL(vista.url);
    setVista(null);
  }

  const r = pending?.resultado;
  const nMovs = r?.movimientos.length ?? 0;
  const nNuevas = r?.nuevas_referencias?.length ?? 0;
  const nNoEnc = r?.no_encontrados?.length ?? 0;

  return (
    <>
      <Tabs />
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">Documentos</div>
            <div className="page-sub">Albaranes, cierres de caja y Excel</div>
          </div>
        </div>

        <div className="section-label">Tipo de documento</div>
        <div className="doc-type-row" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
          <button
            className={`doc-type-btn${docType === "albaran" ? " selected" : ""}`}
            onClick={() => setDocType("albaran")}
          >
            <span className="dt-icon">
              <IconPackage size={22} />
            </span>
            <span className="dt-label">Albarán</span>
            <span className="dt-sub">Entrada stock</span>
          </button>
          <button
            className={`doc-type-btn${docType === "cierre" ? " selected" : ""}`}
            onClick={() => setDocType("cierre")}
          >
            <span className="dt-icon">
              <IconReceipt size={22} />
            </span>
            <span className="dt-label">Cierre caja</span>
            <span className="dt-sub">Ventas día</span>
          </button>
          <button
            className={`doc-type-btn${docType === "excel" ? " selected" : ""}`}
            onClick={() => setDocType("excel")}
          >
            <span className="dt-icon">
              <IconTable size={22} />
            </span>
            <span className="dt-label">Excel</span>
            <span className="dt-sub">Actualizar todo</span>
          </button>
          <button
            className={`doc-type-btn${docType === "carta" ? " selected" : ""}`}
            onClick={() => setDocType("carta")}
          >
            <span className="dt-icon">
              <IconWine size={22} />
            </span>
            <span className="dt-label">Carta</span>
            <span className="dt-sub">Qué está en carta</span>
          </button>
        </div>

        <div
          className={`doc-zone${dragover ? " dragover" : ""}`}
          onClick={triggerFileInput}
          onDragOver={(e) => {
            e.preventDefault();
            setDragover(true);
          }}
          onDragLeave={() => setDragover(false)}
          onDrop={handleDrop}
        >
          <span className="doc-zone-icon">
            {docType === "excel" ? (
              <IconTable size={30} strokeWidth={1.5} />
            ) : docType === "carta" ? (
              <IconWine size={30} strokeWidth={1.5} />
            ) : (
              <IconFileUp size={30} strokeWidth={1.5} />
            )}
          </span>
          <div className="doc-zone-title">
            {docType === "excel"
              ? "Suelta aquí tu Excel actualizado…"
              : docType === "carta"
                ? "Suelta aquí la carta de vinos…"
                : docType === "albaran"
                  ? "Suelta aquí el albarán…"
                  : "Suelta aquí el cierre de caja…"}
          </div>
          <div className="doc-zone-sub">
            {docType === "excel"
              ? "Archivos .xlsx, .xls o .csv — actualiza stock, precios y referencias nuevas"
              : docType === "carta"
                ? "PDF, foto o Excel — marca qué botellas están en carta y actualiza sus precios"
                : docType === "cierre"
                  ? "CSV/Excel exportado del TPV (máxima precisión), PDF o foto"
                  : "PDF, imagen (JPG, PNG) o CSV/Excel del proveedor"}
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.webp,.csv,.xlsx,.xls"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <input
          ref={fileExcelRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />

        {/* Documento a la izquierda y lo extraído a la derecha, para cotejar */}
        <div className={vista ? "doc-split" : ""}>
          {vista && (
            <div className="doc-visor">
              <div className="doc-visor-cab">
                <span className="doc-visor-nombre">📄 {vista.nombre}</span>
                <a href={vista.url} target="_blank" rel="noreferrer">
                  Abrir ↗
                </a>
                <button
                  className="doc-visor-cerrar"
                  onClick={cerrarVista}
                  aria-label="Ocultar el documento"
                >
                  ✕
                </button>
              </div>
              {vista.tipo === "pdf" ? (
                <iframe
                  title={`Documento ${vista.nombre}`}
                  src={vista.url}
                  className="doc-visor-marco"
                />
              ) : vista.tipo === "imagen" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={vista.url} alt={vista.nombre} className="doc-visor-img" />
              ) : (
                <div className="doc-visor-vacio">
                  Hoja de cálculo: no se puede previsualizar aquí.
                  <br />
                  Ábrela en tu programa si quieres cotejar los datos.
                </div>
              )}
            </div>
          )}

          <div className="doc-datos">
          {(processing || error) && (
            <div className="doc-processing">
              <div className="dp-title">
                {processing ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Analizando documento…
                  </>
                ) : (
                  "Error al procesar"
                )}
              </div>
              <div className="dp-log">
                {log.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
                {error && <div>❌ {error}</div>}
              </div>
            </div>
          )}

          {pending && r && (
            <div className="doc-result">
              <div className="dr-header">
                <div>
                  <div className="dr-title">
                    {pending.resultado.proveedor_o_fecha || pending.fileName}
                  </div>
                  <div className="dr-sub">
                    {nMovs} movimientos
                    {nNuevas ? ` · ${nNuevas} referencias nuevas` : ""}
                    {nNoEnc ? ` · ${nNoEnc} sin identificar` : ""}
                  </div>
                </div>
              </div>
              <div>
                {(r.preview ?? []).map((p, i) => (
                  <div className="dr-item" key={i}>
                    <div className="dr-wine">
                      <div className="dr-wine-name">{p.etiqueta}</div>
                      <div className="dr-wine-match">{p.detalle}</div>
                    </div>
                    <div className={`dr-qty ${p.direccion}`}>{p.qty}</div>
                  </div>
                ))}
                {(r.no_encontrados ?? []).map((x, i) => {
                  // Distinguir avisos informativos (no crean ni cambian nada)
                  // de líneas de documento realmente no identificadas
                  const esAviso = /^(Añada distinta|\d+ vinos de la bodega|")/.test(
                    x.texto
                  );
                  return (
                    <div className="dr-item dr-no-match" key={`ne-${i}`}>
                      <div className="dr-wine">
                        <div className="dr-wine-name">
                          {esAviso ? "ℹ Aviso — sin cambios" : "⚠ No identificado"}
                        </div>
                        <div className="dr-wine-match">
                          {x.texto}
                          {x.qty ? ` · ${x.qty} bot.` : ""}
                        </div>
                      </div>
                      <div className="dr-qty">{esAviso ? "—" : "?"}</div>
                    </div>
                  );
                })}
              </div>
              {(pending.tipo === "carta" || esTpv()) && (
                <>
                  {(r.carta_sugerencias ?? []).length > 0 && (
                    <div className="rev-sec">
                      <div className="rev-head">
                        ¿Es el mismo vino? ({(r.carta_sugerencias ?? []).length})
                        <span className="rev-sub">
                          Toca para incluirlo en la carta
                        </span>
                      </div>
                      {(r.carta_sugerencias ?? []).map((s, i) => (
                        <button
                          key={i}
                          className={`sug-item${sugOk.has(i) ? " on" : ""}`}
                          onClick={() =>
                            setSugOk((prev) => {
                              const n = new Set(prev);
                              if (n.has(i)) n.delete(i);
                              else n.add(i);
                              return n;
                            })
                          }
                        >
                          <span className="sug-check">{sugOk.has(i) ? "✓" : ""}</span>
                          <span className="sug-text">
                            <span className="sug-carta">{s.texto}</span>
                            <span className="sug-flecha">
                              ≈ {s.etiqueta}
                              {s.precio ? ` · ${s.precio}€` : ""}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {(r.carta_sin_casar ?? []).length > 0 && (
                    <div className="rev-sec">
                      {(() => {
                        // En un cierre, la mayoría de líneas sin casar es comida
                        // y bebida ajena a la bodega: se ocultan por defecto
                        const todas = r.carta_sin_casar ?? [];
                        const otras = esTpv() && !verTodo
                          ? todas.filter((l) => ES_OTRO_ARTICULO.test(l.texto))
                          : [];
                        const visibles = todas.filter((l) => !otras.includes(l));
                        return (
                          <>
                            <div className="rev-head">
                              No están en el inventario ({visibles.length})
                              <span className="rev-sub">
                                Búscalas si crees que sí están con otro nombre
                              </span>
                            </div>
                            {otras.length > 0 && (
                              <button className="rev-otros" onClick={() => setVerTodo(true)}>
                                {otras.length} artículos de comida y bebida ocultos
                                (cafés, cócteles, aguas…) — ver todos
                              </button>
                            )}
                            {visibles.map((l) => {
                              const elegido = manual.get(l.texto);
                              return (
                                <div className="manual-item" key={l.texto}>
                                  <div className="manual-linea">
                                    <span className="manual-carta">{l.texto}</span>
                                    {l.precio ? (
                                      <span className="manual-precio">{l.precio}€</span>
                                    ) : null}
                                  </div>
                                  {l.nota && <div className="manual-nota">{l.nota}</div>}
                                  {elegido ? (
                                    <div className="manual-elegido">
                                      ✓ {etiquetaVino(elegido)}
                                      <button
                                        className="manual-quitar"
                                        onClick={() =>
                                          setManual((prev) => {
                                            const n = new Map(prev);
                                            n.delete(l.texto);
                                            return n;
                                          })
                                        }
                                      >
                                        quitar
                                      </button>
                                    </div>
                                  ) : (
                                    <BuscadorVino
                                      catalogo={catalogo}
                                      excluidos={
                                        new Set(itemsCarta().map((i) => i.vino_id))
                                      }
                                      onPick={(v) =>
                                        setManual((prev) =>
                                          new Map(prev).set(l.texto, v)
                                        )
                                      }
                                    />
                                  )}
                                </div>
                              );
                            })}
                          </>
                        );
                      })()}
                    </div>
                  )}

                  {esTpv() ? (
                    <div className="rev-resumen">
                      Se descontarán{" "}
                      <strong>
                        {itemsTpv().reduce((s, i) => s + Math.abs(i.qty), 0)} botellas
                      </strong>{" "}
                      de <strong>{itemsTpv().length}</strong> referencias. Lo que no
                      casa suele ser comida o bebida que no es vino: puedes ignorarlo.
                    </div>
                  ) : (
                    <div className="rev-resumen">
                      <strong>{itemsCarta().length}</strong> referencias quedarán{" "}
                      <strong>en carta</strong> ·{" "}
                      <strong>
                        {Math.max(0, catalogo.length - itemsCarta().length)}
                      </strong>{" "}
                      fuera de carta (siguen en la bodega, no se toca el stock)
                    </div>
                  )}
                </>
              )}

              {(() => {
                const bajas = (r.bajas_sugeridas ?? []).filter(
                  (b) => !bajadas.has(b.vino_id)
                );
                if (!bajas.length) return null;
                const seguras = bajas.filter((b) => b.stock === 0);
                const conStock = bajas.filter((b) => b.stock > 0);
                return (
                  <div className="bajas-sec">
                    <div className="bajas-head">
                      Referencias que este inventario ya no incluye ({bajas.length})
                    </div>
                    {seguras.length > 0 && (
                      <>
                        <div className="bajas-lista">
                          {seguras.slice(0, 8).map((b) => (
                            <div className="bajas-item" key={b.vino_id}>
                              {b.etiqueta}
                              <span className="bajas-motivo">
                                {b.motivo === "sin_cantidad"
                                  ? "sin cantidad"
                                  : "no está en el Excel"}
                              </span>
                            </div>
                          ))}
                          {seguras.length > 8 && (
                            <div className="bajas-item bajas-mas">
                              y {seguras.length - 8} más…
                            </div>
                          )}
                        </div>
                        <button
                          className="btn-baja-lote"
                          disabled={bajando}
                          onClick={() =>
                            darDeBajaLote(
                              seguras.map((b) => b.vino_id),
                              "sin stock"
                            )
                          }
                        >
                          <IconTrash size={15} />
                          {bajando
                            ? "Dando de baja…"
                            : `Dar de baja las ${seguras.length} sin stock`}
                        </button>
                      </>
                    )}
                    {conStock.length > 0 && (
                      <div className="bajas-aviso">
                        ⚠ {conStock.length} de ellas todavía tienen botellas en la
                        app (
                        {conStock.reduce((s, b) => s + b.stock, 0)} en total). No se
                        incluyen en el botón: revísalas una a una desde el
                        inventario.
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="dr-actions">
                <button className="btn-discard" onClick={descartar}>
                  Descartar
                </button>
                <button
                  className="btn-apply"
                  onClick={aplicar}
                  disabled={
                    applying ||
                    (pending.tipo === "carta"
                      ? itemsCarta().length === 0
                      : esTpv()
                        ? itemsTpv().length === 0
                        : nMovs + nNuevas === 0)
                  }
                >
                  {applying
                    ? "Aplicando…"
                    : pending.tipo === "carta"
                      ? "Aplicar la carta"
                      : esTpv()
                        ? "Descontar las ventas"
                        : "Aplicar al inventario"}
                </button>
              </div>
            </div>
          )}
          </div>
        </div>

        {(() => {
          // Un documento cuenta como pendiente si no está aplicado y trae algo
          // que aplicar (los cierres del cron, un albarán a medio revisar…)
          const tieneContenido = (d: DocumentoRow) =>
            (d.resultado?.movimientos?.length ?? 0) +
              (d.resultado?.tpv_items?.length ?? 0) +
              (d.resultado?.carta_sugerencias?.length ?? 0) +
              (d.resultado?.nuevas_referencias?.length ?? 0) +
              (d.resultado?.carta_items?.length ?? 0) >
            0;
          const pendientes = history.filter(
            (d) => !d.aplicado && tieneContenido(d) && d.id !== pending?.documento_id
          );
          const resumen = (d: DocumentoRow) => {
            const r = d.resultado;
            if (d.tipo === "cierre") {
              const bot = (r?.tpv_items ?? []).reduce((s, i) => s + Math.abs(i.qty), 0);
              const sug = r?.carta_sugerencias?.length ?? 0;
              return `${r?.tpv_items?.length ?? 0} vinos · ${bot} botellas${sug ? ` · ${sug} por confirmar` : ""}`;
            }
            const nm = r?.movimientos?.length ?? 0;
            const nn = r?.nuevas_referencias?.length ?? 0;
            return `${nm} movimientos${nn ? ` · ${nn} nuevas` : ""}`;
          };
          return (
            <>
              {pendientes.length > 0 && (
                <>
                  <div className="section-label">
                    Pendientes de revisar ({pendientes.length})
                  </div>
                  <div className="doc-history">
                    {pendientes.map((d) => (
                      <div className="dh-item dh-pendiente" key={d.id}>
                        <div className="dh-top">
                          <span className="dh-name">{d.nombre_archivo}</span>
                          <span className={`dh-type ${d.tipo}`}>{TIPO_LABEL[d.tipo]}</span>
                        </div>
                        <div className="dh-meta">
                          {fmtFecha(d.created_at)} · {resumen(d)}
                        </div>
                        <div className="dh-acciones">
                          <button className="dh-eliminar" onClick={() => eliminarDoc(d)}>
                            Eliminar
                          </button>
                          <button className="dh-revisar" onClick={() => revisar(d)}>
                            Revisar y aplicar →
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {history.length > 0 && (
                <>
                  <div className="section-label">Documentos procesados</div>
                  <div className="doc-history">
                    {history
                      .filter((d) => !pendientes.includes(d))
                      .map((d) => {
                        const nm = d.resultado?.movimientos?.length ?? 0;
                        const nn = d.resultado?.nuevas_referencias?.length ?? 0;
                        const ne = d.resultado?.no_encontrados?.length ?? 0;
                        return (
                          <div className="dh-item" key={d.id}>
                            <div className="dh-top">
                              <span className="dh-name">{d.nombre_archivo}</span>
                              <span className={`dh-type ${d.tipo}`}>{TIPO_LABEL[d.tipo]}</span>
                            </div>
                            <div className="dh-meta">
                              {fmtFecha(d.created_at)} ·{" "}
                              {d.aplicado
                                ? `${nm} movs aplicados${nn ? ` · ${nn} nuevas` : ""}`
                                : "sin aplicar"}
                              {ne ? ` · ${ne} sin id.` : ""}
                              {d.modelo_ia ? ` · ${d.modelo_ia}` : ""}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </>
              )}
            </>
          );
        })()}
      </div>
    </>
  );
}

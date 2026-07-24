"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Tabs from "@/components/Tabs";
import {
  IconFileUp,
  IconPackage,
  IconReceipt,
  IconTable,
} from "@/components/icons";
import { createClient } from "@/lib/supabase/client";
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
};

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
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const [history, setHistory] = useState<DocumentoRow[]>([]);

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
      setPending({
        documento_id: data.documento_id,
        resultado: data.resultado,
        fileName: file.name,
      });
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

  async function aplicar() {
    if (!pending) return;
    setApplying(true);
    const { data, error } = await supabase.rpc("aplicar_documento", {
      p_documento_id: pending.documento_id,
    });
    setApplying(false);
    if (error) {
      setError("Error al aplicar: " + error.message);
      return;
    }
    const res = data as { movimientos_aplicados: number; referencias_nuevas: number };
    alert(
      `✓ Aplicado: ${res.movimientos_aplicados} movimientos${
        res.referencias_nuevas ? `, ${res.referencias_nuevas} referencias nuevas` : ""
      }.`
    );
    setPending(null);
    loadHistory();
  }

  async function descartar() {
    if (!pending) return;
    // el documento queda registrado pero sin aplicar
    setPending(null);
    loadHistory();
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
        <div className="doc-type-row" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
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
            ) : (
              <IconFileUp size={30} strokeWidth={1.5} />
            )}
          </span>
          <div className="doc-zone-title">
            {docType === "excel"
              ? "Suelta aquí tu Excel actualizado…"
              : docType === "albaran"
                ? "Suelta aquí el albarán…"
                : "Suelta aquí el cierre de caja…"}
          </div>
          <div className="doc-zone-sub">
            {docType === "excel"
              ? "Archivos .xlsx, .xls o .csv — actualiza stock, precios y referencias nuevas"
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
            <div className="dr-actions">
              <button className="btn-discard" onClick={descartar}>
                Descartar
              </button>
              <button className="btn-apply" onClick={aplicar} disabled={applying || nMovs + nNuevas === 0}>
                {applying ? "Aplicando…" : "Aplicar al inventario"}
              </button>
            </div>
          </div>
        )}

        {history.length > 0 && (
          <>
            <div className="section-label">Documentos procesados</div>
            <div className="doc-history">
              {history.map((d) => {
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
      </div>
    </>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Minus, Plus, RotateCcw } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import "./pdf-preview.css";

type Props = { file: Blob; name: string };
type LoadedPDF = { file: Blob; document: PDFDocumentProxy };
type PreviewStatus = { file: Blob; view?: string; error?: string; ready?: boolean };

let enginePromise: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;
function loadEngine() {
  enginePromise ??= import("pdfjs-dist/legacy/build/pdf.mjs").then(engine => {
    engine.GlobalWorkerOptions.workerSrc = `/pdfjs/${engine.version}/pdf.worker.min.mjs`;
    return engine;
  }).catch(error => { enginePromise = undefined; throw error; });
  return enginePromise;
}

function errorText(error: unknown) {
  if (error && typeof error === "object" && "name" in error && error.name === "PasswordException") {
    return "这份 PDF 已加密，无法在此预览。请打开原 PDF 核对。";
  }
  return "暂时无法预览这份 PDF。可以打开原 PDF 核对，已保存的评分不会受影响。";
}

/** A local-only viewer. Its canvas is never used as grading input. */
export default function PDFPreview({ file, name }: Props) {
  const [loaded, setLoaded] = useState<LoadedPDF | null>(null);
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [navigation, setNavigation] = useState({ file, page: 1, zoom: 1 });
  const [width, setWidth] = useState(400);
  const sourceRef = useRef<HTMLAnchorElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const pageNumber = navigation.file === file ? navigation.page : 1;
  const zoom = navigation.file === file ? navigation.zoom : 1;
  const viewKey = `${pageNumber}:${zoom}:${width}:${name}`;
  const current = loaded?.file === file ? loaded.document : null;
  const currentStatus = status?.file === file && (!status.view || status.view === viewKey) ? status : null;
  const setZoom = (next: number) => setNavigation({ file, page: pageNumber, zoom: next });
  const setPageNumber = (next: number) => setNavigation({ file, page: next, zoom });

  useLayoutEffect(() => {
    const url = URL.createObjectURL(file);
    const anchor = sourceRef.current;
    if (anchor) anchor.href = url;
    return () => { anchor?.removeAttribute("href"); URL.revokeObjectURL(url); };
  }, [file]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateWidth = () => setWidth(Math.max(120, Math.floor(viewport.clientWidth - 24)));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loading: PDFDocumentLoadingTask | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearLoading = () => { void loading?.destroy().catch(() => {}); };
    void (async () => {
      try {
        if (!file.size || file.size > 64 * 1024 * 1024) throw new Error("Unsupported PDF size");
        timer = setTimeout(() => {
          if (!cancelled) {
            setStatus({ file, error: "PDF 预览等待时间过长，请打开原 PDF 核对。" });
            cancelled = true;
            clearLoading();
          }
        }, 30000);
        const [engine, buffer] = await Promise.all([loadEngine(), file.arrayBuffer()]);
        if (cancelled) return;
        const assets = `/pdfjs/${engine.version}/`;
        const options = {
          data: new Uint8Array(buffer), isEvalSupported: false, enableXfa: false,
          useSystemFonts: false, cMapUrl: assets + "cmaps/", cMapPacked: true,
          iccUrl: assets + "iccs/", standardFontDataUrl: assets + "standard_fonts/",
          wasmUrl: assets + "wasm/", canvasMaxAreaInBytes: 32 * 1024 * 1024,
          stopAtErrors: true,
        };
        loading = engine.getDocument(options);
        const document = await loading.promise;
        clearTimeout(timer);
        if (cancelled) return;
        if (document.numPages < 1) throw new Error("Empty PDF");
        setLoaded({ file, document });
      } catch (error) {
        if (!cancelled) setStatus({ file, error: errorText(error) });
        clearLoading();
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => { cancelled = true; clearTimeout(timer); clearLoading(); };
  }, [file]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!current) return;
    let cancelled = false;
    let rendering: RenderTask | undefined;
    let page: PDFPageProxy | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const canvas = document.createElement("canvas");
    const viewport = viewportRef.current;
    if (viewport) { viewport.scrollTop = 0; viewport.scrollLeft = 0; }
    void (async () => {
      try {
        timer = setTimeout(() => {
          if (!cancelled) {
            setStatus({ file, view: viewKey, error: "本页预览超时，请打开原 PDF 核对。" });
            cancelled = true;
            rendering?.cancel();
          }
        }, 30000);
        page = await current.getPage(Math.min(pageNumber, current.numPages));
        if (cancelled) return;
        const original = page.getViewport({ scale: 1 });
        if (!Number.isFinite(original.width) || !Number.isFinite(original.height) || original.width <= 0 || original.height <= 0) {
          throw new Error("Invalid PDF dimensions");
        }
        const cssScale = width / original.width * zoom;
        const density = Math.min(window.devicePixelRatio || 1, 2);
        // Bound allocation even for malicious or unusually tall PDF pages.
        const renderScale = Math.min(cssScale * density, 3000 / Math.max(original.width, original.height), Math.sqrt(6_000_000 / (original.width * original.height)));
        const rendered = page.getViewport({ scale: renderScale });
        if (!Number.isFinite(rendered.width) || !Number.isFinite(rendered.height) || rendered.width <= 0 || rendered.height <= 0) {
          throw new Error("Invalid rendered PDF dimensions");
        }
        canvas.width = Math.max(1, Math.ceil(rendered.width));
        canvas.height = Math.max(1, Math.ceil(rendered.height));
        canvas.style.width = `${Math.round(original.width * cssScale)}px`;
        canvas.style.height = `${Math.round(original.height * cssScale)}px`;
        canvas.setAttribute("role", "img");
        canvas.setAttribute("aria-label", `${name}，第 ${pageNumber} 页原卷预览`);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("Canvas unavailable");
        rendering = page.render({ canvas, canvasContext: context, viewport: rendered, background: "rgb(255,255,255)" });
        await rendering.promise;
        if (cancelled) return;
        host.replaceChildren(canvas);
        setStatus({ file, view: viewKey, ready: true });
      } catch (error) {
        if (!cancelled) setStatus({ file, view: viewKey, error: errorText(error) });
      } finally {
        clearTimeout(timer);
        page?.cleanup();
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      rendering?.cancel();
      canvas.remove();
      // Release only after a cancelled render stops using the canvas.
      void Promise.resolve(rendering?.promise).catch(() => {}).finally(() => { canvas.width = 0; canvas.height = 0; });
    };
  }, [current, file, name, pageNumber, width, zoom, viewKey]);

  return <div className="pdf-preview">
    <div className="pdf-preview-toolbar" aria-label={`${name}预览操作`}>
      <div className="pdf-preview-zoom">
        <button type="button" aria-label="缩小原卷" disabled={!current || zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}><Minus size={16}/></button>
        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="放大原卷" disabled={!current || zoom >= 2.5} onClick={() => setZoom(Math.min(2.5, zoom + 0.25))}><Plus size={16}/></button>
        <button type="button" className="pdf-preview-fit" disabled={!current || zoom === 1} onClick={() => setZoom(1)}><RotateCcw size={13}/>适合宽度</button>
      </div>
      <a ref={sourceRef} target="_blank" rel="noreferrer"><ExternalLink size={14}/>打开原 PDF</a>
    </div>
    {current && current.numPages > 1 && <div className="pdf-preview-pages" aria-label="PDF 翻页">
      <button type="button" aria-label="上一页原卷" disabled={pageNumber <= 1} onClick={() => setPageNumber(pageNumber - 1)}><ChevronLeft size={16}/></button>
      <span aria-live="polite">第 {pageNumber} / {current.numPages} 页</span>
      <button type="button" aria-label="下一页原卷" disabled={pageNumber >= current.numPages} onClick={() => setPageNumber(pageNumber + 1)}><ChevronRight size={16}/></button>
    </div>}
    <div className="pdf-preview-viewport" ref={viewportRef} tabIndex={0} role="region" aria-label={`${name}原卷预览，可滚动查看`} aria-busy={!currentStatus?.ready && !currentStatus?.error}>
      {currentStatus?.error ? <p className="pdf-preview-error" role="alert">{currentStatus.error}</p> : !currentStatus?.ready && <p className="pdf-preview-loading" role="status">正在本机读取原卷…</p>}
      <div className="pdf-preview-canvas" ref={canvasHostRef} hidden={!current || !currentStatus?.ready}/>
    </div>
    <p className="pdf-preview-caption">{name} · 仅在本机预览，不产生 API 费用</p>
  </div>;
}

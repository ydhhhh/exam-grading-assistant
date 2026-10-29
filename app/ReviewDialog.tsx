"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export default function ReviewDialog({ title, eyebrow, label, busy, onClose, children }: {
  title: ReactNode; eyebrow: string; label: string; busy: boolean;
  onClose: () => void; children: ReactNode;
}) {
  const backdrop = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const siblings = Array.from(backdrop.current?.parentElement?.children || [])
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== backdrop.current)
      .map(node => ({ node, inert: node.inert }));
    siblings.forEach(({ node }) => { node.inert = true; });
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]'
    ) || []).filter(node => node.getClientRects().length > 0);
    (focusable()[0] || dialog.current)?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation();
        if (!latest.current.busy) latest.current.onClose();
      }
      if (event.key === "Tab") {
        const targets = focusable();
        if (!targets.length) { event.preventDefault(); dialog.current?.focus(); return; }
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.current?.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) {
        (focusable()[0] || dialog.current)?.focus();
      }
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin);
    return () => {
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focusin);
      document.body.style.overflow = oldOverflow;
      siblings.forEach(({ node, inert }) => { node.inert = inert; });
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return <div ref={backdrop} className="modal-backdrop" onClick={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section ref={dialog} className="review-modal" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} aria-busy={busy}>
      <div className="modal-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
        <button className="icon-button" aria-label={`关闭${label}`} onClick={onClose} disabled={busy}><X size={22}/></button>
      </div>
      {children}
    </section>
  </div>;
}

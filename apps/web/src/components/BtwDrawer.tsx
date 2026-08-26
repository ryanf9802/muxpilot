import { Check, Copy, LoaderCircle, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BtwDeltaPayload, BtwExchange } from "@muxpilot/core";
import { copyText } from "../utils/clipboard.js";
import { noAutofillTextField } from "../utils/formFields.js";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export interface ParsedBtwComposerInput {
  question: string | null;
}

export function parseBtwComposerInput(value: string): ParsedBtwComposerInput | null {
  const match = value.trim().match(/^\/btw(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  return { question: match[1]?.trim() || null };
}

export function upsertBtwExchange(exchanges: BtwExchange[], next: BtwExchange): BtwExchange[] {
  const existingIndex = exchanges.findIndex((exchange) => exchange.id === next.id);
  if (existingIndex < 0) return [...exchanges, next].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return exchanges.map((exchange, index) => index === existingIndex ? newerBtwExchange(exchange, next) : exchange);
}

export function appendBtwDelta(exchanges: BtwExchange[], payload: BtwDeltaPayload): BtwExchange[] {
  return exchanges.map((exchange) => exchange.id === payload.exchangeId
    ? { ...exchange, answer: exchange.answer + payload.delta, firstTokenAt: payload.firstTokenAt ?? exchange.firstTokenAt }
    : exchange);
}

function newerBtwExchange(existing: BtwExchange, next: BtwExchange): BtwExchange {
  if (existing.status !== "running" && next.status === "running") return existing;
  if (existing.status === "running" && next.status === "running" && existing.answer.length > next.answer.length) {
    return { ...next, answer: existing.answer, firstTokenAt: existing.firstTokenAt ?? next.firstTokenAt };
  }
  return next;
}

export function BtwDrawer({
  open,
  exchanges,
  loading,
  error,
  submitting,
  onClose,
  onAsk,
  onCancel
}: {
  open: boolean;
  exchanges: BtwExchange[];
  loading: boolean;
  error: string;
  submitting: boolean;
  onClose: () => void;
  onAsk: (question: string) => Promise<boolean>;
  onCancel: (exchangeId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const active = exchanges.find((exchange) => exchange.status === "running") ?? null;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (inputRef.current && !inputRef.current.disabled) inputRef.current.focus();
    else panelRef.current?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || event.defaultPrevented || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const activeElement = document.activeElement;
      if (event.shiftKey && (activeElement === first || !panelRef.current.contains(activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeElement === last || !panelRef.current.contains(activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || submitting || active) return;
    if (await onAsk(question)) setDraft("");
  }

  async function copyAnswer(exchange: BtwExchange) {
    if (!exchange.answer) return;
    try {
      await copyText(exchange.answer);
      setCopiedId(exchange.id);
      window.setTimeout(() => setCopiedId((current) => current === exchange.id ? null : current), 1_600);
    } catch {
      setCopiedId(null);
    }
  }

  return (
    <div className="btw-drawer-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside ref={panelRef} className="btw-drawer" role="dialog" aria-modal="true" aria-labelledby="btw-drawer-title" tabIndex={-1}>
        <header className="btw-drawer-header">
          <div>
            <h2 id="btw-drawer-title">BTW</h2>
            <p>Ask from a read-only snapshot without interrupting this session.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close BTW drawer">
            <X size={18} />
          </button>
        </header>

        <div className="btw-exchange-list" aria-live="polite">
          {loading ? <p className="btw-empty"><LoaderCircle className="spin" size={18} /> Loading BTW history…</p> : null}
          {!loading && exchanges.length === 0 ? <p className="btw-empty">No side questions yet.</p> : null}
          {exchanges.map((exchange) => (
            <article className="btw-exchange" data-status={exchange.status} key={exchange.id}>
              <div className="btw-question">
                <span>You</span>
                <p>{exchange.question}</p>
              </div>
              <div className="btw-answer">
                <div className="btw-answer-heading">
                  <span>BTW agent</span>
                  <span className="btw-status">{btwStatusLabel(exchange)}</span>
                </div>
                {exchange.answer ? (
                  <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{exchange.answer}</ReactMarkdown></div>
                ) : exchange.status === "running" ? (
                  <p className="btw-thinking"><LoaderCircle className="spin" size={15} /> Thinking from the session snapshot…</p>
                ) : null}
                {exchange.error ? <p className="btw-error" role="alert">{exchange.error}</p> : null}
                <div className="btw-exchange-actions">
                  {exchange.status === "running" ? (
                    <button type="button" onClick={() => void onCancel(exchange.id)}>
                      <Square size={13} /> Cancel
                    </button>
                  ) : null}
                  {exchange.answer ? (
                    <button type="button" onClick={() => void copyAnswer(exchange)}>
                      {copiedId === exchange.id ? <Check size={13} /> : <Copy size={13} />}
                      {copiedId === exchange.id ? "Copied" : "Copy"}
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>

        <form className="btw-composer" onSubmit={submit}>
          <textarea
            {...noAutofillTextField}
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={active ? "Wait for the active BTW answer" : "Ask a quick side question"}
            disabled={Boolean(active) || submitting}
            maxLength={20_000}
            rows={3}
          />
          <button
            className="send-button"
            type="submit"
            disabled={Boolean(active) || submitting || !draft.trim()}
            aria-label={submitting ? "Asking BTW agent" : "Ask BTW agent"}
            aria-busy={submitting}
          >
            {submitting ? <LoaderCircle className="spin" size={19} /> : <Send size={19} />}
          </button>
        </form>
        {error ? <p className="btw-error btw-drawer-error" role="alert">{error}</p> : null}
      </aside>
    </div>
  );
}

function btwStatusLabel(exchange: BtwExchange): string {
  if (exchange.status === "running") return exchange.firstTokenAt ? "Answering" : "Starting";
  if (exchange.status === "completed") return "Complete";
  if (exchange.status === "cancelled") return "Cancelled";
  return "Failed";
}

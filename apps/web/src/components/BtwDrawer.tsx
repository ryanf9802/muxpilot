import {
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  Copy,
  LoaderCircle,
  MessageCircleQuestion,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  X
} from "lucide-react";
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
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const previousExchangeCountRef = useRef(exchanges.length);
  const active = exchanges.find((exchange) => exchange.status === "running") ?? null;
  const latest = exchanges.at(-1) ?? null;
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (inputRef.current && !inputRef.current.disabled) inputRef.current.focus();
    else panelRef.current?.focus();
    window.requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });
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

  useEffect(() => {
    const list = listRef.current;
    const previousCount = previousExchangeCountRef.current;
    previousExchangeCountRef.current = exchanges.length;
    if (!open || !list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (exchanges.length > previousCount || distanceFromBottom < 140) {
      window.requestAnimationFrame(() => list.scrollTo({ top: list.scrollHeight, behavior: "smooth" }));
    }
  }, [exchanges.length, latest?.answer.length, latest?.status, open]);

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
          <div className="btw-title-lockup">
            <span className="btw-brand-mark" aria-hidden="true"><MessageCircleQuestion size={20} /></span>
            <div>
              <span className="btw-eyebrow">BTW</span>
              <h2 id="btw-drawer-title">Side questions</h2>
              <p>One-off answers while the main task keeps moving.</p>
            </div>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close BTW drawer">
            <X size={18} />
          </button>
          <div className="btw-context-strip" role="note">
            <RefreshCw size={15} aria-hidden="true" />
            <span>
              <strong>Fresh main-session snapshot every time</strong>
              <small>Read-only; earlier BTW questions and answers aren’t included.</small>
            </span>
          </div>
        </header>

        <div ref={listRef} className="btw-exchange-list" role="region" aria-label="Saved independent question history" aria-live="polite">
          {loading ? (
            <div className="btw-empty">
              <span className="btw-empty-icon"><LoaderCircle className="spin" size={22} /></span>
              <strong>Loading side questions</strong>
              <span>Restoring the separate BTW history…</span>
            </div>
          ) : null}
          {!loading && exchanges.length === 0 ? (
            <div className="btw-empty">
              <span className="btw-empty-icon"><Sparkles size={22} /></span>
              <strong>Ask without changing course</strong>
              <span>Each answer starts from a fresh snapshot of the latest main session.</span>
            </div>
          ) : null}
          {!loading && exchanges.length > 0 ? (
            <div className="btw-history-heading">
              <span>
                <strong>Saved question history</strong>
                <small>Visible to you, not carried into the next answer.</small>
              </span>
              <span>{exchangeCountLabel(exchanges.length)}</span>
            </div>
          ) : null}
          {exchanges.map((exchange, index) => (
            <article className="btw-exchange" data-status={exchange.status} data-latest={index === exchanges.length - 1 || undefined} key={exchange.id}>
              <header className="btw-exchange-heading">
                <span className="btw-exchange-number">Question {String(index + 1).padStart(2, "0")}</span>
                <time dateTime={exchange.createdAt}>{formatBtwTime(exchange.createdAt)}</time>
                <span className="btw-status">{btwStatusIcon(exchange)} {btwStatusLabel(exchange)}</span>
              </header>
              <div className="btw-question">
                <span>You asked</span>
                <p>{exchange.question}</p>
              </div>
              <div className="btw-answer">
                <div className="btw-answer-heading">
                  <span className="btw-agent-mark"><Sparkles size={13} /></span>
                  <span>Independent answer</span>
                </div>
                {exchange.answer ? (
                  <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{exchange.answer}</ReactMarkdown></div>
                ) : exchange.status === "running" ? (
                  <div className="btw-thinking">
                    <LoaderCircle className="spin" size={15} />
                    <span><strong>Checking the session snapshot</strong><small>This won’t pause or steer the active task.</small></span>
                  </div>
                ) : null}
                {exchange.error ? <p className="btw-error" role="alert"><CircleAlert size={15} /> <span>{exchange.error}</span></p> : null}
                <div className="btw-exchange-actions">
                  {exchange.status === "running" ? (
                    <button type="button" className="btw-action-button btw-cancel-button" onClick={() => void onCancel(exchange.id)}>
                      <Square size={13} /> Cancel
                    </button>
                  ) : null}
                  {exchange.answer ? (
                    <button type="button" className="btw-action-button" onClick={() => void copyAnswer(exchange)}>
                      {copiedId === exchange.id ? <Check size={13} /> : <Copy size={13} />}
                      {copiedId === exchange.id ? "Copied" : "Copy answer"}
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>

        <footer className="btw-composer-shell">
          {error ? <p className="btw-error btw-drawer-error" role="alert"><CircleAlert size={15} /> <span>{error}</span></p> : null}
          <form className="btw-composer" onSubmit={submit}>
            <div className="btw-composer-heading">
              <label htmlFor="btw-question-input">Ask a new independent question</label>
              <span><kbd>Ctrl</kbd><kbd>Enter</kbd></span>
            </div>
            <div className="btw-composer-control">
              <textarea
                {...noAutofillTextField}
                id="btw-question-input"
                ref={inputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder={active ? "Waiting for the current answer…" : "What do you want to know?"}
                disabled={Boolean(active) || submitting}
                maxLength={20_000}
                rows={2}
              />
              <button
                className="btw-send-button"
                type="submit"
                disabled={Boolean(active) || submitting || !draft.trim()}
                aria-label={submitting ? "Asking BTW agent" : "Ask BTW agent"}
                aria-busy={submitting}
              >
                {submitting ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
              </button>
            </div>
          </form>
          <p className="btw-composer-note"><ShieldCheck size={13} /> Uses the latest main session—not this BTW history</p>
        </footer>
      </aside>
    </div>
  );
}

function exchangeCountLabel(count: number): string {
  if (count === 0) return "No questions yet";
  return `${count} ${count === 1 ? "question" : "questions"}`;
}

function formatBtwTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}

function btwStatusIcon(exchange: BtwExchange) {
  if (exchange.status === "running") return <LoaderCircle className="spin" size={12} />;
  if (exchange.status === "completed") return <CircleCheck size={12} />;
  if (exchange.status === "failed") return <CircleAlert size={12} />;
  return <Clock3 size={12} />;
}

function btwStatusLabel(exchange: BtwExchange): string {
  if (exchange.status === "running") return exchange.firstTokenAt ? "Answering" : "Starting";
  if (exchange.status === "completed") return "Complete";
  if (exchange.status === "cancelled") return "Cancelled";
  return "Failed";
}

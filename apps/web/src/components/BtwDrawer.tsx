import {
  CircleAlert,
  CircleCheck,
  Clock3,
  Copy,
  FileText,
  LoaderCircle,
  Send,
  Square,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { BtwDeltaPayload, BtwExchange } from "@muxpilot/core";
import { copyText } from "../utils/clipboard.js";
import { noAutofillTextField } from "../utils/formFields.js";
import {
  ContextMenu,
  ContextMenuItem,
  clampContextMenuPosition,
  useContextMenuTrigger,
  useDismissableContextMenu,
  type ContextMenuPosition
} from "./ContextMenu.js";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

const BTW_COPY_MENU_WIDTH = 190;
const BTW_COPY_MENU_HEIGHT = 54;

interface BtwCopyTarget {
  kind: "question" | "answer";
  exchangeId: string;
}

interface BtwCopyMenu extends BtwCopyTarget {
  position: ContextMenuPosition;
}

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
  onCancel,
  onOpenDocument
}: {
  open: boolean;
  exchanges: BtwExchange[];
  loading: boolean;
  error: string;
  submitting: boolean;
  onClose: () => void;
  onAsk: (question: string) => Promise<boolean>;
  onCancel: (exchangeId: string) => Promise<void>;
  onOpenDocument: (name: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [copyMenu, setCopyMenu] = useState<BtwCopyMenu | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const copyMenuRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const previousExchangeCountRef = useRef(exchanges.length);
  const active = exchanges.find((exchange) => exchange.status === "running") ?? null;
  const latest = exchanges.at(-1) ?? null;
  onCloseRef.current = onClose;

  useDismissableContextMenu(Boolean(copyMenu), copyMenuRef, () => setCopyMenu(null));

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
      window.requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
    }
  }, [exchanges.length, latest?.answer.length, latest?.status, open]);

  useEffect(() => {
    if (!open) setCopyMenu(null);
  }, [open]);

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || submitting || active) return;
    if (await onAsk(question)) setDraft("");
  }

  function openCopyMenu(target: BtwCopyTarget, x: number, y: number) {
    setCopyMenu({
      ...target,
      position: clampContextMenuPosition(x, y, {
        width: BTW_COPY_MENU_WIDTH,
        height: BTW_COPY_MENU_HEIGHT
      })
    });
  }

  async function copyFromMenu() {
    if (!copyMenu) return;
    const target = copyMenu;
    setCopyMenu(null);
    const exchange = exchanges.find((candidate) => candidate.id === target.exchangeId);
    if (!exchange) return;
    const text = target.kind === "question" ? exchange.question : exchange.answer;
    if (!text) return;
    try {
      await copyText(text);
    } catch (copyError) {
      console.error(copyError);
    }
  }

  return (
    <div className="btw-drawer-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside ref={panelRef} className="btw-drawer" role="dialog" aria-modal="true" aria-labelledby="btw-drawer-title" tabIndex={-1}>
        <header className="btw-drawer-header">
          <div>
            <h2 id="btw-drawer-title">BTW side questions</h2>
            <p>Ask questions or update Documents without interrupting the main task.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close BTW drawer">
            <X size={18} />
          </button>
          <p className="btw-context-note" role="note">
            <strong>Each request is independent.</strong> It uses a fresh snapshot of the main session. Document changes are isolated until muxpilot can hand them off safely.
          </p>
        </header>

        <div ref={listRef} className="btw-exchange-list" role="region" aria-label="Saved independent question history" aria-live="polite">
          {loading ? (
            <div className="btw-empty">
              <LoaderCircle className="spin" size={16} />
              <span>Loading side-question history…</span>
            </div>
          ) : null}
          {!loading && exchanges.length === 0 ? (
            <div className="btw-empty">
              <strong>No side questions yet</strong>
              <span>Ask a question to get an independent answer from the current main session.</span>
            </div>
          ) : null}
          {!loading && exchanges.length > 0 ? (
            <div className="btw-history-heading">
              <strong>History</strong>
              <span>{exchangeCountLabel(exchanges.length)}</span>
            </div>
          ) : null}
          {exchanges.map((exchange, index) => (
            <article className="btw-exchange" data-status={exchange.status} key={exchange.id}>
              <header className="btw-exchange-heading">
                <span className="btw-exchange-number">Question {String(index + 1).padStart(2, "0")}</span>
                <time dateTime={exchange.createdAt}>{formatBtwTime(exchange.createdAt)}</time>
                <span className="btw-status">{btwStatusIcon(exchange)} {btwStatusLabel(exchange)}</span>
              </header>
              <BtwCopyableSection
                className="btw-question"
                target={{ kind: "question", exchangeId: exchange.id }}
                onOpenMenu={openCopyMenu}
              >
                <span>You asked</span>
                <p>{exchange.question}</p>
              </BtwCopyableSection>
              <BtwCopyableSection
                className="btw-answer"
                target={{ kind: "answer", exchangeId: exchange.id }}
                onOpenMenu={openCopyMenu}
                disabled={!exchange.answer}
              >
                <div className="btw-answer-heading">
                  <span>Answer</span>
                </div>
                {exchange.answer ? (
                  <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{exchange.answer}</ReactMarkdown></div>
                ) : exchange.status === "running" ? (
                  <div className="btw-thinking">
                    <LoaderCircle className="spin" size={15} />
                    <span>{exchange.documentOperation ? documentOperationLabel(exchange.documentOperation.phase) : "Checking the current session snapshot…"}</span>
                  </div>
                ) : null}
                {exchange.error ? <p className="btw-error" role="alert"><CircleAlert size={15} /> <span>{exchange.error}</span></p> : null}
                {exchange.documentOperation ? (
                  <DocumentOperation exchange={exchange} onOpenDocument={onOpenDocument} />
                ) : null}
                {exchange.status === "running" ? (
                  <div className="btw-exchange-actions">
                    <button type="button" className="btw-action-button btw-cancel-button" onClick={() => void onCancel(exchange.id)}>
                      <Square size={13} /> Cancel
                    </button>
                  </div>
                ) : null}
              </BtwCopyableSection>
            </article>
          ))}
        </div>

        <footer className="btw-composer-shell">
          {error ? <p className="btw-error btw-drawer-error" role="alert"><CircleAlert size={15} /> <span>{error}</span></p> : null}
          <form className="btw-composer" onSubmit={submit}>
            <div className="btw-composer-heading">
              <label htmlFor="btw-question-input">Ask a question or request a document update</label>
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
                placeholder={active ? "Waiting for the current request…" : "Ask a question, or describe the document you want…"}
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
        </footer>

        {copyMenu ? (
          <ContextMenu
            ref={copyMenuRef}
            position={copyMenu.position}
            width={BTW_COPY_MENU_WIDTH}
            label={`BTW ${copyMenu.kind} actions`}
          >
            <ContextMenuItem icon={<Copy size={16} />} onClick={() => void copyFromMenu()}>
              Copy {copyMenu.kind}
            </ContextMenuItem>
          </ContextMenu>
        ) : null}
      </aside>
    </div>
  );
}

function BtwCopyableSection({
  className,
  target,
  onOpenMenu,
  disabled = false,
  children
}: {
  className: string;
  target: BtwCopyTarget;
  onOpenMenu: (target: BtwCopyTarget, x: number, y: number) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  const menuTrigger = useContextMenuTrigger(target, onOpenMenu, { disabled });
  return <div className={`${className}${disabled ? "" : " btw-copyable-section"}`} {...menuTrigger.triggerProps}>{children}</div>;
}

function DocumentOperation({ exchange, onOpenDocument }: { exchange: BtwExchange; onOpenDocument: (name: string) => void }) {
  const documentOperation = exchange.documentOperation!;
  const documents = [
    ...documentOperation.created.map((name) => ({ name, kind: "Created" })),
    ...documentOperation.updated.map((name) => ({ name, kind: "Updated" }))
  ];
  return (
    <section className="btw-document-operation" data-phase={documentOperation.phase} data-status={exchange.status}>
      <div className="btw-document-operation-heading">
        {exchange.status === "failed" || exchange.status === "cancelled" || documentOperation.phase === "conflict"
          ? <CircleAlert size={14} />
          : documentOperation.phase === "applied"
            ? <CircleCheck size={14} />
            : <LoaderCircle className="spin" size={14} />}
        <strong>{documentOperationStatusLabel(exchange)}</strong>
      </div>
      {documents.length > 0 ? (
        <div className="btw-document-links">
          {documents.map((document) => (
            <button key={`${document.kind}-${document.name}`} type="button" disabled={documentOperation.phase !== "applied"} onClick={() => onOpenDocument(document.name)}>
              <FileText size={13} />
              <span>{document.name}</span>
              <small>{document.kind}</small>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function documentOperationStatusLabel(exchange: BtwExchange): string {
  if (exchange.status === "cancelled") return "Document update cancelled";
  if (exchange.status === "failed" && exchange.documentOperation?.phase !== "conflict") return "Document update failed";
  return documentOperationLabel(exchange.documentOperation!.phase);
}

function documentOperationLabel(phase: NonNullable<BtwExchange["documentOperation"]>["phase"]): string {
  if (phase === "waiting") return "Waiting for a safe handoff";
  if (phase === "retrying") return "Documents changed; regenerating once";
  if (phase === "notifying") return "Documents saved; notifying the main agent";
  if (phase === "applied") return "Document changes applied";
  return "Document changes conflicted";
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
  if (exchange.status === "running" && exchange.documentOperation?.phase === "waiting") return "Handing off";
  if (exchange.status === "running" && exchange.documentOperation?.phase === "retrying") return "Regenerating";
  if (exchange.status === "running" && exchange.documentOperation?.phase === "notifying") return "Notifying";
  if (exchange.status === "running") return exchange.firstTokenAt ? "Answering" : "Starting";
  if (exchange.status === "completed") return "Complete";
  if (exchange.status === "cancelled") return "Cancelled";
  return "Failed";
}

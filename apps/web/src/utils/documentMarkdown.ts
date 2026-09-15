export interface DocumentHeadingEntry {
  id: string;
  label: string;
  level: number;
  path: string;
}

export interface ObsidianExportOptions {
  currentDocument: string;
  headingsByDocument: Map<string, DocumentHeadingEntry[]>;
  documentNames: string[];
}

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

const ESCAPED_WIKILINK_OPEN = "\uE000";
const ESCAPED_HIGHLIGHT_OPEN = "\uE001";

export function remarkObsidianSyntax() {
  return (tree: MarkdownNode) => {
    visitMarkdownNodes(tree, (node) => {
      if (node.type === "blockquote") decorateCallout(node);
    });
    transformInlineObsidianNodes(tree);
  };
}

export function renderableDocumentMarkdown(source: string): string {
  let inComment = false;
  return transformMarkdownText(source, (text) => {
    let rendered = "";
    let cursor = 0;
    while (cursor < text.length) {
      if (inComment) {
        const end = text.indexOf("%%", cursor);
        if (end < 0) return rendered;
        cursor = end + 2;
        inComment = false;
        continue;
      }
      const start = text.indexOf("%%", cursor);
      const visibleEnd = start < 0 ? text.length : start;
      rendered += text.slice(cursor, visibleEnd)
        .replace(/\\\[\[/g, `${ESCAPED_WIKILINK_OPEN}[`)
        .replace(/\\==/g, `${ESCAPED_HIGHLIGHT_OPEN}=`);
      if (start < 0) break;
      cursor = start + 2;
      inComment = true;
    }
    return rendered;
  });
}

export function portableDocumentMarkdown(source: string): string {
  let inComment = false;
  let output = transformMarkdownText(source, (text) => {
    let withoutComments = "";
    let removedComment = false;
    let cursor = 0;
    while (cursor < text.length) {
      if (inComment) {
        removedComment = true;
        const end = text.indexOf("%%", cursor);
        if (end < 0) return withoutComments;
        cursor = end + 2;
        inComment = false;
        continue;
      }
      const start = text.indexOf("%%", cursor);
      withoutComments += text.slice(cursor, start < 0 ? text.length : start);
      if (start < 0) break;
      removedComment = true;
      cursor = start + 2;
      inComment = true;
    }
    const visibleText = removedComment ? withoutComments.replace(/[ \t]+(?=\n?$)/, "") : withoutComments;
    return visibleText
      .replace(/(?<!\\)==([^=\n]+)==/g, "**$1**")
      .replace(/(?<!!)(?<!\\)\[\[([^\]\n]+)\]\]/g, (_match, inner: string) => wikilinkAsMarkdown(inner));
  });
  output = transformMarkdownText(output, (text) => text.replace(
    /^(\s*>\s*)\[!([A-Za-z0-9_-]+)\][+-]?(?:[ \t]+([^\n]+))?$/gm,
    (_match, prefix: string, type: string, title?: string) => `${prefix}**${title?.trim() || titleCase(type)}**`
  ));
  return normalizeExport(output);
}

export function obsidianDocumentMarkdown(source: string, options: ObsidianExportOptions): string {
  const documentNames = new Map(options.documentNames.map((name) => [name.toLowerCase(), name]));
  return transformMarkdownText(source, (text) => text.replace(
    /(?<!!)(?<!\\)\[([^\]\n]+)\]\((<?)([^)\n>]+)(>?)\)/g,
    (match, label: string, _opening: string, href: string) => {
      const parsed = internalMarkdownTarget(href, options.currentDocument, documentNames);
      if (!parsed) return match;
      const headings = options.headingsByDocument.get(parsed.document) ?? [];
      const heading = parsed.fragment ? headingLabelForFragment(headings, parsed.fragment) : null;
      const note = stripMarkdownExtension(parsed.document);
      const target = parsed.sameDocument
        ? heading ? `#${heading}` : `#${decodeFragment(parsed.fragment ?? "")}`
        : `${note}${heading ? `#${heading}` : parsed.fragment ? `#${decodeFragment(parsed.fragment)}` : ""}`;
      const defaultLabel = parsed.sameDocument
        ? heading ?? decodeFragment(parsed.fragment ?? "")
        : heading ? `${note}#${heading}` : note;
      return `[[${target}${label === defaultLabel ? "" : `|${label}`}]]`;
    }
  ));
}

export function markdownDocumentHeadings(source: string): DocumentHeadingEntry[] {
  const headings: DocumentHeadingEntry[] = [];
  const path: string[] = [];
  const occurrences = new Map<string, number>();
  transformMarkdownText(source, (text) => {
    for (const line of text.split("\n")) {
      const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (!match) continue;
      const level = match[1]!.length;
      const label = plainHeadingText(match[2]!);
      const base = markdownHeadingSlug(label);
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      path[level - 1] = label;
      path.length = level;
      headings.push({
        id: occurrence === 0 ? base : `${base}-${occurrence}`,
        label,
        level,
        path: path.filter(Boolean).join("#")
      });
    }
    return text;
  });
  return headings;
}

export function referencedDocumentNames(source: string, documentNames: string[]): string[] {
  const available = new Map(documentNames.map((name) => [name.toLowerCase(), name]));
  const found = new Set<string>();
  transformMarkdownText(source, (text) => {
    for (const match of text.matchAll(/(?<!!)(?<!\\)\[[^\]\n]+\]\((?:<)?([^)>\n]+)(?:>)?\)/g)) {
      const parsed = internalMarkdownTarget(match[1]!, "", available);
      if (parsed && !parsed.sameDocument) found.add(parsed.document);
    }
    return text;
  });
  return [...found];
}

export function resolveDocumentHeading(headings: DocumentHeadingEntry[], reference: string): string | null {
  const decoded = decodeFragment(reference).replace(/^#+/, "");
  const exact = headings.find((heading) => heading.id === decoded);
  if (exact) return exact.id;
  const normalized = normalizeHeadingReference(decoded);
  return headings.find((heading) => normalizeHeadingReference(heading.path) === normalized)?.id
    ?? headings.find((heading) => normalizeHeadingReference(heading.label) === normalized)?.id
    ?? null;
}

export function markdownHeadingSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
}

function inlineObsidianNodes(value: string): MarkdownNode[] | null {
  const pattern = /(?<!\\)==([^=\n]+)==|(?<!!)(?<!\\)\[\[([^\]\n]+)\]\]/g;
  const children: MarkdownNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    if (match.index > cursor) children.push({ type: "text", value: restoreEscapedObsidianSyntax(value.slice(cursor, match.index)) });
    if (match[1] !== undefined) {
      children.push({ type: "strong", data: { hName: "mark" }, children: [{ type: "text", value: match[1] }] });
    } else {
      const parsed = parseWikilink(match[2]!);
      children.push({ type: "link", url: parsed.href, children: [{ type: "text", value: parsed.label }] });
    }
    cursor = pattern.lastIndex;
  }
  if (cursor === 0) return null;
  if (cursor < value.length) children.push({ type: "text", value: restoreEscapedObsidianSyntax(value.slice(cursor)) });
  return children;
}

function decorateCallout(node: MarkdownNode) {
  const paragraph = node.children?.[0];
  const marker = paragraph?.children?.[0];
  const match = marker?.type === "text" && marker.value
    ? /^\[!([A-Za-z0-9_-]+)\]([+-])?(?:[ \t]+([^\n]+))?/.exec(marker.value)
    : null;
  if (!match || !paragraph || !marker) return;
  const type = match[1]!.toLowerCase();
  const title = match[3]?.trim() || titleCase(type);
  marker.value = marker.value!.slice(match[0].length).replace(/^\s+/, "");
  if (!marker.value) paragraph.children!.shift();
  if (paragraph.children?.length === 0) node.children!.shift();
  const titleNode: MarkdownNode = {
    type: "paragraph",
    data: { hName: match[2] ? "summary" : "div", hProperties: { className: ["obsidian-callout-title"] } },
    children: [{ type: "text", value: title }]
  };
  node.children!.unshift(titleNode);
  node.data = {
    hName: match[2] ? "details" : "blockquote",
    hProperties: {
      className: ["obsidian-callout"],
      "data-callout": type,
      ...(match[2] === "+" ? { open: true } : {})
    }
  };
}

function visitMarkdownNodes(node: MarkdownNode, visitor: (node: MarkdownNode) => void) {
  visitor(node);
  for (const child of node.children ?? []) visitMarkdownNodes(child, visitor);
}

function transformInlineObsidianNodes(node: MarkdownNode) {
  if (!node.children) return;
  const children: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      const replacement = inlineObsidianNodes(child.value);
      if (replacement) children.push(...replacement);
      else children.push({ ...child, value: restoreEscapedObsidianSyntax(child.value) });
    } else {
      transformInlineObsidianNodes(child);
      children.push(child);
    }
  }
  node.children = children;
}

function parseWikilink(inner: string, portable = false): { href: string; label: string } {
  const separator = inner.indexOf("|");
  const target = (separator >= 0 ? inner.slice(0, separator) : inner).trim();
  const alias = separator >= 0 ? inner.slice(separator + 1).trim() : "";
  const hash = target.indexOf("#");
  const rawDocument = hash >= 0 ? target.slice(0, hash).trim() : target;
  const heading = hash >= 0 ? target.slice(hash + 1).trim() : "";
  const document = rawDocument && !/\.md$/i.test(rawDocument) ? `${rawDocument}.md` : rawDocument;
  const headingFragment = portable ? markdownHeadingSlug(heading.split("#").at(-1) ?? heading) : encodeURIComponent(heading);
  const href = `${document ? `./${encodeURIComponent(document)}` : ""}${heading ? `#${headingFragment}` : ""}`;
  return { href, label: alias || target.replace(/\.md(?=#|$)/i, "") };
}

function wikilinkAsMarkdown(inner: string): string {
  const parsed = parseWikilink(inner, true);
  return `[${parsed.label}](${parsed.href})`;
}

function internalMarkdownTarget(
  rawHref: string,
  currentDocument: string,
  documents: Map<string, string>
): { document: string; fragment: string | null; sameDocument: boolean } | null {
  const href = rawHref.trim().replace(/^<|>$/g, "");
  if (!href || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("//")) return null;
  const hash = href.indexOf("#");
  const rawDocument = (hash >= 0 ? href.slice(0, hash) : href).replace(/^\.\//, "");
  const fragment = hash >= 0 ? href.slice(hash + 1) : null;
  if (!rawDocument) return currentDocument ? { document: currentDocument, fragment, sameDocument: true } : null;
  let decoded = rawDocument;
  try { decoded = decodeURIComponent(rawDocument); } catch { /* Keep authored path. */ }
  const document = resolveDocumentName(decoded, documents);
  return document ? { document, fragment, sameDocument: document === currentDocument } : null;
}

function resolveDocumentName(value: string, documents: Map<string, string>): string | null {
  if (!value || value.includes("/")) return null;
  return documents.get(value.toLowerCase())
    ?? documents.get(`${value}.md`.toLowerCase())
    ?? null;
}

function headingLabelForFragment(headings: DocumentHeadingEntry[], fragment: string): string | null {
  const id = resolveDocumentHeading(headings, fragment);
  return headings.find((heading) => heading.id === id)?.label ?? null;
}

function transformMarkdownText(source: string, transform: (text: string) => string): string {
  const lines = source.split(/(?<=\n)/);
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced) return line;
    const parts = line.split(/(`+[^`\n]*`+)/g);
    return parts.map((part, index) => index % 2 === 1 ? part : transform(part)).join("");
  }).join("");
}

function normalizeExport(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function normalizeHeadingReference(value: string): string {
  return value.split("#").map((part) => part.trim().toLocaleLowerCase()).join("#");
}

function decodeFragment(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function stripMarkdownExtension(value: string): string {
  return value.replace(/\.md$/i, "");
}

function plainHeadingText(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, alias?: string) => alias || target)
    .replace(/[*_~=`]/g, "")
    .trim();
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/^\w/, (character) => character.toUpperCase());
}

function restoreEscapedObsidianSyntax(value: string): string {
  return value.replaceAll(ESCAPED_WIKILINK_OPEN, "[").replaceAll(ESCAPED_HIGHLIGHT_OPEN, "=");
}

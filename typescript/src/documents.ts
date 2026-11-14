/**
 * Lecture des documents chez vous, puis découpage selon leur structure (préversion).
 *
 * WYRLO ne garde jamais le texte : vos fichiers sont lus **sur votre machine**, découpés ici,
 * et seuls les passages partent pour le calcul des vecteurs (`wyrlo.index({ passages })`).
 *
 *   import { readDocument, splitDocument } from "@wyrlo/sdk/documents";
 *
 *   const doc = await readDocument("tarifs.docx");
 *   await wyrlo.index({ document: "tarifs.docx", version: "2026-11",
 *                       passages: splitDocument(doc), title: doc.title });
 *   // Relecture pour search() et answer() : doc.text.slice(start, start + length).
 *
 * Formats : Markdown, HTML, texte et DOCX sans dépendance (Node 18 ou plus) ; PDF avec texte
 * grâce à `pdfjs-dist`, à installer à part (`npm install pdfjs-dist`). Les tableaux d'un PDF
 * ne sont pas reconstruits ici et les PDF scannés ne sont pas lus : pour les PDF à tableaux,
 * PPTX et XLSX, utilisez le SDK Python (`wyrlo[documents]`).
 *
 * Chaque ligne d'un tableau (Markdown, HTML, DOCX) est écrite avec ses en-têtes
 * (« Produit : Vélo | Prix : 900 € ») ; chaque passage est une tranche exacte de `doc.text`.
 */

export type BlockKind = "heading" | "paragraph" | "list" | "table_row";

export interface Block {
  kind: BlockKind;
  text: string;
  /** Niveau d'un titre (1 pour le plus haut) ; 0 sinon. */
  level: number;
  /** Position du bloc dans `ParsedDocument.text`. */
  start: number;
  /** Numéro du tableau (lignes d'un même tableau) ; 0 sinon. */
  table: number;
  /** Titre de la section où se trouve le bloc ; vide sinon. */
  section: string;
}

export interface ParsedDocument {
  /** Texte linéaire du document, dans l'ordre de lecture. */
  text: string;
  blocks: Block[];
  /** Premier titre du document, s'il en a un (à passer à `index({ title })`). */
  title?: string;
}

export interface DocumentPassage {
  text: string;
  start: number;
  /** Titre de la section, placé devant le passage pour les vecteurs seulement. */
  context?: string;
}

/** Taille visée et taille maximale d'un passage, en caractères (comme le découpage de WYRLO). */
export const TARGET_CHARS = 600;
export const MAX_CHARS = 900;
const CONTEXT_CHARS = 300;

type Draft = Pick<Block, "kind" | "text"> & Partial<Pick<Block, "level" | "table">>;

const clean = (text: string) =>
  text
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .trim();

/** Une ligne de tableau avec ses en-têtes : « Produit : Vélo | Prix : 900 € ». */
function row(headers: string[], cells: string[]): string {
  const parts: string[] = [];
  cells.forEach((cell, index) => {
    const value = clean(cell).replace(/\n/g, " ");
    if (!value) return;
    const name = clean(headers[index] ?? "").replace(/\n/g, " ");
    parts.push(name && name !== value ? `${name} : ${value}` : value);
  });
  return parts.join(" | ");
}

/** Blocs d'un tableau : la première ligne non vide donne les en-têtes. */
function tableBlocks(rows: string[][], table: number): Draft[] {
  const filled = rows.filter((cells) => cells.some((cell) => clean(cell)));
  if (filled.length === 0) return [];
  const [headers, ...data] = filled as [string[], ...string[][]];
  const lines = data.length ? data.map((cells) => row(headers, cells)) : [row([], headers)];
  return lines.filter(Boolean).map((text) => ({ kind: "table_row" as const, text, table }));
}

/**
 * Assemble le texte linéaire : une ligne vide entre les blocs, un simple retour à la ligne
 * entre deux lignes du même tableau ; pose la position et la section de chaque bloc.
 */
export function documentFromBlocks(drafts: Draft[]): ParsedDocument {
  const blocks: Block[] = [];
  let text = "";
  let section = "";
  let previous: Block | undefined;
  for (const draft of drafts) {
    if (!draft.text) continue;
    const table = draft.table ?? 0;
    if (previous) {
      const sameTable = draft.kind === "table_row" && table !== 0 && previous.table === table;
      text += sameTable ? "\n" : "\n\n";
    }
    if (draft.kind === "heading") section = draft.text.trim();
    const block: Block = {
      kind: draft.kind,
      text: draft.text,
      level: draft.level ?? 0,
      start: text.length,
      table,
      section: draft.kind === "heading" ? "" : section,
    };
    text += draft.text;
    blocks.push(block);
    previous = block;
  }
  const title = blocks.find((b) => b.kind === "heading")?.text;
  return { text, blocks, ...(title ? { title } : {}) };
}

// ------------------------------------------------------------------ Markdown et texte
const MD_HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const MD_LIST = /^\s*(?:[-*+]|\d+[.)])\s+/;
const MD_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Blocs d'un texte Markdown (ou d'un texte simple : paragraphes séparés d'une ligne vide). */
export function blocksFromMarkdown(source: string): Draft[] {
  const blocks: Draft[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];
  let rows: string[][] = [];
  let tables = 0;
  let fenced = false;
  const flushText = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: clean(paragraph.join(" ")) });
    if (items.length) blocks.push({ kind: "list", text: items.join("\n") });
    paragraph = [];
    items = [];
  };
  const flush = () => {
    flushText();
    if (rows.length) blocks.push(...tableBlocks(rows, ++tables));
    rows = [];
  };
  for (const raw of source.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      flush();
      continue;
    }
    if (fenced) {
      paragraph.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = MD_HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({
        kind: "heading",
        text: clean(heading[2] ?? ""),
        level: (heading[1] ?? "").length,
      });
    } else if (line.trim().startsWith("|") && line.split("|").length >= 3) {
      flushText();
      if (!MD_RULE.test(line)) {
        rows.push(
          line
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((cell) => cell.trim()),
        );
      }
    } else if (MD_LIST.test(line)) {
      if (paragraph.length || rows.length) flush();
      items.push(clean(line));
    } else if (items.length && /^[ \t]/.test(raw)) {
      items[items.length - 1] += ` ${clean(line)}`;
    } else {
      if (items.length || rows.length) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks.filter((b) => b.text);
}

// ------------------------------------------------------------------ HTML
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  acirc: "â",
  ccedil: "ç",
  ugrave: "ù",
  ocirc: "ô",
  icirc: "î",
  euro: "€",
  laquo: "«",
  raquo: "»",
  rsquo: "’",
  lsquo: "‘",
  hellip: "…",
  ndash: "–",
  mdash: "—",
};
const decode = (text: string) =>
  text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code =
        name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
const SKIPPED = new Set(["script", "style", "noscript", "template", "svg", "head"]);
const BREAKS = new Set(["p", "div", "section", "article", "blockquote", "pre", "br", "dl"]);

/** Blocs d'une page HTML : titres, paragraphes, listes, tableaux ; scripts et styles ignorés. */
export function blocksFromHtml(source: string): Draft[] {
  const blocks: Draft[] = [];
  let buffer = "";
  let items: string[] = [];
  let rows: string[][] = [];
  let cells: string[] | null = null;
  let cell: string | null = null;
  let heading = 0;
  let inItem = 0;
  let depth = 0;
  let tables = 0;
  let skip = "";
  const takeText = () => {
    const text = clean(decode(buffer).replace(/\n/g, " "));
    buffer = "";
    return text;
  };
  const flush = () => {
    const text = takeText();
    if (text) blocks.push({ kind: "paragraph", text });
  };
  const flushList = () => {
    if (items.length) blocks.push({ kind: "list", text: items.join("\n") });
    items = [];
  };
  const TOKEN = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|[^<]+|</g;
  for (const match of source.matchAll(TOKEN)) {
    const token = match[0];
    const tag = match[1]?.toLowerCase();
    if (!tag) {
      if (skip || token.startsWith("<!--")) continue;
      if (depth) {
        if (cell !== null) cell += token;
      } else buffer += token;
      continue;
    }
    const closing = token.startsWith("</");
    if (skip) {
      if (closing && tag === skip) skip = "";
      continue;
    }
    if (!closing && SKIPPED.has(tag) && !token.endsWith("/>")) {
      skip = tag;
      continue;
    }
    if (tag === "table") {
      if (!closing) {
        if (depth++ === 0) {
          flush();
          flushList();
          rows = [];
        }
      } else if (depth && --depth === 0) {
        blocks.push(...tableBlocks(rows, ++tables));
        rows = [];
      }
    } else if (depth) {
      if (tag === "tr") {
        if (!closing) cells = [];
        else if (cells) {
          rows.push(cells);
          cells = null;
        }
      } else if (tag === "td" || tag === "th") {
        if (!closing) cell = "";
        else if (cell !== null && cells) {
          cells.push(clean(decode(cell)));
          cell = null;
        }
      } else if (tag === "br" && cell !== null) cell += " ";
    } else if (/^h[1-6]$/.test(tag)) {
      if (!closing) {
        flush();
        flushList();
        heading = Number(tag[1]);
      } else if (heading) {
        const text = takeText();
        if (text) blocks.push({ kind: "heading", text, level: heading });
        heading = 0;
      }
    } else if (tag === "li") {
      if (!closing) {
        flush();
        inItem += 1;
      } else if (inItem) {
        inItem -= 1;
        const text = takeText();
        if (text) items.push(`- ${text}`);
      }
    } else if (tag === "ul" || tag === "ol") {
      if (!inItem) {
        flush();
        flushList();
      }
    } else if (BREAKS.has(tag) && !inItem) flush();
  }
  flush();
  flushList();
  return blocks.filter((b) => b.text);
}

// ------------------------------------------------------------------ DOCX (archive ZIP, XML)
/** Lit un fichier d'une archive ZIP (méthodes « stored » et « deflate »), sans dépendance. */
async function unzip(bytes: Uint8Array, name: string): Promise<Uint8Array | null> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let i = 0; i < count && offset + 46 <= bytes.length; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) return null;
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const entry = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (entry === name) {
      const dataStart =
        local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(dataStart, dataStart + size);
      if (method === 0) return data;
      if (method !== 8) return null;
      const { inflateRawSync } = await import("node:zlib");
      return new Uint8Array(inflateRawSync(data));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

const xmlText = (xml: string) =>
  decode(
    xml
      .replace(/<w:(?:tab|br|cr)\b[^>]*\/>/g, " ")
      .replace(/<w:t\b[^>]*>([^<]*)<\/w:t>|<[^>]+>/g, (_whole, text?: string) => text ?? ""),
  );

/** Blocs d'un fichier DOCX : titres (styles « Heading » ou « Titre »), listes, tableaux. */
export async function blocksFromDocx(bytes: Uint8Array): Promise<Draft[]> {
  const file = await unzip(bytes, "word/document.xml");
  if (!file) throw new Error("Not a DOCX file (word/document.xml not found).");
  const xml = new TextDecoder().decode(file);
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const blocks: Draft[] = [];
  let items: string[] = [];
  let tables = 0;
  const flush = () => {
    if (items.length) blocks.push({ kind: "list", text: items.join("\n") });
    items = [];
  };
  const PART = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g;
  for (const [part] of body.matchAll(PART)) {
    if (part.startsWith("<w:tbl")) {
      flush();
      const rows = [...part.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(([tr]) =>
        [...tr.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(([tc]) =>
          [...tc.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map(([p]) => clean(xmlText(p))).join(" "),
        ),
      );
      blocks.push(...tableBlocks(rows, ++tables));
      continue;
    }
    const text = clean(xmlText(part));
    if (!text) continue;
    const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(part)?.[1] ?? "";
    const heading = /^(?:Heading|Titre)\s*(\d)/i.exec(style);
    if (heading || /^(?:Title|Titre)$/i.test(style)) {
      flush();
      blocks.push({ kind: "heading", text, level: heading ? Number(heading[1]) : 1 });
    } else if (/List|Liste/i.test(style) || part.includes("<w:numPr")) {
      items.push(`- ${text}`);
    } else {
      flush();
      blocks.push({ kind: "paragraph", text });
    }
  }
  flush();
  return blocks;
}

// ------------------------------------------------------------------ PDF avec texte
interface PdfItem {
  str?: string;
  transform?: number[];
  height?: number;
}
interface PdfModule {
  getDocument(source: Record<string, unknown>): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfItem[] }> }>;
    }>;
    destroy(): Promise<void>;
  };
}

/**
 * Blocs d'un PDF qui contient du texte, avec `pdfjs-dist` (à installer). Titres reconnus à
 * la taille des caractères ; les tableaux ne sont pas reconstruits (lignes de texte).
 */
export async function blocksFromPdf(bytes: Uint8Array): Promise<Draft[]> {
  let pdfjs: PdfModule;
  try {
    const name = "pdfjs-dist/legacy/build/pdf.mjs";
    pdfjs = (await import(name)) as PdfModule;
  } catch {
    throw new Error("Reading a PDF needs pdfjs-dist: npm install pdfjs-dist");
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    isEvalSupported: false,
  });
  const pdf = await task.promise;
  const lines: { text: string; size: number; y: number; page: number }[] = [];
  try {
    for (let n = 1; n <= pdf.numPages; n += 1) {
      const { items } = await (await pdf.getPage(n)).getTextContent();
      let current: { parts: string[]; size: number; y: number } | null = null;
      const push = () => {
        const text = current ? clean(current.parts.join("")) : "";
        if (current && text) lines.push({ text, size: current.size, y: current.y, page: n });
        current = null;
      };
      for (const item of items) {
        const text = item.str ?? "";
        const y = item.transform?.[5] ?? 0;
        const size = item.height ?? 0;
        if (current && Math.abs(y - current.y) > Math.max(2, current.size * 0.5)) push();
        if (!current) current = { parts: [], size, y };
        if (text.trim()) current.size = Math.max(current.size, size);
        current.parts.push(text);
      }
      push();
    }
  } finally {
    await task.destroy();
  }
  // Taille du texte courant : celle qui porte le plus de caractères.
  const weights = new Map<number, number>();
  for (const line of lines) {
    const size = Math.round(line.size * 10) / 10;
    weights.set(size, (weights.get(size) ?? 0) + line.text.length);
  }
  const body = [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  const blocks: Draft[] = [];
  let paragraph: string[] = [];
  let previous: (typeof lines)[number] | undefined;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: clean(paragraph.join(" ")) });
    paragraph = [];
  };
  for (const line of lines) {
    const gap = previous && previous.page === line.page ? previous.y - line.y : 0;
    if (body && line.size >= body * 1.15 && line.text.length <= 200) {
      flush();
      const level = line.size >= body * 1.6 ? 1 : line.size >= body * 1.3 ? 2 : 3;
      blocks.push({ kind: "heading", text: line.text, level });
    } else {
      if (paragraph.length && (previous?.page !== line.page || gap > line.size * 1.8)) flush();
      paragraph.push(line.text);
    }
    previous = line;
  }
  flush();
  return blocks;
}

// ------------------------------------------------------------------ fichiers
/**
 * Lit un fichier chez vous (Node) et rend son texte linéaire et ses blocs. `kind` force le
 * format (`"pdf"`, `"docx"`, `"html"`, `"markdown"`, `"text"`) ; absent, il vient de
 * l'extension. Format inconnu : erreur.
 */
export async function readDocument(path: string, kind?: string): Promise<ParsedDocument> {
  const { readFile } = await import("node:fs/promises");
  const extension = (kind ?? path.slice(path.lastIndexOf(".") + 1))
    .toLowerCase()
    .replace(/^\./, "");
  const bytes = new Uint8Array(await readFile(path));
  const text = () => new TextDecoder().decode(bytes);
  switch (extension) {
    case "docx":
      return documentFromBlocks(await blocksFromDocx(bytes));
    case "pdf":
      return documentFromBlocks(await blocksFromPdf(bytes));
    case "html":
    case "htm":
      return documentFromBlocks(blocksFromHtml(text()));
    case "md":
    case "markdown":
    case "txt":
    case "text":
      return documentFromBlocks(blocksFromMarkdown(text()));
    default:
      throw new Error(`Unknown document format: ${extension || path}`);
  }
}

// ------------------------------------------------------------------ découpage
/** Tranches (début, fin) d'un bloc trop long, coupé aux fins de phrase ou de ligne. */
function pieces(block: Block, maximum: number, first = maximum): [number, number][] {
  const { text, start } = block;
  if (text.length <= first) return [[start, start + text.length]];
  const cuts = [...text.matchAll(/(?<=[.!?…])\s+|\n/g)].map((m) => (m.index ?? 0) + m[0].length);
  const out: [number, number][] = [];
  let begin = 0;
  // La première tranche est plus courte quand un titre la précède dans le même passage.
  let limit = first;
  while (text.length - begin > limit) {
    const candidates = cuts.filter((c) => c > begin && c <= begin + limit);
    let cut = candidates[candidates.length - 1];
    if (cut === undefined) {
      const space = text.lastIndexOf(" ", begin + limit - 1);
      cut = space > begin ? space + 1 : begin + limit;
    }
    limit = maximum;
    out.push([start + begin, start + cut]);
    begin = cut;
  }
  out.push([start + begin, start + text.length]);
  return out;
}

/**
 * Passages d'un document, coupés selon sa structure : un titre ou un tableau ouvre un
 * passage et reste avec ce qui suit (de petites sections qui se suivent restent ensemble) ;
 * une ligne de tableau n'est jamais coupée ; un paragraphe trop long est coupé à une fin de
 * phrase. Chaque passage est une tranche exacte de `document.text`.
 */
export function splitDocument(
  document: ParsedDocument,
  target = TARGET_CHARS,
  maximum = MAX_CHARS,
): DocumentPassage[] {
  if (target <= 0 || maximum < target)
    throw new Error("target must be positive and maximum >= target");
  const spans: [number, number][] = [];
  let begin: number | null = null;
  let end = 0;
  let lastKind: BlockKind | "" = "";
  const close = () => {
    if (begin !== null) spans.push([begin, end]);
    begin = null;
  };
  for (const block of document.blocks) {
    // Après un titre, le texte qui suit tient avec lui dans la taille maximale.
    const room: number =
      begin !== null && lastKind === "heading"
        ? Math.max(Math.floor(target / 2), maximum - (block.start - begin))
        : maximum;
    for (const [pieceStart, pieceEnd] of pieces(block, maximum, room)) {
      const size = pieceEnd - (begin ?? pieceStart);
      const opens =
        pieceStart === block.start &&
        (block.kind === "heading" ||
          (block.kind === "table_row" &&
            lastKind !== "heading" &&
            lastKind !== "table_row" &&
            lastKind !== ""));
      if (
        begin !== null &&
        (size > maximum ||
          (opens && lastKind !== "heading" && end - begin >= Math.floor(target / 2)) ||
          (end - begin >= target && lastKind !== "heading"))
      ) {
        close();
      }
      if (begin === null) begin = pieceStart;
      end = pieceEnd;
      lastKind = block.kind;
    }
  }
  close();
  // Bloc où commence un passage : celui qui contient sa position (un long paragraphe donne
  // plusieurs passages).
  const blockAt = (position: number) => {
    let found: Block | undefined;
    for (const block of document.blocks) {
      if (block.start > position) break;
      found = block;
    }
    return found;
  };
  const out: DocumentPassage[] = [];
  for (const [start, stop] of spans) {
    const text = document.text.slice(start, stop);
    if (!text.trim()) continue;
    const first = blockAt(start);
    const context =
      first && (first.kind !== "heading" || first.start !== start) && first.section
        ? first.section.replace(/\s+/g, " ").slice(0, CONTEXT_CHARS).trim()
        : "";
    out.push({ text, start, ...(context ? { context } : {}) });
  }
  return out;
}

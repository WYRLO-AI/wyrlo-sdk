"""Lecture des documents chez vous, puis découpage selon leur structure (préversion).

WYRLO ne garde jamais le texte : vos fichiers sont lus **sur votre machine**, découpés ici,
et seuls les passages partent pour le calcul des vecteurs (``Wyrlo.index(passages=…)``).

Formats : Markdown, HTML et texte (sans dépendance) ; PDF avec ses tableaux, DOCX, PPTX et
XLSX avec ``pip install "wyrlo[documents]"`` (pdfplumber, python-docx, python-pptx,
openpyxl, sous licences MIT). Les PDF scannés (images sans texte) ne sont pas lus ici.

Exemple ::

    from wyrlo import Wyrlo
    from wyrlo.documents import read_document, split_document

    doc = read_document("tarifs.pdf")
    Wyrlo().index("tarifs.pdf", version="2026-11", passages=split_document(doc),
                  title=doc.title)

    # Relecture pour ``search`` et ``answer`` : gardez ``doc.text`` chez vous (ou relisez le
    # fichier) ; chaque passage est la tranche ``doc.text[start:start + length]``.

Chaque ligne d'un tableau est écrite avec ses en-têtes (« Produit : Vélo | Prix : 900 € ») :
une question sur une cellule retrouve la ligne entière, et le passage reste une tranche
exacte du texte, relisible à son adresse.
"""

import bisect
import os
import re
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

__all__ = [
    "Block",
    "ParsedDocument",
    "blocks_from_html",
    "blocks_from_markdown",
    "blocks_from_text",
    "document_from_blocks",
    "read_document",
    "split_document",
]

#: Taille visée et taille maximale d'un passage, en caractères (comme le découpage de WYRLO).
TARGET_CHARS = 600
MAX_CHARS = 900
#: Longueur maximale du contexte d'un passage (limite de l'API).
CONTEXT_CHARS = 300

HEADING = "heading"
PARAGRAPH = "paragraph"
LIST = "list"
TABLE_ROW = "table_row"


@dataclass
class Block:
    """Un morceau du document : titre, paragraphe, liste ou ligne de tableau."""

    kind: str
    text: str
    #: Niveau d'un titre (1 pour le plus haut) ; 0 sinon.
    level: int = 0
    #: Position du bloc dans ``ParsedDocument.text`` (posée par ``document_from_blocks``).
    start: int = 0
    #: Numéro du tableau dans le document (lignes d'un même tableau) ; 0 sinon.
    table: int = 0
    #: Titre de la section où se trouve le bloc (posé à l'assemblage) ; vide sinon.
    section: str = ""
    #: Ligne d'en-têtes du tableau, quand la ligne ne les porte pas elle-même (texte brut).
    header: str = ""


@dataclass
class ParsedDocument:
    """Texte linéaire d'un document et ses blocs, dans l'ordre de lecture."""

    text: str
    blocks: List[Block] = field(default_factory=list)
    #: Premier titre du document, s'il en a un (à passer à ``index(title=…)``).
    title: Optional[str] = None


def _clean(text: str) -> str:
    return re.sub(r"[ \t ]+", " ", text.replace("\r", "")).strip()


def _row(headers: Sequence[str], cells: Sequence[str]) -> str:
    """Une ligne de tableau avec ses en-têtes : « Produit : Vélo | Prix : 900 € »."""
    parts = []
    for index, cell in enumerate(cells):
        value = _clean(str(cell if cell is not None else "")).replace("\n", " ")
        if not value:
            continue
        name = _clean(str(headers[index])).replace("\n", " ") if index < len(headers) else ""
        parts.append(f"{name} : {value}" if name and name != value else value)
    return " | ".join(parts)


def _table_blocks(rows: Sequence[Sequence[Any]], table: int) -> List[Block]:
    """Blocs d'un tableau : la première ligne non vide donne les en-têtes."""
    filled = [
        ["" if cell is None else str(cell) for cell in row]
        for row in rows
        if any(_clean(str(cell or "")) for cell in row)
    ]
    if not filled:
        return []
    if len(filled) == 1:
        return [Block(TABLE_ROW, _row([], filled[0]), table=table)]
    headers = filled[0]
    out = [Block(TABLE_ROW, _row(headers, row), table=table) for row in filled[1:]]
    return [b for b in out if b.text]


def document_from_blocks(blocks: Iterable[Block]) -> ParsedDocument:
    """Assemble le texte linéaire : une ligne vide entre les blocs, un simple retour à la
    ligne entre deux lignes du même tableau ; pose ``start`` sur chaque bloc."""
    kept = [b for b in blocks if b.text]
    parts: List[str] = []
    position = 0
    previous: Optional[Block] = None
    for block in kept:
        if previous is not None:
            same_table = block.kind == TABLE_ROW and previous.table == block.table != 0
            separator = "\n" if same_table else "\n\n"
            parts.append(separator)
            position += len(separator)
        block.start = position
        parts.append(block.text)
        position += len(block.text)
        previous = block
    _sections(kept)
    title = next((b.text for b in kept if b.kind == HEADING), None)
    return ParsedDocument(text="".join(parts), blocks=kept, title=title)


def _sections(blocks: Sequence[Block]) -> None:
    """Pose sur chaque bloc le titre de sa section (le dernier titre rencontré)."""
    current = ""
    for block in blocks:
        if block.kind == HEADING:
            current = block.text.strip()
        else:
            block.section = current


# ------------------------------------------------------------------ texte brut, à l'identique
_TEXT_BULLET = re.compile(r"^\s*(?:[-•◦▪●○‣·*]|\d+[.)])\s+")
_TEXT_NUMBERED = re.compile(r"^\s*(?:\d+(?:\.\d+)*[.)]?|[IVXLC]+[.)])\s+\S")
_TEXT_KEYWORD = re.compile(
    r"^\s*(?:Article|Chapitre|Section|Annexe|Titre|Partie|Chapter|Appendix|Part)\b", re.I
)


def _is_row(line: str) -> bool:
    return line.count(" ; ") >= 2 or line.count("\t") >= 2 or line.count(" | ") >= 2


def _is_heading(line: str, next_line: str, previous_blank: bool) -> bool:
    """Titre d'un texte brut : une ligne courte, sans ponctuation finale, suivie de texte,
    et qui est numérotée, commence par « Article », « Chapitre »…, est en capitales, ou tient
    seule après une ligne vide. Une règle simple, qui ne coupe jamais le texte."""
    text = line.strip()
    if not text or len(text) > 90 or text[-1] in ".;,:!?" or not next_line.strip():
        return False
    letters = [c for c in text if c.isalpha()]
    capitals = bool(letters) and all(c.isupper() for c in letters) and len(letters) >= 4
    numbered = bool(_TEXT_NUMBERED.match(text)) and len(text) <= 70
    return bool(
        capitals
        or _TEXT_KEYWORD.match(text)
        or numbered
        or (previous_blank and len(text) <= 60 and not _TEXT_BULLET.match(text))
    )


def blocks_from_text(source: str) -> ParsedDocument:
    """Document d'un texte brut, **gardé à l'identique** : chaque bloc est une tranche exacte
    de ``source``. Titres, listes et tableaux (lignes à « ; », tabulations ou « | ») sont
    reconnus pour choisir où couper ; rien n'est réécrit. La première ligne d'un tableau
    donne ses en-têtes, proposés comme ``context`` des passages qui ne la contiennent pas."""
    lines: List[Tuple[int, str]] = []
    position = 0
    for raw in source.split("\n"):
        lines.append((position, raw.rstrip("\r")))
        position += len(raw) + 1
    blocks: List[Block] = []
    tables = 0
    index = 0
    previous_blank = True
    while index < len(lines):
        start, line = lines[index]
        if not line.strip():
            previous_blank = True
            index += 1
            continue
        following = lines[index + 1][1] if index + 1 < len(lines) else ""
        if _is_row(line):
            tables += 1
            header = line.strip()
            first = True
            while index < len(lines) and _is_row(lines[index][1]):
                row_start, row = lines[index]
                blocks.append(
                    Block(TABLE_ROW, row, start=row_start, table=tables,
                          header="" if first else header)
                )
                first = False
                index += 1
        elif _is_heading(line, following, previous_blank):
            blocks.append(Block(HEADING, line, level=2, start=start))
            index += 1
        else:
            kind = LIST if _TEXT_BULLET.match(line) else PARAGRAPH
            end = index
            while end + 1 < len(lines):
                candidate = lines[end + 1][1]
                after = lines[end + 2][1] if end + 2 < len(lines) else ""
                if (
                    not candidate.strip()
                    or _is_row(candidate)
                    or bool(_TEXT_BULLET.match(candidate)) != (kind == LIST)
                    or _is_heading(candidate, after, False)
                ):
                    break
                end += 1
            last_start, last = lines[end]
            blocks.append(Block(kind, source[start : last_start + len(last)], start=start))
            index = end + 1
        previous_blank = False
    kept = [b for b in blocks if b.text.strip()]
    _sections(kept)
    title = next((b.text.strip() for b in kept if b.kind == HEADING), None)
    return ParsedDocument(text=source, blocks=kept, title=title)


# ------------------------------------------------------------------ Markdown et texte
_MD_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_MD_LIST = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")
_MD_RULE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")


def _md_cells(line: str) -> List[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def blocks_from_markdown(source: str) -> List[Block]:
    """Blocs d'un texte Markdown (ou d'un texte simple : paragraphes séparés d'une ligne vide)."""
    blocks: List[Block] = []
    paragraph: List[str] = []
    items: List[str] = []
    rows: List[List[str]] = []
    tables = 0
    fenced = False

    def flush() -> None:
        nonlocal paragraph, items, rows, tables
        if paragraph:
            blocks.append(Block(PARAGRAPH, _clean(" ".join(paragraph))))
            paragraph = []
        if items:
            blocks.append(Block(LIST, "\n".join(items)))
            items = []
        if rows:
            tables += 1
            blocks.extend(_table_blocks(rows, tables))
            rows = []

    for raw in source.replace("\r\n", "\n").split("\n"):
        line = raw.rstrip()
        if line.strip().startswith("```"):
            fenced = not fenced
            flush()
            continue
        if fenced:
            paragraph.append(line)
            continue
        if not line.strip():
            flush()
            continue
        heading = _MD_HEADING.match(line)
        if heading:
            flush()
            blocks.append(Block(HEADING, _clean(heading.group(2)), level=len(heading.group(1))))
        elif line.strip().startswith("|") and line.count("|") >= 2:
            if paragraph or items:
                # Le texte en attente passe avant le tableau, dont les lignes déjà lues restent.
                saved_rows, rows = rows, []
                flush()
                rows = saved_rows
            if not _MD_RULE.match(line):
                rows.append(_md_cells(line))
        elif _MD_LIST.match(line):
            if paragraph or rows:
                flush()
            items.append(_clean(line))
        elif items and raw.startswith((" ", "\t")):
            items[-1] += " " + _clean(line)
        else:
            if items or rows:
                flush()
            paragraph.append(line.strip())
    flush()
    return [b for b in blocks if b.text]


# ------------------------------------------------------------------ HTML
class _Html(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg", "head"}
    BREAK = {"p", "div", "section", "article", "blockquote", "pre", "br", "ul", "ol", "dl"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: List[Block] = []
        self.buffer: List[str] = []
        self.skip = 0
        self.heading = 0
        self.items: List[str] = []
        self.in_item = 0
        self.rows: List[List[str]] = []
        self.row: Optional[List[str]] = None
        self.cell: Optional[List[str]] = None
        self.tables = 0
        self.depth = 0

    def _text(self) -> str:
        text = _clean(" ".join(self.buffer).replace("\n", " "))
        self.buffer = []
        return text

    def _flush(self) -> None:
        text = self._text()
        if text:
            self.blocks.append(Block(PARAGRAPH, text))

    def _flush_list(self) -> None:
        if self.items:
            self.blocks.append(Block(LIST, "\n".join(self.items)))
            self.items = []

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in self.SKIP:
            self.skip += 1
        if self.skip:
            return
        if tag == "table":
            self.depth += 1
            if self.depth == 1:
                self._flush()
                self._flush_list()
                self.rows = []
        elif self.depth:
            if tag == "tr":
                self.row = []
            elif tag in ("td", "th"):
                self.cell = []
            elif tag == "br" and self.cell is not None:
                self.cell.append(" ")
        elif re.fullmatch(r"h[1-6]", tag):
            self._flush()
            self._flush_list()
            self.heading = int(tag[1])
        elif tag == "li":
            self._flush()
            self.in_item += 1
        elif tag in self.BREAK:
            if not self.in_item:
                self._flush()
            if tag in ("ul", "ol") and not self.in_item:
                self._flush_list()

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if self.skip:
            return
        if tag == "table" and self.depth:
            self.depth -= 1
            if self.depth == 0:
                self.tables += 1
                self.blocks.extend(_table_blocks(self.rows, self.tables))
                self.rows = []
        elif self.depth:
            if tag in ("td", "th") and self.cell is not None and self.row is not None:
                self.row.append(_clean(" ".join(self.cell)))
                self.cell = None
            elif tag == "tr" and self.row is not None:
                self.rows.append(self.row)
                self.row = None
        elif re.fullmatch(r"h[1-6]", tag) and self.heading:
            text = self._text()
            if text:
                self.blocks.append(Block(HEADING, text, level=self.heading))
            self.heading = 0
        elif tag == "li" and self.in_item:
            self.in_item -= 1
            text = self._text()
            if text:
                self.items.append("- " + text)
        elif tag in ("ul", "ol") and not self.in_item:
            self._flush_list()
        elif tag in self.BREAK and not self.in_item:
            self._flush()

    def handle_data(self, data: str) -> None:
        if self.skip:
            return
        if self.depth:
            if self.cell is not None:
                self.cell.append(data)
        else:
            self.buffer.append(data)

    def close(self) -> None:
        super().close()
        self._flush()
        self._flush_list()


def blocks_from_html(source: str) -> List[Block]:
    """Blocs d'une page HTML : titres, paragraphes, listes, tableaux ; scripts et styles ignorés."""
    parser = _Html()
    parser.feed(source)
    parser.close()
    return [b for b in parser.blocks if b.text]


# ------------------------------------------------------------------ formats avec bibliothèque
def _need(module: str, package: str) -> Any:
    try:
        return __import__(module)
    except ImportError as error:
        raise ImportError(
            f'Reading this format needs {package}: pip install "wyrlo[documents]"'
        ) from error


def _blocks_from_docx(path: str) -> List[Block]:
    docx = _need("docx", "python-docx")
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = docx.Document(path)
    blocks: List[Block] = []
    items: List[str] = []
    tables = 0

    def flush() -> None:
        nonlocal items
        if items:
            blocks.append(Block(LIST, "\n".join(items)))
            items = []

    for child in document.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            paragraph = Paragraph(child, document)
            text = _clean(paragraph.text.replace("\n", " "))
            if not text:
                continue
            style = (paragraph.style.name or "") if paragraph.style is not None else ""
            heading = re.match(r"(?:Heading|Titre)\s*(\d)", style)
            if heading or style in ("Title", "Titre"):
                flush()
                blocks.append(Block(HEADING, text, level=int(heading.group(1)) if heading else 1))
            elif "List" in style or "Liste" in style or child.find(".//{*}numPr") is not None:
                items.append("- " + text)
            else:
                flush()
                blocks.append(Block(PARAGRAPH, text))
        elif tag == "tbl":
            flush()
            tables += 1
            table = Table(child, document)
            rows = [[cell.text for cell in row.cells] for row in table.rows]
            blocks.extend(_table_blocks(rows, tables))
    flush()
    return blocks


def _blocks_from_pptx(path: str) -> List[Block]:
    pptx = _need("pptx", "python-pptx")
    blocks: List[Block] = []
    tables = 0
    for number, slide in enumerate(pptx.Presentation(path).slides, start=1):
        title_shape = slide.shapes.title
        title = _clean(title_shape.text_frame.text.replace("\n", " ")) if title_shape else ""
        blocks.append(Block(HEADING, title or f"Slide {number}", level=1 if number == 1 else 2))
        for shape in slide.shapes:
            if title_shape is not None and shape.shape_id == title_shape.shape_id:
                continue
            if getattr(shape, "has_table", False) and shape.has_table:
                tables += 1
                rows = [[cell.text for cell in row.cells] for row in shape.table.rows]
                blocks.extend(_table_blocks(rows, tables))
            elif getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                lines = [_clean(p.text) for p in shape.text_frame.paragraphs]
                lines = [line for line in lines if line]
                if len(lines) > 1:
                    blocks.append(Block(LIST, "\n".join("- " + line for line in lines)))
                elif lines:
                    blocks.append(Block(PARAGRAPH, lines[0]))
    return blocks


def _blocks_from_xlsx(path: str) -> List[Block]:
    openpyxl = _need("openpyxl", "openpyxl")
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    blocks: List[Block] = []
    try:
        for number, sheet in enumerate(workbook.worksheets, start=1):
            rows = [
                ["" if cell is None else str(cell) for cell in row]
                for row in sheet.iter_rows(values_only=True)
            ]
            rows_blocks = _table_blocks(rows, number)
            if rows_blocks:
                blocks.append(Block(HEADING, _clean(sheet.title), level=2))
                blocks.extend(rows_blocks)
    finally:
        workbook.close()
    return blocks


def _blocks_from_pdf(path: str) -> List[Block]:
    pdfplumber = _need("pdfplumber", "pdfplumber")
    blocks: List[Block] = []
    tables = 0
    with pdfplumber.open(path) as pdf:
        # Taille du texte courant : la plus fréquente parmi les caractères du document.
        sizes: Dict[float, int] = {}
        for page in pdf.pages:
            for char in page.chars:
                size = round(float(char.get("size") or 0), 1)
                if size > 0 and str(char.get("text") or "").strip():
                    sizes[size] = sizes.get(size, 0) + 1
        body = max(sizes, key=lambda size: sizes[size]) if sizes else 0.0
        for page in pdf.pages:
            found = page.find_tables()
            boxes = [table.bbox for table in found]

            def outside(obj: Dict[str, Any], boxes: List[Tuple[float, ...]] = boxes) -> bool:
                middle_x = (obj["x0"] + obj["x1"]) / 2
                middle_y = (obj["top"] + obj["bottom"]) / 2
                return not any(
                    box[0] <= middle_x <= box[2] and box[1] <= middle_y <= box[3] for box in boxes
                )

            # Dans l'ordre de la page : le texte au-dessus d'un tableau, le tableau, la suite.
            cursor = 0.0
            for table in sorted(found, key=lambda t: t.bbox[1]):
                top = max(cursor, min(float(table.bbox[1]), float(page.height)))
                if top > cursor:
                    area = page.crop((0, cursor, page.width, top)).filter(outside)
                    blocks.extend(_pdf_text_blocks(area, body))
                tables += 1
                blocks.extend(_table_blocks(table.extract() or [], tables))
                cursor = max(cursor, min(float(table.bbox[3]), float(page.height)))
            if cursor < page.height:
                area = page.crop((0, cursor, page.width, page.height)).filter(outside)
                blocks.extend(_pdf_text_blocks(area, body))
    return blocks


_PDF_BULLET = re.compile(r"^\s*(?:[•◦▪●○‣·*-]|\d+[.)])\s+")


def _pdf_text_blocks(area: Any, body: float) -> List[Block]:
    """Blocs d'une zone de page sans tableau.

    - titre : une ligne nettement plus grande que le texte courant (au moins 15 %) ;
    - liste : des lignes qui commencent par une puce ou un numéro ;
    - paragraphe : les lignes qui se suivent, coupées quand l'écart entre deux lignes
      dépasse une ligne et demie.
    Sans taille de caractères exploitable, tout est paragraphe (rien n'est deviné).
    """
    try:
        lines = area.extract_text_lines(return_chars=True)
    except Exception:  # noqa: BLE001 - page sans texte exploitable
        lines = []
    blocks: List[Block] = []
    paragraph: List[str] = []
    items: List[str] = []
    previous_bottom: Optional[float] = None

    def flush() -> None:
        nonlocal paragraph, items
        if paragraph:
            joined = " ".join(paragraph)
            blocks.append(Block(PARAGRAPH, _clean(re.sub(r"(?<=[a-zà-ÿ])- (?=[a-zà-ÿ])", "", joined))))
            paragraph = []
        if items:
            blocks.append(Block(LIST, "\n".join(items)))
            items = []

    for line in lines:
        text = _clean(str(line.get("text") or ""))
        if not text:
            continue
        chars = [c for c in line.get("chars") or [] if str(c.get("text") or "").strip()]
        size = max((float(c.get("size") or 0) for c in chars), default=0.0)
        top, bottom = float(line.get("top") or 0), float(line.get("bottom") or 0)
        height = max(bottom - top, 1.0)
        gap = top - previous_bottom if previous_bottom is not None else 0.0
        previous_bottom = bottom
        if body and size >= body * 1.15 and len(text) <= 200:
            flush()
            level = 1 if size >= body * 1.6 else 2 if size >= body * 1.3 else 3
            if blocks and blocks[-1].kind == HEADING and blocks[-1].level == level and gap < height:
                blocks[-1].text += " " + text  # titre sur deux lignes
            else:
                blocks.append(Block(HEADING, text, level=level))
        elif _PDF_BULLET.match(text):
            if paragraph:
                flush()
            items.append("- " + _PDF_BULLET.sub("", text))
        else:
            if items and gap < height * 0.5 and not paragraph:
                items[-1] += " " + text  # suite d'un élément de liste sur la ligne suivante
                continue
            if items or (paragraph and gap > height * 0.5):
                flush()
            paragraph.append(text)
    flush()
    return [b for b in blocks if b.text]


_READERS = {
    ".docx": _blocks_from_docx,
    ".pptx": _blocks_from_pptx,
    ".xlsx": _blocks_from_xlsx,
    ".pdf": _blocks_from_pdf,
}


def read_document(path: str, kind: Optional[str] = None) -> ParsedDocument:
    """Lit un fichier chez vous et rend son texte linéaire et ses blocs.

    ``kind`` force le format (``"pdf"``, ``"docx"``, ``"pptx"``, ``"xlsx"``, ``"html"``,
    ``"markdown"``, ``"text"``) ; absent, il vient de l'extension du fichier. Lève
    ``ValueError`` pour un format inconnu, ``ImportError`` si la bibliothèque du format
    manque (``pip install "wyrlo[documents]"``).
    """
    extension = "." + kind.lower().lstrip(".") if kind else os.path.splitext(path)[1].lower()
    if extension in _READERS:
        return document_from_blocks(_READERS[extension](path))
    if extension in (".html", ".htm", ".md", ".markdown", ".txt", ".text"):
        with open(path, encoding="utf-8", errors="replace") as handle:
            source = handle.read()
        if extension in (".txt", ".text"):
            return blocks_from_text(source)
        blocks = (
            blocks_from_html(source)
            if extension in (".html", ".htm")
            else blocks_from_markdown(source)
        )
        return document_from_blocks(blocks)
    raise ValueError(f"Unknown document format: {extension or path}")


# ------------------------------------------------------------------ découpage
_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+")


def _pieces(block: Block, maximum: int, first: Optional[int] = None) -> List[Tuple[int, int]]:
    """Tranches (début, fin) d'un bloc trop long, coupé aux fins de phrase ou de ligne.
    ``first`` : taille de la première tranche, plus courte quand un titre la précède."""
    text = block.text
    limit = maximum if first is None else first
    if len(text) <= limit:
        return [(block.start, block.start + len(text))]
    cuts = sorted({m.end() for m in _SENTENCE_END.finditer(text)} | {
        m.end() for m in re.finditer(r"\n", text)
    })
    out: List[Tuple[int, int]] = []
    begin = 0
    while len(text) - begin > limit:
        candidates = [c for c in cuts if begin < c <= begin + limit]
        if candidates:
            cut = candidates[-1]
        else:
            space = text.rfind(" ", begin + 1, begin + limit)
            cut = space + 1 if space > begin else begin + limit
        out.append((block.start + begin, block.start + cut))
        begin = cut
        limit = maximum
    out.append((block.start + begin, block.start + len(text)))
    return out


def split_document(
    document: ParsedDocument, target: int = TARGET_CHARS, maximum: int = MAX_CHARS
) -> List[Dict[str, Any]]:
    """Passages d'un document, coupés selon sa structure : ``[{"text", "start"}]``.

    - un titre ouvre un passage et reste avec le texte qui le suit ; un tableau aussi
      (avec son titre s'il en a un) ; de petites sections qui se suivent restent ensemble ;
    - une ligne de tableau n'est jamais coupée, et porte ses en-têtes ;
    - une liste reste entière tant qu'elle tient dans ``maximum`` ;
    - un paragraphe trop long est coupé à une fin de phrase.

    Chaque passage est une tranche exacte de ``document.text`` : ``start`` est sa position,
    à relire chez vous pour ``search`` et ``answer``. ``context``, quand il existe, donne le
    titre de la section et les en-têtes du tableau : WYRLO le place devant le passage pour
    les vecteurs seulement, sans le conserver.
    """
    if target <= 0 or maximum < target:
        raise ValueError("target must be positive and maximum >= target")
    spans: List[Tuple[int, int]] = []
    begin: Optional[int] = None
    end = 0
    last_kind = ""

    def close() -> None:
        nonlocal begin
        if begin is not None:
            spans.append((begin, end))
            begin = None

    for block in document.blocks:
        # Après un titre, le texte qui suit tient avec lui dans la taille maximale.
        room = (
            max(target // 2, maximum - (block.start - begin))
            if begin is not None and last_kind == HEADING
            else maximum
        )
        for piece_start, piece_end in _pieces(block, maximum, room):
            size = piece_end - (begin if begin is not None else piece_start)
            # Un tableau commence un passage, sauf juste après son titre.
            opens = piece_start == block.start and (
                block.kind == HEADING
                or (block.kind == TABLE_ROW and last_kind not in (HEADING, TABLE_ROW, ""))
            )
            # Un titre ouvre un passage ; un passage ne finit jamais sur un titre seul.
            # Un titre ou un tableau n'ouvre un passage que si le précédent a déjà pris la
            # moitié de la taille visée : de petites sections qui se suivent restent ensemble.
            if begin is not None and (
                size > maximum
                or (opens and last_kind != HEADING and end - begin >= target // 2)
                or (end - begin >= target and last_kind != HEADING)
            ):
                close()
            if begin is None:
                begin = piece_start
            end = piece_end
            last_kind = block.kind
    close()
    starts = [block.start for block in document.blocks]
    out: List[Dict[str, Any]] = []
    for start, stop in spans:
        text = document.text[start:stop]
        if not text.strip():
            continue
        passage: Dict[str, Any] = {"text": text, "start": start}
        # Bloc où commence le passage : celui qui contient sa position (un long paragraphe
        # donne plusieurs passages).
        at = bisect.bisect_right(starts, start) - 1
        first = document.blocks[at] if at >= 0 else None
        # Contexte pour les vecteurs : le titre de la section quand le passage ne commence
        # pas par lui, et les en-têtes du tableau quand il ne les contient pas.
        parts: List[str] = []
        if first is not None:
            if first.kind != HEADING and first.section:
                parts.append(first.section)
            if first.header and first.start == start:
                parts.append(first.header)
        context = " | ".join(" ".join(part.split()) for part in parts)[:CONTEXT_CHARS].strip()
        if context:
            passage["context"] = context
        out.append(passage)
    return out

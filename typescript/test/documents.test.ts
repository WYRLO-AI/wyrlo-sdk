import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  blocksFromHtml,
  blocksFromMarkdown,
  documentFromBlocks,
  readDocument,
  splitDocument,
  type ParsedDocument,
} from "../src/documents.ts";

// Lecture et découpage des documents côté client (préversion). Données fictives.
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const ROW = "Modèle : Route 500 | Prix : 2 190 € | Garantie du moteur : 3 ans";
const MARKDOWN = `# Tarifs Studio Essai

Les prix sont en euros.

## Prix des vélos

| Modèle | Prix | Garantie du moteur |
| --- | --- | --- |
| Ville 300 | 1 490 € | 2 ans |
| Route 500 | 2 190 € | 3 ans |

## Conditions

- Livraison gratuite à partir de 1 500 euros.
- Retour possible sous 30 jours.
`;

/** Chaque bloc et chaque passage est une tranche exacte du texte. */
function check(document: ParsedDocument, target?: number, maximum?: number) {
  for (const block of document.blocks) {
    expect(document.text.slice(block.start, block.start + block.text.length)).toBe(block.text);
  }
  const passages = splitDocument(document, target, maximum);
  for (const passage of passages) {
    expect(document.text.slice(passage.start, passage.start + passage.text.length)).toBe(
      passage.text,
    );
  }
  return passages;
}

describe("documents : lecture et découpage selon la structure", () => {
  it("Markdown : titres, tableau avec ses en-têtes, liste", () => {
    const document = documentFromBlocks(blocksFromMarkdown(MARKDOWN));
    expect(document.title).toBe("Tarifs Studio Essai");
    expect(document.blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "table_row",
      "table_row",
      "heading",
      "list",
    ]);
    expect(document.text).toContain(ROW);
    expect(document.text).toContain("- Livraison gratuite à partir de 1 500 euros.\n- Retour");
    const passages = check(document, 80, 200);
    expect(passages.filter((p) => p.text.includes(ROW))).toHaveLength(1);
    expect(passages.every((p) => p.text.length <= 200)).toBe(true);
    const titles = new Set(document.blocks.filter((b) => b.kind === "heading").map((b) => b.text));
    expect(passages.some((p) => titles.has(p.text.trim()))).toBe(false);
  });

  it("HTML : scripts et styles ignorés, entités décodées, tableau et liste lus", () => {
    const document = documentFromBlocks(
      blocksFromHtml(
        "<html><head><title>x</title><style>p{color:red}</style></head><body>" +
          "<h1>Tarifs</h1><script>alert('non')</script><p>Les prix sont en&nbsp;euros &amp; fictifs.</p>" +
          "<table><tr><th>Modèle</th><th>Prix</th><th>Garantie du moteur</th></tr>" +
          "<tr><td>Ville 300</td><td>1 490 €</td><td>2 ans</td></tr>" +
          "<tr><td>Route 500</td><td>2 190 &euro;</td><td>3 ans</td></tr></table>" +
          "<ul><li>Livraison gratuite.</li><li>Retour sous 30 jours.</li></ul></body></html>",
      ),
    );
    expect(document.text).not.toMatch(/alert|color/);
    expect(document.text).toContain("Les prix sont en euros & fictifs.");
    expect(document.text).toContain(ROW);
    expect(document.text).toContain("- Livraison gratuite.\n- Retour sous 30 jours.");
    check(document);
  });

  it("paragraphe trop long : coupé en fin de phrase ; contexte : le titre de la section", () => {
    const long = Array.from(
      { length: 60 },
      (_, i) => `Phrase fictive numéro ${i} sur la garantie.`,
    );
    const document = documentFromBlocks(blocksFromMarkdown(`# Garantie\n\n${long.join(" ")}`));
    const passages = check(document);
    expect(passages.length).toBeGreaterThan(2);
    expect(passages.every((p) => p.text.length <= 900)).toBe(true);
    expect(passages.every((p) => p.text.trimEnd().endsWith("."))).toBe(true);
    expect(passages[0]?.context).toBeUndefined();
    expect(passages.slice(1).every((p) => p.context === "Garantie")).toBe(true);
    expect(() => splitDocument(document, 0)).toThrow();
  });

  it("DOCX : titres, tableau avec ses en-têtes, liste, sans dépendance", async () => {
    const document = await readDocument(fixture("tarifs.docx"));
    expect(document.title).toBe("Tarifs Studio Essai");
    expect(document.blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "table_row",
      "table_row",
      "heading",
      "list",
    ]);
    expect(document.text).toContain(ROW);
    expect(document.text).toContain(
      "- Livraison gratuite à partir de 1 500 euros.\n- Retour possible sous 30 jours.",
    );
    check(document);
  });

  it("PDF avec texte (pdfjs-dist) : titres reconnus, texte des cellules présent", async () => {
    const document = await readDocument(fixture("tarifs.pdf"));
    expect(document.title).toBe("Tarifs Studio Essai 2026");
    expect(document.blocks.filter((b) => b.kind === "heading").map((b) => b.text)).toEqual([
      "Tarifs Studio Essai 2026",
      "Prix des vélos",
      "Conditions",
    ]);
    // Les tableaux d'un PDF ne sont pas reconstruits ici : le texte des cellules est lu.
    for (const cell of ["Route 500", "2 190 €", "90 km", "3 ans"]) {
      expect(document.text).toContain(cell);
    }
    check(document);
  });

  it("format inconnu : erreur claire", async () => {
    await expect(readDocument(fixture("tarifs.pdf"), "zip")).rejects.toThrow(/Unknown document/);
  });
});

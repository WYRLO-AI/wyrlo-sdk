"""Tests de la lecture et du découpage des documents (wyrlo.documents). Données fictives.

Markdown, HTML et texte : toujours testés. PDF, DOCX, PPTX, XLSX : avec les bibliothèques de
``wyrlo[documents]`` ; sans elles les tests sont sautés, sauf dans scripts/deploy.sh
(WYRLO_REQUIRE_INTEGRATIONS=1), où leur absence est un échec.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from wyrlo.documents import (  # noqa: E402
    blocks_from_html,
    blocks_from_markdown,
    blocks_from_text,
    document_from_blocks,
    read_document,
    split_document,
)

REQUIRED = os.environ.get("WYRLO_REQUIRE_INTEGRATIONS") == "1"
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def has(module):
    try:
        __import__(module)
        return True
    except ImportError:
        return False


ROWS = [
    ["Modèle", "Prix", "Garantie du moteur"],
    ["Ville 300", "1 490 €", "2 ans"],
    ["Route 500", "2 190 €", "3 ans"],
]
ROW_ROUTE = "Modèle : Route 500 | Prix : 2 190 € | Garantie du moteur : 3 ans"
MARKDOWN = """# Tarifs Studio Essai

Les prix sont en euros.

## Prix des vélos

| Modèle | Prix | Garantie du moteur |
| --- | --- | --- |
| Ville 300 | 1 490 € | 2 ans |
| Route 500 | 2 190 € | 3 ans |

## Conditions

- Livraison gratuite à partir de 1 500 euros.
- Retour possible sous 30 jours.
"""


class StructureTests(unittest.TestCase):
    def check(self, document):
        """Chaque bloc et chaque passage est une tranche exacte du texte."""
        for block in document.blocks:
            self.assertEqual(document.text[block.start : block.start + len(block.text)], block.text)
        passages = split_document(document)
        for passage in passages:
            start = passage["start"]
            self.assertEqual(document.text[start : start + len(passage["text"])], passage["text"])
        return passages

    def test_markdown_titres_tableau_liste(self):
        document = document_from_blocks(blocks_from_markdown(MARKDOWN))
        self.assertEqual(document.title, "Tarifs Studio Essai")
        self.assertEqual(
            [b.kind for b in document.blocks],
            ["heading", "paragraph", "heading", "table_row", "table_row", "heading", "list"],
        )
        self.assertIn(ROW_ROUTE, document.text)
        self.assertIn("- Livraison gratuite à partir de 1 500 euros.\n- Retour", document.text)
        self.check(document)

    def test_html_scripts_ignores_tableau_avec_entetes(self):
        html = (
            "<html><head><title>x</title><style>p{color:red}</style></head><body>"
            "<h1>Tarifs</h1><script>alert('non')</script><p>Les prix sont en&nbsp;euros.</p>"
            "<table><tr><th>Modèle</th><th>Prix</th><th>Garantie du moteur</th></tr>"
            "<tr><td>Ville 300</td><td>1 490 €</td><td>2 ans</td></tr>"
            "<tr><td>Route 500</td><td>2 190 €</td><td>3 ans</td></tr></table>"
            "<ul><li>Livraison gratuite.</li><li>Retour sous 30 jours.</li></ul></body></html>"
        )
        document = document_from_blocks(blocks_from_html(html))
        self.assertNotIn("alert", document.text)
        self.assertNotIn("color", document.text)
        self.assertIn("Les prix sont en euros.", document.text)
        self.assertIn(ROW_ROUTE, document.text)
        self.assertIn("- Livraison gratuite.\n- Retour sous 30 jours.", document.text)
        self.check(document)

    def test_decoupage_un_titre_ouvre_un_passage_une_ligne_n_est_jamais_coupee(self):
        document = document_from_blocks(blocks_from_markdown(MARKDOWN))
        passages = split_document(document, target=80, maximum=200)
        starts = [p["text"].split("\n")[0] for p in passages]
        self.assertEqual(starts[0], "Tarifs Studio Essai")
        self.assertIn("Prix des vélos", starts)
        self.assertIn("Conditions", starts)
        # La ligne du tableau est entière dans un seul passage, avec ses en-têtes.
        self.assertEqual(sum(ROW_ROUTE in p["text"] for p in passages), 1)
        # Aucun passage ne se réduit à un titre.
        titres = {b.text for b in document.blocks if b.kind == "heading"}
        self.assertFalse(any(p["text"].strip() in titres for p in passages))
        self.assertTrue(all(len(p["text"]) <= 200 for p in passages))

    def test_paragraphe_trop_long_coupe_en_fin_de_phrase(self):
        long_text = " ".join(f"Phrase fictive numéro {i} sur la garantie." for i in range(60))
        document = document_from_blocks(blocks_from_markdown(long_text))
        passages = self.check(document)
        self.assertGreater(len(passages), 2)
        self.assertTrue(all(len(p["text"]) <= 900 for p in passages))
        self.assertTrue(all(p["text"].rstrip().endswith(".") for p in passages))
        self.assertEqual("".join(p["text"] for p in passages), document.text)

    def test_titre_garde_avec_la_suite_et_contexte_des_passages_suivants(self):
        long_text = " ".join(f"Phrase fictive numéro {i} sur la garantie." for i in range(60))
        document = document_from_blocks(blocks_from_markdown("# Garantie\n\n" + long_text))
        passages = self.check(document)
        self.assertTrue(passages[0]["text"].startswith("Garantie\n\nPhrase fictive"))
        self.assertTrue(all(len(p["text"]) <= 900 for p in passages))
        self.assertNotIn("context", passages[0])
        self.assertTrue(all(p["context"] == "Garantie" for p in passages[1:]))

    def test_texte_brut_garde_a_l_identique_contexte_des_passages(self):
        source = (
            "GRILLE TARIFAIRE 2026\n"
            "Tarifs fictifs par palette, hors taxes.\n\n"
            "Département ; Zone ; 1 palette ; Délai\n"
            + "".join(f"{n:02d} Département fictif ; Zone {n % 4 + 1} ; {70 + n} € ; J+1\n" for n in range(1, 40))
            + "\n3. Conditions\n"
            "- Les prix s'entendent hors indexation gazole.\n"
            "- Toute palette hors gabarit fait l'objet d'un devis.\n"
        )
        document = blocks_from_text(source)
        self.assertEqual(document.text, source)
        passages = self.check(document)
        kinds = [b.kind for b in document.blocks]
        self.assertEqual(kinds[0], "heading")
        self.assertEqual(kinds.count("table_row"), 40)
        self.assertEqual(kinds[-2:], ["heading", "list"])
        # Le tableau tient sur plusieurs passages : seul le premier contient les en-têtes,
        # les suivants les reçoivent en contexte, avec le titre de la section.
        table = [p for p in passages if "Département fictif" in p["text"]]
        self.assertGreater(len(table), 1)
        self.assertNotIn("Département ; Zone", table[0].get("context", ""))
        for passage in table[1:]:
            self.assertEqual(
                passage["context"],
                "GRILLE TARIFAIRE 2026 | Département ; Zone ; 1 palette ; Délai",
            )
            # Une ligne n'est jamais coupée.
            self.assertTrue(passage["text"].rstrip().endswith("J+1"))
        conditions = next(p for p in passages if p["text"].startswith("3. Conditions"))
        self.assertNotIn("context", conditions)
        self.assertTrue(all(len(p.get("context", "")) <= 300 for p in passages))

    def test_fichiers_texte_et_format_inconnu(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "notes.md")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write(MARKDOWN)
            self.assertEqual(read_document(path).title, "Tarifs Studio Essai")
            # « text » : le fichier est gardé à l'identique (aucune réécriture).
            with open(path, encoding="utf-8") as handle:
                self.assertEqual(read_document(path, kind="text").text, handle.read())
            with self.assertRaises(ValueError):
                read_document(os.path.join(folder, "archive.zip"))
        with self.assertRaises(ValueError):
            split_document(document_from_blocks([]), target=0)


@unittest.skipUnless(has("pdfplumber") or REQUIRED, "pdfplumber non installé")
class PdfTests(unittest.TestCase):
    def test_pdf_avec_tableau_une_question_sur_une_cellule_trouve_sa_ligne(self):
        document = read_document(os.path.join(FIXTURES, "tarifs.pdf"))
        self.assertEqual(document.title, "Tarifs Studio Essai 2026")
        kinds = [b.kind for b in document.blocks]
        self.assertEqual(kinds.count("table_row"), 3)
        self.assertEqual(kinds.count("heading"), 3)
        row = "Modèle : Route 500 | Prix : 2 190 € | Autonomie : 90 km | Garantie du moteur : 3 ans"
        self.assertIn(row, document.text)
        passages = split_document(document, target=200, maximum=400)
        with_row = [p for p in passages if row in p["text"]]
        self.assertEqual(len(with_row), 1)
        # Le passage du tableau commence par son titre et se relit à son adresse.
        self.assertTrue(with_row[0]["text"].startswith("Prix des vélos"))
        start = with_row[0]["start"]
        self.assertEqual(document.text[start : start + len(with_row[0]["text"])], with_row[0]["text"])


@unittest.skipUnless(has("docx") or REQUIRED, "python-docx non installé")
class DocxTests(unittest.TestCase):
    def test_docx_titres_liste_tableau(self):
        import docx

        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "tarifs.docx")
            source = docx.Document()
            source.add_heading("Tarifs Studio Essai", level=1)
            source.add_paragraph("Les prix sont en euros.")
            source.add_heading("Prix des vélos", level=2)
            table = source.add_table(rows=3, cols=3)
            for r, row in enumerate(ROWS):
                for c, value in enumerate(row):
                    table.cell(r, c).text = value
            source.add_paragraph("Livraison gratuite.", style="List Bullet")
            source.add_paragraph("Retour sous 30 jours.", style="List Bullet")
            source.save(path)
            document = read_document(path)
        self.assertEqual(document.title, "Tarifs Studio Essai")
        self.assertEqual(
            [b.kind for b in document.blocks],
            ["heading", "paragraph", "heading", "table_row", "table_row", "list"],
        )
        self.assertIn(ROW_ROUTE, document.text)
        self.assertIn("- Livraison gratuite.\n- Retour sous 30 jours.", document.text)


@unittest.skipUnless(has("pptx") or REQUIRED, "python-pptx non installé")
class PptxTests(unittest.TestCase):
    def test_pptx_une_diapositive_par_titre_tableau_lu(self):
        import pptx
        from pptx.util import Inches

        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "tarifs.pptx")
            deck = pptx.Presentation()
            first = deck.slides.add_slide(deck.slide_layouts[1])
            first.shapes.title.text = "Tarifs Studio Essai"
            first.placeholders[1].text = "Les prix sont en euros.\nLivraison gratuite."
            second = deck.slides.add_slide(deck.slide_layouts[5])
            second.shapes.title.text = "Prix des vélos"
            shape = second.shapes.add_table(3, 3, Inches(1), Inches(2), Inches(6), Inches(2))
            for r, row in enumerate(ROWS):
                for c, value in enumerate(row):
                    shape.table.cell(r, c).text = value
            deck.save(path)
            document = read_document(path)
        self.assertEqual(document.title, "Tarifs Studio Essai")
        self.assertEqual(
            [b.text for b in document.blocks if b.kind == "heading"],
            ["Tarifs Studio Essai", "Prix des vélos"],
        )
        self.assertIn("- Les prix sont en euros.\n- Livraison gratuite.", document.text)
        self.assertIn(ROW_ROUTE, document.text)


@unittest.skipUnless(has("openpyxl") or REQUIRED, "openpyxl non installé")
class XlsxTests(unittest.TestCase):
    def test_xlsx_une_feuille_par_titre_lignes_avec_entetes(self):
        import openpyxl

        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "tarifs.xlsx")
            book = openpyxl.Workbook()
            sheet = book.active
            sheet.title = "Prix des vélos"
            for row in ROWS:
                sheet.append(row)
            sheet.append([None, None, None])
            book.create_sheet("Vide")
            book.save(path)
            document = read_document(path)
        self.assertEqual([b.kind for b in document.blocks], ["heading", "table_row", "table_row"])
        self.assertEqual(document.title, "Prix des vélos")
        self.assertIn(ROW_ROUTE, document.text)


if __name__ == "__main__":
    unittest.main()

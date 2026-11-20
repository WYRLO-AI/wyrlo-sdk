"""Masquage des noms de personnes côté client, en plus des règles de ``masking``.

Les règles ne reconnaissent que des valeurs à forme fixe (e-mail, téléphone, IBAN…) ; un
nom n'a pas de forme : il faut un modèle de langue. Il tourne ici sur votre machine, avec
une bibliothèque gratuite : le texte ne part nulle part pour être analysé.

    from wyrlo import Wyrlo
    from wyrlo.names import spacy_names

    wyrlo = Wyrlo(mask={"names": spacy_names("fr_core_news_md")})

``spacy_names`` demande ``pip install "wyrlo[names]"`` puis le modèle de votre langue
(``python -m spacy download fr_core_news_md``). Vous pouvez brancher un autre détecteur :
toute fonction qui rend les positions ``(début, fin)`` des noms d'un texte.

Limite à connaître : un modèle de langue se trompe. Il peut manquer un nom (prénom rare,
nom tout en minuscules, nom qui est aussi un mot courant) ou masquer un mot qui n'en est
pas un. Les noms d'entreprises et de lieux ne sont pas masqués. Mesurez sur vos propres
textes avant de vous y fier.
"""

from __future__ import annotations

import re
from typing import Callable, Dict, Iterable, List, Sequence, Tuple

from .masking import MaskedTexts, mask_texts

#: Position d'un nom de personne dans un texte (fin exclue).
NameSpan = Tuple[int, int]
#: Détecteur de noms : rend les positions des noms de personnes d'un texte.
NameFinder = Callable[[str], Iterable[NameSpan]]

_MARQUE = re.compile(r"\[[A-Z]+_\d+\]")


def _lettre(c: str) -> bool:
    return c.isalpha()


def _nettoyer(texte: str, positions: Iterable[NameSpan]) -> List[NameSpan]:
    """Positions valides, élargies au mot entier, sans chevauchement, hors des marques."""
    marques = [m.span() for m in _MARQUE.finditer(texte)]
    valides: List[NameSpan] = []
    for p in positions:
        try:
            debut, fin = p
        except (TypeError, ValueError):
            continue
        if not isinstance(debut, int) or not isinstance(fin, int):
            continue
        if debut < 0 or fin > len(texte) or debut >= fin:
            continue
        while debut > 0 and _lettre(texte[debut - 1]) and _lettre(texte[debut]):
            debut -= 1
        while fin < len(texte) and _lettre(texte[fin]) and _lettre(texte[fin - 1]):
            fin += 1
        while debut < fin and texte[debut].isspace():
            debut += 1
        while fin > debut and texte[fin - 1].isspace():
            fin -= 1
        if fin - debut < 2:
            continue
        if any(debut < m_fin and fin > m_debut for m_debut, m_fin in marques):
            continue
        valides.append((debut, fin))
    valides.sort(key=lambda v: (v[0], -v[1]))
    sorties: List[NameSpan] = []
    for v in valides:
        if sorties and v[0] < sorties[-1][1]:
            continue
        sorties.append(v)
    return sorties


def mask_texts_with_names(texts: Sequence[str], finder: NameFinder) -> MaskedTexts:
    """Règles intégrées, puis noms de personnes : chaque nom devient « [PERSONNE_n] ».

    La même marque pour un même nom dans tous les textes de l'appel, sans tenir compte de
    la casse ; un nom reconnu une fois est masqué partout. Une erreur du détecteur
    remonte : l'appelant n'envoie alors rien.
    """
    masque = mask_texts(list(texts))
    trouves: List[List[NameSpan]] = []
    connus: Dict[str, None] = {}
    for texte in masque.texts:
        positions = _nettoyer(texte, finder(texte))
        for debut, fin in positions:
            connus[texte[debut:fin]] = None
        trouves.append(positions)
    repetitions = sorted((n for n in connus if len(n) >= 4), key=len, reverse=True)
    partout = (
        re.compile(
            r"(?<!\w)(?:"
            + "|".join(r"\s+".join(re.escape(mot) for mot in n.split()) for n in repetitions)
            + r")(?!\w)",
            re.IGNORECASE,
        )
        if repetitions
        else None
    )
    numeros: Dict[str, int] = {}
    counts = dict(masque.counts)
    values = dict(masque.values)
    sorties: List[str] = []
    for texte, positions in zip(masque.texts, trouves):
        repris = [m.span() for m in partout.finditer(texte)] if partout else []
        sortie: List[str] = []
        position = 0
        for debut, fin in _nettoyer(texte, list(positions) + repris):
            valeur = texte[debut:fin]
            cle = " ".join(valeur.lower().split())
            n = numeros.setdefault(cle, len(numeros) + 1)
            marque = f"[PERSONNE_{n}]"
            values.setdefault(marque, valeur)
            counts["PERSONNE"] = counts.get("PERSONNE", 0) + 1
            sortie.append(texte[position:debut] + marque)
            position = fin
        sorties.append("".join(sortie) + texte[position:])
    return MaskedTexts(texts=sorties, counts=counts, values=values)


def spacy_names(
    model: str = "fr_core_news_md", labels: Sequence[str] = ("PER", "PERSON")
) -> NameFinder:
    """Détecteur de noms par spaCy (gratuit, exécuté sur votre machine).

    Le modèle est chargé au premier appel, une seule fois. ``model`` : un modèle spaCy
    installé pour votre langue (``fr_core_news_md``, ``en_core_web_sm``,
    ``de_core_news_md``, ``es_core_news_md``, ``it_core_news_md``, ou le multilingue
    ``xx_ent_wiki_sm``).
    """
    etat: Dict[str, object] = {}

    def trouver(texte: str) -> List[NameSpan]:
        if not texte.strip():
            return []
        if "nlp" not in etat:
            import spacy  # dépendance facultative : pip install "wyrlo[names]"

            etat["nlp"] = spacy.load(model)
        doc = etat["nlp"](texte)  # type: ignore[operator]
        return [(e.start_char, e.end_char) for e in doc.ents if e.label_ in labels]

    return trouver

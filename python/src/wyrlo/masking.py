"""Masquage côté client : les règles du masquage intégré de WYRLO, sur votre machine.

Les valeurs reconnues ne quittent jamais votre serveur ; WYRLO reçoit des marques
(« [EMAIL_1] », « [TELEPHONE_2] »…) qu'il sait traiter, et le SDK remet les vraies valeurs
dans ce qu'il vous rend.

Ce qui est masqué, par des règles avec contrôle de validité : EMAIL ; TELEPHONE (France et
international) ; IBAN (clé mod 97) ; CARTE (contrôle de Luhn) ; NIR (numéro de sécurité
sociale, clé de contrôle ou mot-clé proche) ; IP (v4, v6) ; PIECE (passeport, carte
d'identité, avec un mot-clé) ; ADRESSE (numéro et type de voie, France et anglais) ;
SECRET (clés d'API et jetons reconnaissables).

Ce qui n'est PAS masqué : les noms de personnes et d'entreprises, et tout identifiant sans
forme reconnaissable. Pour eux, passez votre propre fonction à ``Wyrlo(mask=...)`` (par
exemple Presidio, sur votre machine). Les dates, montants et numéros de commande restent :
la vérification doit pouvoir les comparer.

Traduction des règles du SDK TypeScript (``masking.ts``, elles-mêmes copie de celles du
moteur) : mêmes résultats sur le corpus commun (``masquage-corpus.json``, à côté des tests
du SDK TypeScript), vérifié par les tests des trois côtés. Les
classes de JavaScript sont reproduites à l'identique : ``\\d`` et ``\\b`` sur l'ASCII,
``\\s`` sur les espaces Unicode, fin de texte stricte.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

__all__ = ["MaskedTexts", "mask_texts", "unmask_text"]

# Équivalents exacts des classes de JavaScript (voir l'en-tête).
_S = "[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]"
_W = "A-Za-z0-9_"
_B = f"(?:(?<=[{_W}])(?![{_W}])|(?<![{_W}])(?=[{_W}]))"
_L = "[^\\W\\d_]"  # une lettre (\p{L})


def _chiffres(s: str) -> str:
    return re.sub(r"[^0-9]", "", s)


def iban_valide(brut: str) -> bool:
    """Clé IBAN (ISO 13616) : le reste de la division par 97 doit valoir 1."""
    iban = re.sub(f"(?:{_S}|-)", "", brut).upper()
    if not re.fullmatch(r"[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}", iban):
        return False
    reordonne = iban[4:] + iban[:4]
    reste = 0
    for c in reordonne:
        v = str(ord(c) - 55) if "A" <= c <= "Z" else c
        for d in v:
            reste = (reste * 10 + int(d)) % 97
    return reste == 1


#: Longueur des IBAN par pays (registre ISO 13616), pour l'Europe et ses voisins.
_LONGUEURS_IBAN = {
    "AD": 24, "AT": 20, "BA": 20, "BE": 16, "BG": 22, "CH": 21, "CY": 28, "CZ": 24, "DE": 22,
    "DK": 18, "EE": 20, "ES": 24, "FI": 18, "FO": 18, "FR": 27, "GB": 22, "GI": 23, "GL": 18,
    "GR": 27, "HR": 21, "HU": 28, "IE": 22, "IS": 26, "IT": 27, "LI": 21, "LT": 20, "LU": 20,
    "LV": 21, "MC": 27, "MD": 24, "ME": 22, "MK": 19, "MT": 31, "NL": 18, "NO": 15, "PL": 28,
    "PT": 25, "RO": 24, "RS": 22, "SE": 24, "SI": 19, "SK": 24, "SM": 27, "TR": 26, "UA": 29,
    "VA": 22,
}
_ALNUM = re.compile(r"[A-Z0-9]")


def longueur_iban(valeur: str) -> Optional[int]:
    """Longueur, dans la valeur trouvée, de l'IBAN valide qui la commence (None sinon)."""
    attendue = _LONGUEURS_IBAN.get(valeur[:2])
    if attendue is None:
        return len(valeur) if iban_valide(valeur) else None
    vus = 0
    for i, c in enumerate(valeur):
        if _ALNUM.fullmatch(c):
            vus += 1
        if vus == attendue:
            # La longueur du pays doit tomber à la fin d'un groupe.
            if i + 1 < len(valeur) and _ALNUM.fullmatch(valeur[i + 1]):
                return None
            return i + 1 if iban_valide(valeur[: i + 1]) else None
    return None


def luhn_valide(brut: str) -> bool:
    """Contrôle de Luhn (cartes bancaires), 13 à 19 chiffres, pas tous identiques."""
    n = _chiffres(brut)
    if len(n) < 13 or len(n) > 19 or re.fullmatch(r"([0-9])\1+", n):
        return False
    somme = 0
    for i in range(len(n)):
        d = int(n[len(n) - 1 - i])
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        somme += d
    return somme % 10 == 0


def nir_cle_valide(brut: str) -> bool:
    """Clé du NIR : 97 moins (les 13 premiers caractères modulo 97), Corse 2A = 19, 2B = 18."""
    s = re.sub(_S, "", brut).upper()
    if not re.fullmatch(r"[12][0-9]{4}(?:[0-9]{2}|2A|2B)[0-9]{6}[0-9]{2}", s):
        return False
    corps = s[:13].replace("2A", "19", 1).replace("2B", "18", 1)
    return 97 - int(corps) % 97 == int(s[13:])


_MOTS_NIR = re.compile(
    f"(s[ée]curit[ée]{_S}+sociale|{_B}NIR{_B}|{_B}n°{_S}*SS{_B}|num[ée]ro{_S}+de{_S}+s[ée]cu"
    f"|{_B}INSEE{_B}|social{_S}+security)",
    re.I,
)
_MOTS_SIRET = re.compile(f"{_B}SIR(?:ET|EN){_B}", re.I)
_MOTS_PIECE = re.compile(
    f"(passeport|passport|carte{_S}+(?:nationale{_S}+)?d['’]identit[ée]|{_B}CNI{_B}"
    f"|identity{_S}+card|ID{_S}+card)",
    re.I,
)


def _mot_cle_avant(texte: str, debut: int, motif: "re.Pattern[str]", portee: int = 60) -> bool:
    return motif.search(texte[max(0, debut - portee) : debut]) is not None


def _ipv6_valide(s: str) -> bool:
    if not re.search(r"[a-fA-F]", s) and "::" not in s:
        return False
    doubles = len(s.split("::")) - 1
    if doubles > 1:
        return False
    groupes = [g for g in s.split(":") if g != ""]
    if any(not re.fullmatch(r"[0-9a-fA-F]{1,4}", g) for g in groupes):
        return False
    return 2 <= len(groupes) <= 7 if doubles == 1 else len(groupes) == 8


_VOIES_FR = (
    "rue|avenue|av\\.|boulevard|bd|chemin|all[ée]e|impasse|place|quai|route|cours|square"
    "|passage|chauss[ée]e|voie|faubourg|fbg|r[ée]sidence|hameau|parvis|esplanade|promenade"
    "|sentier|villa|cit[ée]|lotissement|lieu-dit"
)
_VOIES_EN = (
    "Street|St\\.|Avenue|Ave\\.|Road|Rd\\.|Boulevard|Blvd\\.|Lane|Ln\\.|Drive|Dr\\.|Court"
    "|Ct\\.|Way|Place|Pl\\."
)

_Valide = Callable[[str, str, int], bool]
_Longueur = Callable[[str], Optional[int]]

# Règles dans l'ordre de priorité : une valeur déjà prise n'est jamais reprise. Dernier
# élément : longueur retenue au début de la valeur trouvée (la suite est relue).
_REGLES: List[Tuple[str, "re.Pattern[str]", Optional[_Valide], Optional[_Longueur]]] = [
    (
        "SECRET",
        re.compile(
            "|".join(
                [
                    f"{_B}(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{{16,}}",
                    f"{_B}sk-[A-Za-z0-9_-]{{20,}}",
                    f"{_B}sb_(?:secret|publishable)_[A-Za-z0-9_-]{{16,}}",
                    f"{_B}x(?:keysib|smtpsib)-[A-Za-z0-9-]{{20,}}",
                    f"{_B}gh[pousr]_[A-Za-z0-9]{{30,}}",
                    f"{_B}github_pat_[A-Za-z0-9_]{{30,}}",
                    f"{_B}AKIA[0-9A-Z]{{16}}{_B}",
                    f"{_B}AIza[0-9A-Za-z_-]{{35}}",
                    f"{_B}xox[abposr]-[A-Za-z0-9-]{{10,}}",
                    f"{_B}eyJ[A-Za-z0-9_-]{{10,}}\\.[A-Za-z0-9_-]{{10,}}\\.[A-Za-z0-9_-]{{10,}}",
                    f"(?:(?<=[^{_W}]Bearer{_S})|(?<=^Bearer{_S}))[A-Za-z0-9._~+/=-]{{20,}}",
                    f"{_B}wyr_(?:live|test)_(?=[A-Za-z0-9_.-]{{16,}})[A-Za-z0-9_-]+"
                    f"(?:\\.[A-Za-z0-9_-]+)*",
                ]
            )
        ),
        None,
        None,
    ),
    (
        # Lettres accentuées comprises (« chloé.martin@… » ne laisse pas « chloé » en clair).
        "EMAIL",
        re.compile(r"[\w.%+-]+@(?:[^\W_]|-)+(?:\.(?:[^\W_]|-)+)*\.[^\W\d_]{2,}"),
        None,
        None,
    ),
    (
        "IBAN",
        re.compile(f"{_B}[A-Z]{{2}}[0-9]{{2}}(?:[ -]?[A-Z0-9]{{2,4}}){{3,8}}{_B}"),
        None,
        longueur_iban,
    ),
    (
        # Avant les cartes : un NIR à 15 chiffres qui passe aussi le contrôle de Luhn reste un NIR.
        "NIR",
        re.compile(
            f"{_B}[12][ ]?[0-9]{{2}}[ ]?(?:0[1-9]|1[0-2]|[2-9][0-9])[ ]?(?:[0-9]{{2}}|2[AB])"
            f"[ ]?[0-9]{{3}}[ ]?[0-9]{{3}}(?:[ ]?[0-9]{{2}})?{_B}"
        ),
        lambda v, t, d: (
            nir_cle_valide(v) or _mot_cle_avant(t, d, _MOTS_NIR)
            if len(_chiffres(re.sub(r"2[AB]", "00", v, count=1, flags=re.I))) == 15
            else _mot_cle_avant(t, d, _MOTS_NIR)
        ),
        None,
    ),
    (
        "CARTE",
        re.compile(r"(?<![0-9.,])(?:[0-9][ -]?){12,18}[0-9](?![0-9.,][0-9])"),
        # Un SIRET ou un SIREN passe le contrôle de Luhn par construction : pas une carte.
        lambda v, t, d: luhn_valide(v) and not _mot_cle_avant(t, d, _MOTS_SIRET, 25),
        None,
    ),
    (
        "TELEPHONE",
        re.compile(
            f"(?<![{_W}+])(?:(?:\\+|00)33[ .-]?(?:\\(0\\)[ .-]?)?[1-9]|0[1-9])"
            f"(?:[ .-]?[0-9]{{2}}){{4}}(?![0-9])"
            f"|(?<![{_W}+])\\+(?!33)[0-9]{{1,3}}(?:[ .-]?\\(?[0-9]{{1,4}}\\)?){{2,5}}(?![0-9])"
        ),
        lambda v, _t, _d: 9 <= len(_chiffres(v)) <= 15,
        None,
    ),
    (
        "IP",
        re.compile(
            r"(?<![0-9.])(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\.){3}"
            r"(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?![0-9.]*[0-9])"
            f"|(?<![{_W}:])(?:[0-9A-Fa-f]{{0,4}}:){{2,7}}[0-9A-Fa-f]{{0,4}}(?![{_W}:])"
        ),
        lambda v, _t, _d: _ipv6_valide(v) if ":" in v else True,
        None,
    ),
    (
        "PIECE",
        re.compile(f"{_B}(?=[A-Z0-9]*[0-9][A-Z0-9]*[0-9])[A-Z0-9]{{9,12}}{_B}"),
        lambda v, t, d: _mot_cle_avant(t, d, _MOTS_PIECE, 40),
        None,
    ),
    (
        "ADRESSE",
        re.compile(
            f"{_B}[0-9]{{1,4}}(?:[a-z](?!{_L}))?(?:{_S}?(?:bis|ter|quater))?,?{_S}+(?:{_VOIES_FR}){_S}+"
            f"[^\\n,;:()]{{2,60}}?(?=[,;:()\\n]|\\.(?:{_S}|\\Z)|\\Z)"
            f"(?:,{_S}*[0-9]{{5}}{_S}+[A-ZÀ-Ý](?:{_L}|['’ -]){{1,40}}{_L})?"
            f"|{_B}[0-9]{{1,5}}(?:[a-z](?!{_L}))?{_S}+(?:[A-Z][a-z]+{_S}){{1,3}}(?:{_VOIES_EN})(?!{_L})"
            f"(?:,{_S}*[A-Z][a-z]+(?:{_S}[A-Z][a-z]+)?(?:,{_S}*[A-Z]{{2}})?{_S}+[0-9]{{5}}"
            f"(?:-[0-9]{{4}})?)?",
            re.I,
        ),
        None,
        None,
    ),
]


def _normaliser(type_: str, valeur: str) -> str:
    """Normalisation d'une valeur pour l'égalité des marques (casse, espaces, séparateurs)."""
    v = valeur.strip().lower()
    if type_ in ("EMAIL", "SECRET", "ADRESSE"):
        return re.sub(f"{_S}+", " ", v)
    v = re.sub(f"(?:{_S}|[.()+-])", "", v)
    return re.sub(r"^0033|^33(?=[0-9]{9}\Z)", "0", v, count=1)


def _trouver(texte: str) -> List[Tuple[int, int, str, str]]:
    """Valeurs trouvées dans un texte, sans chevauchement, dans l'ordre du texte."""
    pris: List[Tuple[int, int, str, str]] = []
    for type_, motif, valide, longueur in _REGLES:
        pos = 0
        while True:
            m = motif.search(texte, pos)
            if m is None:
                break
            valeur = m.group(0)
            debut, fin = m.start(), m.end()
            pos = fin if fin > debut else fin + 1
            if longueur is not None and valeur:
                n = longueur(valeur)
                if n is None:
                    continue
                # Valeur raccourcie : la suite est relue (un second IBAN collé au premier).
                valeur, fin = valeur[:n], debut + n
                pos = fin
            if not valeur.strip():
                continue
            if any(not (fin <= p[0] or debut >= p[1]) for p in pris):
                continue
            if valide is not None and not valide(valeur, texte, debut):
                continue
            pris.append((debut, fin, type_, valeur))
    return sorted(pris, key=lambda p: p[0])


@dataclass(frozen=True)
class MaskedTexts:
    """Textes masqués, décompte par type et valeurs d'origine de chaque marque."""

    texts: List[str]
    #: Nombre de remplacements par type (« EMAIL », « TELEPHONE »…), sans aucune valeur.
    counts: Dict[str, int] = field(default_factory=dict)
    #: Marque → valeur d'origine (première écriture rencontrée). Reste sur votre machine.
    values: Dict[str, str] = field(default_factory=dict)


def mask_texts(texts: List[str]) -> MaskedTexts:
    """Masque des textes en un seul lot : une même valeur reçoit la même marque partout."""
    numeros: Dict[str, int] = {}
    par_type: Dict[str, int] = {}
    counts: Dict[str, int] = {}
    values: Dict[str, str] = {}
    sorties: List[str] = []
    for texte in texts:
        sortie = []
        position = 0
        for debut, fin, type_, valeur in _trouver(texte):
            cle = f"{type_}\0{_normaliser(type_, valeur)}"
            n = numeros.get(cle)
            if n is None:
                n = par_type.get(type_, 0) + 1
                par_type[type_] = n
                numeros[cle] = n
            marque = f"[{type_}_{n}]"
            values.setdefault(marque, valeur)
            counts[type_] = counts.get(type_, 0) + 1
            sortie.append(texte[position:debut] + marque)
            position = fin
        sortie.append(texte[position:])
        sorties.append("".join(sortie))
    return MaskedTexts(texts=sorties, counts=counts, values=values)


def unmask_text(text: str, values: Dict[str, str]) -> str:
    """Remet les valeurs d'origine à la place des marques produites par ``mask_texts``."""
    if not values:
        return text
    return re.sub(r"\[[A-Z]+_[0-9]+\]", lambda m: values.get(m.group(0), m.group(0)), text)

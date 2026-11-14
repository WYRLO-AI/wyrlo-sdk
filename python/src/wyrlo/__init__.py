"""SDK Python de WYRLO.

    from wyrlo import Wyrlo

    wyrlo = Wyrlo()  # lit WYRLO_API_KEY
    res = wyrlo.guard(question=question, passages=passages, answer=answer)
    if res.decision == "abstain":
        return "Je ne sais pas."

Principes (identiques au SDK TypeScript) :
- WYRLO ne bloque jamais votre utilisateur : panne réseau, délai dépassé ou erreur
  5xx donnent un résultat « dégradé » (decision « answer », confiance « unverified »,
  ``degraded=True``), sans exception.
- Une erreur de votre intégration (clé invalide, requête mal formée) lève
  ``WyrloError``.
- Chaque appel porte un ``request_id`` : un nouvel essai n'est compté qu'une fois.
- Chaque appel impose la région de traitement (``X-Region: eu-west-3``, Paris).
- Côté serveur uniquement. Aucune dépendance : bibliothèque standard seulement.
- Option ``mask`` : les données personnelles reconnaissables sont masquées sur votre
  serveur avant l'envoi ; si le masquage échoue, rien n'est envoyé (résultat dégradé).
- Index sans copie (mode B, ouvert sur demande) : ``index()``, ``remove()``,
  ``index_stats()`` et ``search()``. WYRLO ne garde aucun texte : seulement l'adresse,
  l'empreinte et le vecteur de chaque passage. Une recherche en panne rend une liste vide
  marquée ``degraded`` ; une indexation en panne lève ``WyrloError`` (à refaire).
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Union

from .masking import MaskedTexts, mask_texts, unmask_text

__all__ = [
    "API_VERSION",
    "DEFAULT_BASE_URL",
    "DEFAULT_REGION",
    "GuardPassage",
    "GuardResult",
    "LocalMasking",
    "MaskedTexts",
    "PrepareResult",
    "SearchResult",
    "Wyrlo",
    "WyrloError",
    "mask_texts",
    "passages_from_search",
    "unmask_text",
]

__version__ = "0.1.2"
API_VERSION = "2026-09-25"
#: Adresse par défaut de l'API (``base_url`` ou variable d'environnement ``WYRLO_BASE_URL``).
DEFAULT_BASE_URL = "https://api.wyrlo.io/functions/v1"


class _SansRedirection(urllib.request.HTTPRedirectHandler):
    """Aucune redirection suivie : urllib renverrait l'en-tête Authorization, donc la clé,
    vers l'adresse de destination, quelle qu'elle soit (audit de sécurité, SEC-33). Une
    redirection devient une erreur HTTP, traitée comme une panne."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


_OUVREUR = urllib.request.build_opener(_SansRedirection)


def _ouvrir(request: urllib.request.Request, timeout: float):
    return _OUVREUR.open(request, timeout=timeout)


def _adresse_sure(url: str) -> bool:
    """https, ou la machine locale (tests, relais local) : jamais la clé en clair."""
    if url.startswith("https://"):
        return True
    hote = url.split("://", 1)[-1].split("/", 1)[0].rsplit(":", 1)[0].strip("[]")
    return url.startswith("http://") and hote in ("localhost", "127.0.0.1", "::1")
#: Région d'exécution imposée à la fonction ``guard`` : Paris, région du projet
#: (ADR 0003). Sans consigne, Supabase exécute la fonction dans la région la plus
#: proche de l'appelant (us-east-1 depuis les États-Unis, par exemple). Or la
#: question, les passages et la réponse y arrivent en clair, avant masquage :
#: l'en-tête ``X-Region`` garantit que ce traitement reste en Europe. Vérifiable
#: avec l'en-tête de réponse ``x-sb-edge-region``.
DEFAULT_REGION = "eu-west-3"

PassageInput = Union[Mapping[str, Any], str]
Generate = Callable[[List[Dict[str, Any]]], str]
#: Fonction de masquage : tous les textes d'un appel, autant de textes masqués en retour.
Masker = Callable[[List[str]], List[str]]

_ALL_STEPS = ["rerank", "injection_check", "consistency", "verification"]
# Temps restant minimal pour tenter un nouvel appel dans le délai (secondes).
_MIN_ATTEMPT_S = 0.3
#: Délai par défaut d'une indexation, en secondes (vecteurs de 2 000 passages au plus).
INDEX_TIMEOUT_S = 30.0
# Réponse « surchargé » (503, 429) : mode dégradé sans nouvel essai.
_OVERLOADED = object()



def _tenant_query(tenant: Optional[str]) -> str:
    """Paramètre ``?tenant=`` des routes sans corps (mode C)."""
    return "?tenant=" + urllib.parse.quote(tenant, safe="") if tenant else ""

class WyrloError(Exception):
    """Erreur de l'intégration : clé absente ou refusée, requête invalide."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Optional[List[Dict[str, str]]] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or []


@dataclass(frozen=True)
class GuardPassage:
    id: str
    kept: bool
    rank: Optional[int]
    score: Optional[float]
    injection: bool
    #: Mode B : vrai si le texte envoyé ne correspond plus à l'empreinte de son adresse
    #: (document modifié depuis son indexation) ; None pour un passage sans adresse.
    stale: Optional[bool] = None


@dataclass(frozen=True)
class LocalMasking:
    """Masquage fait sur votre machine avant l'envoi (option ``mask``)."""

    #: « rules » : règles intégrées au SDK ; « custom » : votre fonction.
    method: str
    #: Remplacements par type (règles intégrées seulement), sans aucune valeur.
    counts: Optional[Dict[str, int]] = None


@dataclass(frozen=True)
class GuardResult:
    decision: str
    confidence: str
    confidence_score: Optional[float]
    reason: str
    answer: str
    request_id: str
    trace_id: Optional[str] = None
    #: Mode dégradé : WYRLO injoignable, plafond atteint ou traitement sauté. Toujours
    #: vrai quand ``confidence`` vaut « unverified » (réponse transmise sans contrôle).
    degraded: bool = False
    passages: List[GuardPassage] = field(default_factory=list)
    unsupported_sentences: List[str] = field(default_factory=list)
    injection_detected: bool = False
    skipped_steps: List[str] = field(default_factory=list)
    settings_version: Optional[int] = None
    #: Langue retenue (précisée ou devinée), None si inconnue.
    language: Optional[str] = None
    #: « similarity » (toutes langues, similarité d'empreintes), « none » ; « model »
    #: n'est plus renvoyé en direct.
    rerank_method: str = "none"
    #: « answer » (anglais : réponse entière, phrase par phrase la nuit),
    #: « sentences », « signals » (vérification non disponible pour cette langue :
    #: confiance calculée à partir des signaux), « model » (réponse française
    #: vérifiée par un modèle de langue), « none ».
    verification_method: str = "none"
    latency_ms: int = 0
    #: Plafond mensuel de l'offre atteint : réponse transmise sans vérification.
    quota_exceeded: bool = False
    #: Variante des réglages pendant un test partiel (« candidate » ou « control »).
    settings_variant: Optional[str] = None
    #: Masquage fait sur votre machine avant l'envoi (option ``mask``), sinon None.
    local_masking: Optional[LocalMasking] = None

    @property
    def should_answer(self) -> bool:
        return self.decision == "answer"

    @property
    def kept_passages(self) -> List[GuardPassage]:
        return [p for p in self.passages if p.kept]


@dataclass(frozen=True)
class SearchResult:
    """Résultat de ``search()`` : des adresses de passages, jamais de texte."""

    #: Chaque résultat : ``document``, ``version``, ``start``, ``length``,
    #: ``fingerprint``, ``index``, ``labels``, ``score``. Relisez le texte chez vous et
    #: passez-le à ``guard`` avec ``address`` (les cinq premiers champs).
    results: List[Dict[str, Any]]
    request_id: str
    #: WYRLO injoignable, surchargé ou masquage local en échec : ``results`` est vide, à
    #: compléter par votre propre recherche.
    degraded: bool = False


@dataclass(frozen=True)
class PrepareResult:
    """Résultat de l'étape « préparer » : la question à donner à votre recherche."""

    query: str
    request_id: str
    added_terms: List[str] = field(default_factory=list)
    settings_version: Optional[int] = None
    #: « candidate » ou « control » pendant un test partiel, None sinon.
    settings_variant: Optional[str] = None
    #: Vrai si WYRLO n'a pas pu être joint : la question d'origine est renvoyée.
    degraded: bool = False


def _normalize_passages(passages: Sequence[PassageInput]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for passage in passages:
        if isinstance(passage, str):
            out.append({"text": passage})
            continue
        item: Dict[str, Any] = {"text": passage["text"]}
        for key in ("id", "source", "score", "address"):
            if passage.get(key) is not None:
                item[key] = passage[key]
        out.append(item)
    return out


#: Délai par défaut de ``answer`` (secondes) : un modèle rédige, c'est plus long.
ANSWER_TIMEOUT = 60.0

#: Champs de l'adresse d'un passage (mode B), dans les résultats de ``search``.
ADDRESS_FIELDS = ("document", "version", "start", "length", "fingerprint")

#: Lecture d'un passage chez vous : (document, version, début, longueur) → texte, ou None
#: si le document n'existe plus.
Reader = Callable[[str, str, int, int], Optional[str]]


def passages_from_search(results: Sequence[Mapping[str, Any]], read: Reader) -> List[Dict[str, Any]]:
    """Passages pour ``guard`` à partir des résultats de ``search`` (mode B).

    ``read`` relit le texte chez vous (base, stockage, outil). Chaque passage garde son
    ``address`` : s'il a changé depuis son indexation, ``guard`` le signale « périmé ».
    Un résultat que ``read`` ne retrouve pas (``None``) est écarté.
    """
    out: List[Dict[str, Any]] = []
    for r in results:
        text = read(str(r["document"]), str(r["version"]), int(r["start"]), int(r["length"]))
        if text is None:
            continue
        passage: Dict[str, Any] = {
            "id": f"{r['document']}#{r['start']}",
            "text": text,
            "source": str(r["document"]),
            "address": {k: r[k] for k in ADDRESS_FIELDS},
        }
        if isinstance(r.get("score"), (int, float)):
            passage["score"] = float(r["score"])
        out.append(passage)
    return out


def _identite(texte: str) -> str:
    return texte


def _appliquer_masque(
    mask: Union[bool, Masker], texts: List[str]
) -> Optional[tuple]:
    """Masque les textes d'un appel : (textes, restauration, LocalMasking), ou None en échec."""
    try:
        if callable(mask):
            out = mask(list(texts))
            if (
                not isinstance(out, (list, tuple))
                or len(out) != len(texts)
                or any(not isinstance(t, str) for t in out)
            ):
                return None
            return list(out), _identite, LocalMasking("custom", None)
        masque = mask_texts(texts)
        return (
            masque.texts,
            lambda t: unmask_text(t, masque.values),
            LocalMasking("rules", dict(masque.counts)),
        )
    except Exception:  # noqa: BLE001 - tout échec du masquage : rien n'est envoyé
        return None


class Wyrlo:
    """Client WYRLO.

    :param api_key: clé du projet (``wyr_test_…`` ou ``wyr_live_…``), par défaut
        ``WYRLO_API_KEY``.
    :param base_url: adresse de l'API, par défaut ``WYRLO_BASE_URL``, sinon
        ``DEFAULT_BASE_URL``.
    :param timeout: délai maximal d'un appel à ``guard``, en secondes, nouvelles
        tentatives comprises (3 par défaut). Au-delà, la réponse est transmise en mode
        dégradé, sans erreur.
    :param max_retries: nouvelles tentatives après une panne ou une erreur 5xx, dans le
        même délai (1). Jamais après une réponse « surchargé » (503, 429).
    :param region: région où la fonction traite le texte en clair (en-tête
        ``X-Region``), par défaut ``WYRLO_REGION``, sinon ``eu-west-3`` (Paris). Voir
        ``DEFAULT_REGION`` : ne la changez que si vous savez où vos données peuvent
        être traitées.
    :param mask: masquage côté client, avant tout envoi (question, réponse, texte des
        passages). ``True`` : les règles du masquage intégré de WYRLO (e-mails,
        téléphones, IBAN, cartes, numéro de sécurité sociale, adresses IP, pièces
        d'identité, adresses postales, clés d'API), sur votre machine ; les vraies
        valeurs sont remises dans la raison et les phrases non appuyées. Une fonction :
        la vôtre (par exemple Presidio sur votre machine, pour les noms de personnes),
        qui reçoit tous les textes d'un appel et rend autant de textes masqués. Si le
        masquage échoue, rien n'est envoyé : réponse transmise sans vérification
        (``degraded``, étape « anonymize » sautée). Par défaut : désactivé.
    :param locale: langue des messages et des raisons (``reason``) renvoyés par l'API :
        ``"en"`` (anglais, par défaut) ou ``"fr"`` (français), par l'en-tête
        Accept-Language.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 3.0,
        max_retries: int = 1,
        region: Optional[str] = None,
        mask: Union[bool, Masker, None] = None,
        locale: Optional[str] = None,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get("WYRLO_API_KEY")
        if not key:
            raise WyrloError(
                0,
                "missing_api_key",
                "Missing API key: pass api_key or set WYRLO_API_KEY.",
            )
        self._api_key = key
        self._base_url = (
            (base_url or "").strip()
            or os.environ.get("WYRLO_BASE_URL", "").strip()
            or DEFAULT_BASE_URL
        ).rstrip("/")
        if not _adresse_sure(self._base_url):
            raise WyrloError(
                0,
                "insecure_base_url",
                "API address refused: https required (the key would be sent in clear text).",
            )
        # Une valeur vide retombe sur Paris : ne jamais laisser la région au hasard.
        self._region = (
            (region or "").strip()
            or os.environ.get("WYRLO_REGION", "").strip()
            or DEFAULT_REGION
        )
        # Langue des messages et des raisons de l'API : anglais par défaut, « fr » sur demande.
        self._language: Dict[str, str] = {"Accept-Language": locale} if locale else {}
        self._timeout = timeout
        self._max_retries = max(0, max_retries)
        self._mask: Union[bool, Masker] = mask or False

    def guard(
        self,
        question: str,
        passages: Sequence[PassageInput],
        answer: Optional[str] = None,
        generate: Optional[Generate] = None,
        language: Optional[str] = None,
        request_id: Optional[str] = None,
        timeout: Optional[float] = None,
        tenant: Optional[str] = None,
    ) -> GuardResult:
        """Vérifie une réponse de votre RAG.

        ``tenant`` : client final pour lequel la vérification est faite (plateformes) ;
        elle est alors comptée pour ce client.

        Donnez ``answer`` (la réponse de votre LLM) ou ``generate``, une fonction qui
        la produit à partir des passages. Ne lève jamais d'exception pour une panne de
        WYRLO ; lève ``WyrloError`` si la clé ou la requête sont invalides.
        """
        if (answer is None) == (generate is None):
            raise ValueError("Pass answer or generate (one of the two).")
        items = _normalize_passages(passages)
        text = (generate(items) if generate is not None else answer) or ""
        rid = request_id or str(uuid.uuid4())
        started = time.monotonic()

        # Masquage côté client : les textes masqués partent, jamais les valeurs. En échec,
        # rien n'est envoyé (même règle stricte que le moteur avant Mistral).
        sent_question, sent_answer, sent_items = question, text, items
        restore: Callable[[str], str] = _identite
        local_masking: Optional[LocalMasking] = None
        if self._mask:
            masque = _appliquer_masque(
                self._mask, [question, text] + [str(item["text"]) for item in items]
            )
            if masque is None:
                return self._degraded(
                    items,
                    text,
                    rid,
                    started,
                    language,
                    "Local masking failed: nothing was sent to WYRLO, answer passed "
                    "through without verification.",
                    list(_ALL_STEPS) + ["anonymize"],
                    None,
                )
            textes, restore, local_masking = masque
            sent_question, sent_answer = textes[0], textes[1]
            sent_items = []
            for item, t in zip(items, textes[2:]):
                envoye = dict(item, text=t)
                # Texte changé par le masquage : son empreinte ne peut plus correspondre à
                # celle de l'index ; l'adresse est retirée (pas de « périmé » à tort).
                if "address" in envoye and t != item["text"]:
                    del envoye["address"]
                sent_items.append(envoye)
        body: Dict[str, Any] = {
            "question": sent_question,
            "answer": sent_answer,
            "passages": sent_items,
            "request_id": rid,
        }
        if language:
            body["language"] = language
        if tenant:
            body["tenant"] = tenant
        payload = json.dumps(body).encode("utf-8")

        # Délai total : nouvelles tentatives comprises, jamais au-delà du délai.
        budget = timeout if timeout is not None else self._timeout
        overloaded = False
        for attempt in range(self._max_retries + 1):
            if attempt:
                pause = min(0.2 * 2 ** (attempt - 1), 1.0)
                if budget - (time.monotonic() - started) - pause < _MIN_ATTEMPT_S:
                    break
                time.sleep(pause)
            remaining = budget - (time.monotonic() - started)
            if remaining <= 0:
                break
            data = self._send(payload, remaining)
            if data is _OVERLOADED:
                # Service surchargé : pas de nouvel essai, mode dégradé.
                overloaded = True
                break
            if data is not None:
                return self._result(data, text, rid, restore, local_masking)

        return self._degraded(
            items,
            text,
            rid,
            started,
            language,
            "WYRLO temporarily overloaded: answer passed through without verification."
            if overloaded
            else "WYRLO unreachable: answer passed through without verification.",
            list(_ALL_STEPS),
            local_masking,
        )

    @staticmethod
    def _degraded(
        items: List[Dict[str, Any]],
        answer: str,
        rid: str,
        started: float,
        language: Optional[str],
        reason: str,
        steps: List[str],
        local_masking: Optional[LocalMasking],
    ) -> GuardResult:
        """Résultat dégradé : la réponse passe, sans vérification (jamais bloquant)."""
        return GuardResult(
            decision="answer",
            confidence="unverified",
            confidence_score=None,
            reason=reason,
            answer=answer,
            request_id=rid,
            trace_id=None,
            degraded=True,
            passages=[
                GuardPassage(item.get("id", f"p{i + 1}"), True, None, None, False)
                for i, item in enumerate(items)
            ],
            skipped_steps=steps,
            language=(language or "").strip().lower().split("-")[0] or None,
            latency_ms=int((time.monotonic() - started) * 1000),
            local_masking=local_masking,
        )

    def prepare(
        self,
        question: str,
        request_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> PrepareResult:
        """Étape à appeler AVANT votre recherche.

        Renvoie la question à chercher, enrichie du vocabulaire du projet (et, pendant un
        test partiel, de la variante attribuée à cette requête). Passez ensuite le même
        ``request_id`` à ``guard``. Ne lève jamais d'exception pour une panne de WYRLO :
        la question d'origine est alors renvoyée telle quelle.
        """
        rid = request_id or str(uuid.uuid4())
        # Masquage côté client : la question masquée part ; en échec, rien n'est envoyé.
        sent = question
        restore: Callable[[str], str] = _identite
        if self._mask:
            masque = _appliquer_masque(self._mask, [question])
            if masque is None:
                return PrepareResult(query=question, request_id=rid, degraded=True)
            sent, restore = masque[0][0], masque[1]
        payload = json.dumps({"question": sent, "request_id": rid}).encode("utf-8")
        data = self._send(payload, timeout if timeout is not None else self._timeout, "/guard/prepare")
        if not isinstance(data, dict) or not isinstance(data.get("query"), str):
            return PrepareResult(query=question, request_id=rid, degraded=True)
        query = data["query"]
        if sent != question:
            # Question masquée : la recherche se fait avec la vraie question, enrichie des
            # termes ajoutés ; forme inattendue : valeurs remises, sinon question d'origine.
            if query.startswith(sent):
                query = question + query[len(sent) :]
            elif self._mask is True:
                query = restore(query)
            else:
                query = question
        return PrepareResult(
            query=query,
            request_id=rid,
            added_terms=[restore(t) for t in data.get("added_terms", [])],
            settings_version=data.get("settings_version"),
            settings_variant=data.get("settings_variant"),
        )

    def feedback(self, trace_id: str, helpful: bool, timeout: Optional[float] = None) -> bool:
        """Retour de l'utilisateur final sur une réponse donnée (pouce en haut : ``True``).

        ``trace_id`` : identifiant renvoyé par ``guard``. Aucun texte n'est envoyé. WYRLO
        s'en sert pour juger ses corrections sans appel payant. Renvoie ``True`` si le
        retour est enregistré ; ne lève jamais d'exception pour une panne de WYRLO ni pour
        une trace inconnue (``False``).
        """
        payload = json.dumps({"trace_id": trace_id, "helpful": bool(helpful)}).encode("utf-8")
        try:
            data = self._send(
                payload, timeout if timeout is not None else self._timeout, "/guard/feedback"
            )
        except WyrloError as error:
            if error.status == 404:
                return False
            raise
        return isinstance(data, dict) and data.get("recorded") is True

    def index(
        self,
        document: str,
        version: str,
        text: Optional[str] = None,
        passages: Optional[Sequence[Mapping[str, Any]]] = None,
        labels: Optional[Sequence[str]] = None,
        request_id: Optional[str] = None,
        timeout: Optional[float] = None,
        allow_unmasked: bool = False,
        tenant: Optional[str] = None,
        title: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Indexe un document (mode B) : ``PUT /guard/index/documents/{document}``.

        Donnez ``text`` (découpé par WYRLO) ou ``passages`` (``{"text", "start"}``, déjà
        découpés ; ``context`` facultatif : en-têtes du tableau ou titre de la section,
        placés devant le passage pour les vecteurs seulement, jamais conservés). WYRLO masque, calcule les vecteurs, puis oublie le texte. La même
        ``version`` déjà indexée répond « unchanged » sans rien recalculer ni compter.
        Lève ``WyrloError`` pour toute erreur, panne comprise (``unavailable``) : l'appel
        peut être refait sans risque. Avec l'option ``mask``, rien n'est envoyé sans
        ``allow_unmasked=True`` (``mask_unsupported``) : positions et empreintes doivent
        porter sur votre texte d'origine. ``tenant`` : espace du client final (mode C),
        identifiant opaque de votre choix (jamais un nom ni une adresse e-mail). ``title`` :
        titre du document, placé en tête de chaque passage pour les vecteurs, jamais conservé
        (changez la ``version`` si le titre change).
        """
        if (text is None) == (passages is None):
            raise ValueError("Pass text or passages (one of the two).")
        if self._mask and not allow_unmasked:
            raise WyrloError(
                0,
                "mask_unsupported",
                "mask option on: index() does not send your text without "
                "allow_unmasked=True.",
            )
        body: Dict[str, Any] = {"version": version, "request_id": request_id or str(uuid.uuid4())}
        if text is not None:
            body["text"] = text
        else:
            body["passages"] = [
                {
                    "text": p["text"],
                    "start": p["start"],
                    **({"context": p["context"]} if p.get("context") else {}),
                }
                for p in passages or []
            ]
        if title:
            body["title"] = title
        if labels:
            body["labels"] = list(labels)
        if tenant:
            body["tenant"] = tenant
        return self._call_or_raise(
            "PUT",
            "/guard/index/documents/" + urllib.parse.quote(document, safe=""),
            body,
            timeout if timeout is not None else INDEX_TIMEOUT_S,
        )

    def index_many(
        self,
        documents: Sequence[Mapping[str, Any]],
        tenant: Optional[str] = None,
        request_id: Optional[str] = None,
        timeout: Optional[float] = None,
        allow_unmasked: bool = False,
    ) -> Dict[str, Any]:
        """Indexe un lot de documents en un appel : ``POST /guard/index/documents``.

        100 documents au plus (corps de 512 Kio au plus), dans le même espace ``tenant``.
        Chaque document est un dictionnaire avec ``id``, ``version`` et ``text`` ou
        ``passages`` (et, facultatifs, ``title`` et ``labels``). Un document refusé n'empêche
        pas les autres : ``results[i]["status"]`` vaut « failed » avec ``error`` ; avec le code
        « overloaded », renvoyez-le plus tard. Lève ``WyrloError`` si tout le lot est refusé
        (forme, clé, mode B coupé) ou en panne : l'appel peut être refait sans risque.
        """
        if self._mask and not allow_unmasked:
            raise WyrloError(
                0,
                "mask_unsupported",
                "mask option on: index_many() does not send your text without "
                "allow_unmasked=True.",
            )
        body: Dict[str, Any] = {
            "documents": [dict(d) for d in documents],
            "request_id": request_id or str(uuid.uuid4()),
        }
        if tenant:
            body["tenant"] = tenant
        return self._call_or_raise(
            "POST",
            "/guard/index/documents",
            body,
            timeout if timeout is not None else INDEX_TIMEOUT_S,
        )

    def remove(
        self, document: str, timeout: Optional[float] = None, tenant: Optional[str] = None
    ) -> Dict[str, Any]:
        """Retire un document de l'index (tous ses passages), même mode B coupé.

        Un document inconnu rend ``deleted: False``. Lève ``WyrloError`` pour toute erreur,
        panne comprise. ``tenant`` : espace du client final (mode C) du document.
        """
        return self._call_or_raise(
            "DELETE",
            "/guard/index/documents/" + urllib.parse.quote(document, safe="") + _tenant_query(tenant),
            None,
            timeout if timeout is not None else INDEX_TIMEOUT_S,
        )

    def index_stats(
        self, timeout: Optional[float] = None, tenant: Optional[str] = None
    ) -> Dict[str, Any]:
        """Chiffres de l'index du projet (``GET /guard/index/stats``), sans identifiant ;
        avec ``tenant``, ceux d'un seul espace (mode C)."""
        return self._call_or_raise(
            "GET",
            "/guard/index/stats" + _tenant_query(tenant),
            None,
            timeout if timeout is not None else self._timeout,
        )

    def remove_tenant(self, tenant: str, timeout: Optional[float] = None) -> Dict[str, Any]:
        """Efface tout l'espace d'un client final (mode C) : ``DELETE /guard/index?tenant=…``.

        Tout de suite, même mode B coupé. Rend ``tenant``, ``documents`` et ``passages``
        effacés. Lève ``WyrloError`` pour toute erreur, panne comprise.
        """
        if not tenant:
            raise ValueError("tenant: identifier expected.")
        return self._call_or_raise(
            "DELETE",
            "/guard/index" + _tenant_query(tenant),
            None,
            timeout if timeout is not None else INDEX_TIMEOUT_S,
        )

    def search(
        self,
        question: str,
        k: Optional[int] = None,
        labels_any: Optional[Sequence[str]] = None,
        keyword_hits: Optional[Sequence[str]] = None,
        request_id: Optional[str] = None,
        timeout: Optional[float] = None,
        tenant: Optional[str] = None,
    ) -> SearchResult:
        """Recherche dans l'index (``POST /guard/search``) : des adresses, sans texte.

        ``keyword_hits`` : identifiants des documents trouvés par votre recherche par
        mots-clés, du meilleur au moins bon (fusion). Ne lève jamais d'exception pour une
        panne (liste vide, ``degraded``) ; lève ``WyrloError`` si la clé ou la requête
        sont refusées, ou le mode B coupé (403). ``tenant`` : espace du client final (mode C),
        la recherche ne voit que lui.
        """
        rid = request_id or str(uuid.uuid4())
        sent = question
        if self._mask:
            masque = _appliquer_masque(self._mask, [question])
            if masque is None:
                return SearchResult(results=[], request_id=rid, degraded=True)
            sent = masque[0][0]
        body: Dict[str, Any] = {"question": sent, "request_id": rid}
        if k is not None:
            body["k"] = k
        if labels_any:
            body["labels_any"] = list(labels_any)
        if keyword_hits:
            body["keyword_hits"] = [{"document": d} for d in keyword_hits]
        if tenant:
            body["tenant"] = tenant
        data = self._call(
            "POST", "/guard/search", body, timeout if timeout is not None else self._timeout
        )
        if not isinstance(data, dict) or not isinstance(data.get("results"), list):
            return SearchResult(results=[], request_id=rid, degraded=True)
        return SearchResult(results=list(data["results"]), request_id=rid)

    def answer(
        self,
        question: str,
        read: Optional[Reader] = None,
        passages: Optional[Sequence[PassageInput]] = None,
        k: Optional[int] = None,
        labels_any: Optional[Sequence[str]] = None,
        keyword_hits: Optional[Sequence[str]] = None,
        tenant: Optional[str] = None,
        language: Optional[str] = None,
        model: Optional[Mapping[str, Any]] = None,
        request_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """La réponse complète en un appel (``POST /guard/answer``).

        Un modèle rédige à partir des passages, WYRLO vérifie toujours, et la réponse
        revient phrase par phrase (``sentences``) avec sa confiance et ses sources.
        ``decision == "abstain"`` : « je ne sais pas », avec des pistes (``leads``).

        Deux façons de donner les passages : ``read`` (WYRLO cherche dans l'index sans
        copie, votre fonction relit chaque passage chez vous : WYRLO ne garde jamais le
        texte) ou ``passages`` (vous les fournissez).

        ``model`` : absent, le modèle enregistré pour le projet s'il y en a un, sinon le
        modèle géré par WYRLO (Europe, après masquage) ; le vôtre :
        ``{"provider": "openai", "name": "...", "api_key": "..."}`` (et ``base_url`` pour
        ``azure_openai`` et ``openai_compatible``). La clé ne sert qu'à cet appel.

        Lève ``WyrloError`` si la clé, la requête ou le modèle sont refusés, ou si le
        service est injoignable : sans réponse rédigée, il n'y a rien à transmettre.
        """
        rid = request_id or str(uuid.uuid4())
        if passages is None:
            if read is None:
                raise WyrloError(0, "invalid_request", "answer() needs `read` or `passages`.")
            found = self.search(
                question, k=k, labels_any=labels_any, keyword_hits=keyword_hits, tenant=tenant
            )
            sent = [p for p in passages_from_search(found.results, read) if p["text"].strip()]
        else:
            sent = _normalize_passages(passages)
        body: Dict[str, Any] = {"question": question, "passages": sent, "request_id": rid}
        if tenant:
            body["tenant"] = tenant
        if language:
            body["language"] = language
        if model:
            body["model"] = {
                key: model[key]
                for key in ("provider", "name", "api_key", "base_url")
                if model.get(key)
            }
        data = self._call_or_raise(
            "POST", "/guard/answer", body, timeout if timeout is not None else ANSWER_TIMEOUT
        )
        return dict(data, request_id=rid)

    def ocr(self, pdf: Union[bytes, str], timeout: Optional[float] = None) -> Dict[str, Any]:
        """Lit un PDF scanné (images sans texte) : ``POST /guard/ocr``, préversion.

        ``pdf`` : les octets du fichier, ou son chemin. 4 Mo au plus. La route est fermée
        par défaut (``WyrloError`` 403, code ``ocr_disabled``). Le fichier part tel quel au
        modèle de lecture (Mistral, point d'accès européen) : une image ne se masque pas.
        WYRLO ne garde ni le fichier ni le texte. Rend ``{"pages": [{"index", "markdown"}],
        "pages_processed", "model"}`` ; indexez ensuite le texte vous-même
        (``wyrlo.documents.blocks_from_markdown``, puis ``index(passages=…)``).
        Lève ``WyrloError`` pour toute erreur, panne comprise.
        """
        if isinstance(pdf, str):
            with open(pdf, "rb") as handle:
                pdf = handle.read()
        data = self._call(
            "POST",
            "/guard/ocr",
            None,
            timeout if timeout is not None else ANSWER_TIMEOUT,
            raw=bytes(pdf),
            content_type="application/pdf",
        )
        if not isinstance(data, dict):
            raise WyrloError(
                0,
                "unavailable",
                "WYRLO unreachable or temporarily overloaded: nothing was read, try again later.",
            )
        return data

    def _call_or_raise(
        self, method: str, path: str, body: Optional[Dict[str, Any]], timeout: float
    ) -> Dict[str, Any]:
        data = self._call(method, path, body, timeout)
        if not isinstance(data, dict):
            raise WyrloError(
                0,
                "unavailable",
                "WYRLO unreachable or temporarily overloaded: nothing was done, "
                "try again later.",
            )
        return data

    def _call(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]],
        timeout: float,
        raw: Optional[bytes] = None,
        content_type: str = "application/json",
    ) -> Optional[Dict[str, Any]]:
        """Appel simple (routes de l'index) : None si WYRLO est injoignable ou en panne.
        ``raw`` : un fichier envoyé tel quel (``content_type``), à la place d'un corps JSON."""
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "X-Wyrlo-Sdk": f"python/{__version__}",
            "X-Wyrlo-Api-Version": API_VERSION,
            # Le texte d'un document est traité à Paris, pas dans la région la plus proche.
            "X-Region": self._region,
            **self._language,
        }
        data = None
        if raw is not None:
            headers["Content-Type"] = content_type
            data = raw
        elif body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self._base_url}{path}", data=data, method=method, headers=headers
        )
        try:
            with _ouvrir(request, timeout) as response:
                out = json.loads(response.read().decode("utf-8"))
                return out if isinstance(out, dict) else None
        except urllib.error.HTTPError as error:
            status = error.code
            # Surchargé, hors de Paris (421) ou en panne : rien n'a été fait.
            if status in (421, 429) or status >= 500 or status < 400:
                return None
            try:
                err = json.loads(error.read().decode("utf-8")).get("error", {})
            except (ValueError, AttributeError):
                err = {}
            raise WyrloError(
                status,
                err.get("code", "invalid_request"),
                err.get("message", f"Request refused ({status})."),
                err.get("details"),
            ) from None
        except (urllib.error.URLError, OSError, ValueError):
            return None

    def _send(self, payload: bytes, timeout: float, path: str = "/guard") -> Any:
        request = urllib.request.Request(
            f"{self._base_url}{path}",
            data=payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "X-Wyrlo-Sdk": f"python/{__version__}",
                "X-Wyrlo-Api-Version": API_VERSION,
                # Traitement du texte en clair à Paris, pas dans la région la plus proche.
                "X-Region": self._region,
                **self._language,
            },
        )
        try:
            with _ouvrir(request, timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
                expected = (
                    "query"
                    if path.endswith("/prepare")
                    else "recorded"
                    if path.endswith("/feedback")
                    else "decision"
                )
                return data if isinstance(data, dict) and expected in data else None
        except urllib.error.HTTPError as error:
            status = error.code
            if status in (429, 503):
                return _OVERLOADED
            # Reçu hors de Paris et refusé sans lecture (421) : comme une panne.
            if status == 421:
                return None
            if 400 <= status < 500:
                try:
                    err = json.loads(error.read().decode("utf-8")).get("error", {})
                except (ValueError, AttributeError):
                    err = {}
                raise WyrloError(
                    status,
                    err.get("code", "invalid_request"),
                    err.get("message", f"Request refused ({status})."),
                    err.get("details"),
                ) from None
            return None
        except (urllib.error.URLError, OSError, ValueError):
            return None

    @staticmethod
    def _result(
        data: Dict[str, Any],
        answer: str,
        request_id: str,
        restore: Callable[[str], str] = _identite,
        local_masking: Optional[LocalMasking] = None,
    ) -> GuardResult:
        # Vraies valeurs remises (règles intégrées) : elles n'ont jamais quitté la machine.
        return GuardResult(
            decision=data["decision"],
            confidence=data.get("confidence", "unverified"),
            confidence_score=data.get("confidence_score"),
            reason=restore(data.get("reason", "")),
            answer=answer,
            request_id=request_id,
            trace_id=data.get("trace_id"),
            # Serveur antérieur au champ ``degraded`` : déduit des étapes sautées et du plafond.
            degraded=bool(
                data.get("degraded")
                or data.get("quota_exceeded")
                or data.get("confidence") == "unverified"
                or data.get("skipped_steps")
            ),
            passages=[
                GuardPassage(
                    p.get("id", ""),
                    bool(p.get("kept")),
                    p.get("rank"),
                    p.get("score"),
                    bool(p.get("injection")),
                    p.get("stale") if isinstance(p.get("stale"), bool) else None,
                )
                for p in data.get("passages", [])
            ],
            unsupported_sentences=[restore(t) for t in data.get("unsupported_sentences", [])],
            injection_detected=bool(data.get("injection_detected")),
            skipped_steps=list(data.get("skipped_steps", [])),
            settings_version=data.get("settings_version"),
            language=data.get("language"),
            rerank_method=data.get("rerank_method", "none"),
            verification_method=data.get("verification_method", "none"),
            latency_ms=int(data.get("latency_ms", 0)),
            quota_exceeded=bool(data.get("quota_exceeded")),
            settings_variant=data.get("settings_variant"),
            local_masking=local_masking,
        )

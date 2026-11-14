"""Intégration LangChain : votre chaîne RAG, vérifiée par WYRLO.

Installation : ``pip install "wyrlo[langchain]"`` (ajoute ``langchain-core``).

Exemple ::

    from wyrlo.langchain import guarded_chain

    rag = guarded_chain(retriever, prompt | llm)
    result = rag.invoke("Quel est le délai de rétractation ?")
    print(result.answer if result.should_answer else "Je ne sais pas.")

``retriever`` est un retriever LangChain (``invoke(question)`` renvoie des
``Document``) ; ``chain`` reçoit ``{"question": …, "context": …}`` (le contexte est le
texte des passages, séparés par une ligne vide) et renvoie une chaîne ou un message.
Le résultat est un :class:`wyrlo.GuardResult`. Comme le SDK, l'intégration ne lève
jamais d'exception pour une panne de WYRLO : la réponse passe alors sans vérification.

Index sans copie (mode B) : :class:`WyrloRetriever` cherche dans l'index de WYRLO et relit
le texte chez vous ; ses documents portent l'adresse du passage, que ``guarded_chain``
transmet à WYRLO (un passage modifié depuis son indexation est signalé « périmé »)::

    retriever = WyrloRetriever(client=Wyrlo(), read=lire_chez_vous, k=8)
    rag = guarded_chain(retriever, prompt | llm)

Vérification de sortie seule, pour une chaîne que vous avez déjà : :func:`output_verifier`
reçoit ``{"question", "answer", "documents"}`` et rend un :class:`wyrlo.GuardResult`.

Moteur de questions (``POST /v1/answer``, préversion) : :func:`answer_chain` cherche avec
votre retriever, fait rédiger par WYRLO (votre modèle ou celui de WYRLO) et rend la réponse
vérifiée, phrase par phrase, avec ses sources ::

    engine = answer_chain(retriever)
    result = engine.invoke("Quel est le délai de rétractation ?")
    print(result["answer"] or "Je ne sais pas.")
"""

from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

from . import GuardResult, Reader, Wyrlo, passages_from_search

try:
    from langchain_core.callbacks import CallbackManagerForRetrieverRun
    from langchain_core.documents import Document
    from langchain_core.retrievers import BaseRetriever
    from langchain_core.runnables import Runnable, RunnableLambda
except ImportError as error:  # pragma: no cover - message d'installation
    raise ImportError(
        'The LangChain integration needs langchain-core: pip install "wyrlo[langchain]"'
    ) from error

__all__ = [
    "WyrloRetriever",
    "answer_chain",
    "guarded_chain",
    "output_verifier",
    "passages_from_documents",
]


def passages_from_documents(documents: Sequence[Document]) -> List[Dict[str, Any]]:
    """Passages WYRLO à partir de documents LangChain (identifiant, texte, source, score)."""
    out: List[Dict[str, Any]] = []
    for index, doc in enumerate(documents):
        metadata = doc.metadata or {}
        passage: Dict[str, Any] = {
            "id": str(doc.id or metadata.get("id") or f"p{index + 1}"),
            "text": doc.page_content,
        }
        source = metadata.get("source")
        if source is not None:
            passage["source"] = str(source)
        score = metadata.get("score")
        if isinstance(score, (int, float)):
            passage["score"] = float(score)
        address = metadata.get("address")
        if isinstance(address, Mapping):
            passage["address"] = dict(address)
        out.append(passage)
    return out


class WyrloRetriever(BaseRetriever):
    """Retriever LangChain sur l'index sans copie de WYRLO (``search``).

    ``read(document, version, start, length)`` relit le texte chez vous (``None`` si le
    document n'existe plus). Une panne de WYRLO rend une liste vide, jamais une exception.
    ``tenant`` : espace du client final (mode C) où chercher ; absent, l'espace par défaut.
    """

    client: Any
    read: Any
    k: Optional[int] = None
    labels_any: Optional[List[str]] = None
    tenant: Optional[str] = None

    def _get_relevant_documents(
        self, query: str, *, run_manager: CallbackManagerForRetrieverRun
    ) -> List[Document]:
        reader: Reader = self.read
        found = self.client.search(
            query, k=self.k, labels_any=self.labels_any, tenant=self.tenant
        )
        return [
            Document(
                id=p["id"],
                page_content=p["text"],
                metadata={
                    "id": p["id"],
                    "source": p["source"],
                    "score": p.get("score"),
                    "address": p["address"],
                },
            )
            for p in passages_from_search(found.results, reader)
        ]


def _text(output: Any) -> str:
    """Texte d'une sortie de chaîne : chaîne, message (``content``) ou autre."""
    if isinstance(output, str):
        return output
    content = getattr(output, "content", None)
    if isinstance(content, str):
        return content
    return str(output)


def guarded_chain(
    retriever: Any,
    chain: Any,
    wyrlo: Optional[Wyrlo] = None,
    question_key: str = "question",
    context_key: str = "context",
    language: Optional[str] = None,
) -> Runnable:
    """Runnable LangChain : recherche, génération, puis vérification par WYRLO.

    L'entrée est la question (chaîne) ou un dictionnaire qui la contient sous
    ``question_key``. La chaîne n'est appelée qu'une fois, avec les passages retrouvés.
    """
    client = wyrlo or Wyrlo()

    def run(value: Union[str, Mapping[str, Any]]) -> GuardResult:
        question = value if isinstance(value, str) else str(value[question_key])
        passages = passages_from_documents(retriever.invoke(question))

        def generate(items: List[Dict[str, Any]]) -> str:
            context = "\n\n".join(item["text"] for item in items)
            return _text(chain.invoke({question_key: question, context_key: context}))

        return client.guard(
            question=question, passages=passages, generate=generate, language=language
        )

    return RunnableLambda(run, name="wyrlo_guarded_chain")


def output_verifier(
    wyrlo: Optional[Wyrlo] = None,
    question_key: str = "question",
    answer_key: str = "answer",
    documents_key: str = "documents",
    language: Optional[str] = None,
    tenant: Optional[str] = None,
) -> Runnable:
    """Runnable LangChain : vérifie une réponse déjà rédigée par votre chaîne.

    L'entrée est un dictionnaire : la question, la réponse (chaîne ou message) et les
    documents LangChain qui ont servi à la rédiger. Le résultat est un
    :class:`wyrlo.GuardResult` ; une panne de WYRLO laisse passer la réponse, marquée
    « non vérifiée », sans exception.
    """
    client = wyrlo or Wyrlo()

    def run(value: Mapping[str, Any]) -> GuardResult:
        return client.guard(
            question=str(value[question_key]),
            passages=passages_from_documents(value.get(documents_key) or []),
            answer=_text(value[answer_key]),
            language=language,
            tenant=tenant,
        )

    return RunnableLambda(run, name="wyrlo_output_verifier")


def answer_chain(
    retriever: Any,
    wyrlo: Optional[Wyrlo] = None,
    model: Optional[Mapping[str, Any]] = None,
    question_key: str = "question",
    language: Optional[str] = None,
    tenant: Optional[str] = None,
) -> Runnable:
    """Runnable LangChain : recherche, puis réponse rédigée et vérifiée par WYRLO.

    Préversion (``POST /v1/answer``). ``model`` : votre modèle
    (``{"provider": "openai", "name": "...", "api_key": "..."}``) ; absent, le modèle
    enregistré pour le projet, sinon celui géré par WYRLO. Le résultat est le dictionnaire
    de :meth:`wyrlo.Wyrlo.answer` : ``decision``, ``answer``, ``sentences`` (texte,
    confiance, sources), ``leads``. Lève ``WyrloError`` si rien n'a pu être rédigé.
    """
    client = wyrlo or Wyrlo()

    def run(value: Union[str, Mapping[str, Any]]) -> Dict[str, Any]:
        question = value if isinstance(value, str) else str(value[question_key])
        return client.answer(
            question,
            passages=passages_from_documents(retriever.invoke(question)),
            model=model,
            language=language,
            tenant=tenant,
        )

    return RunnableLambda(run, name="wyrlo_answer_chain")

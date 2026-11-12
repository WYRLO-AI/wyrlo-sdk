"""Intégration LlamaIndex : votre moteur de questions, vérifié par WYRLO.

Installation : ``pip install "wyrlo[llamaindex]"`` (ajoute ``llama-index-core``).

Exemple ::

    from wyrlo.llamaindex import GuardedQueryEngine

    engine = GuardedQueryEngine(index.as_retriever(similarity_top_k=5), llm)
    result = engine.query("Quel est le délai de rétractation ?")
    print(result.answer if result.should_answer else "Je ne sais pas.")

``retriever`` est un retriever LlamaIndex (``retrieve(question)`` renvoie des
``NodeWithScore``) ; ``llm`` est un LLM LlamaIndex (``complete(prompt)``). Le prompt
par défaut demande de répondre uniquement à partir des passages ; vous pouvez donner le
vôtre (``prompt``, avec ``{context}`` et ``{question}``). Le résultat est un
:class:`wyrlo.GuardResult`. Comme le SDK, l'intégration ne lève jamais d'exception pour
une panne de WYRLO : la réponse passe alors sans vérification.

Index sans copie (mode B) : :class:`WyrloRetriever` cherche dans l'index de WYRLO et relit
le texte chez vous ; ses nœuds portent l'adresse du passage, que ``GuardedQueryEngine``
transmet à WYRLO (un passage modifié depuis son indexation est signalé « périmé »)::

    engine = GuardedQueryEngine(WyrloRetriever(Wyrlo(), lire_chez_vous, k=8), llm)
"""

from typing import Any, Dict, List, Optional, Sequence

from . import GuardResult, Reader, Wyrlo, passages_from_search

try:
    from llama_index.core.base.base_retriever import BaseRetriever
    from llama_index.core.schema import NodeWithScore, QueryBundle, TextNode
except ImportError as error:  # pragma: no cover - message d'installation
    raise ImportError(
        'L\'intégration LlamaIndex demande llama-index-core : pip install "wyrlo[llamaindex]"'
    ) from error

__all__ = ["DEFAULT_PROMPT", "GuardedQueryEngine", "WyrloRetriever", "passages_from_nodes"]

DEFAULT_PROMPT = (
    "Réponds uniquement à partir des passages ci-dessous. Si la réponse n'y figure pas, "
    "dis que tu ne sais pas.\n\nPassages :\n{context}\n\nQuestion : {question}\nRéponse :"
)


def passages_from_nodes(nodes: Sequence[NodeWithScore]) -> List[Dict[str, Any]]:
    """Passages WYRLO à partir de nœuds LlamaIndex (identifiant, texte, source, score)."""
    out: List[Dict[str, Any]] = []
    for item in nodes:
        node = item.node
        passage: Dict[str, Any] = {"id": str(node.node_id), "text": node.get_content()}
        metadata = getattr(node, "metadata", None) or {}
        source = metadata.get("file_name") or metadata.get("source")
        if source is not None:
            passage["source"] = str(source)
        if isinstance(item.score, (int, float)):
            passage["score"] = float(item.score)
        address = metadata.get("address")
        if isinstance(address, dict):
            passage["address"] = dict(address)
        out.append(passage)
    return out


class WyrloRetriever(BaseRetriever):
    """Retriever LlamaIndex sur l'index sans copie de WYRLO (``search``).

    ``read(document, version, start, length)`` relit le texte chez vous (``None`` si le
    document n'existe plus). Une panne de WYRLO rend une liste vide, jamais une exception.
    ``tenant`` : espace du client final (mode C) où chercher ; absent, l'espace par défaut.
    """

    def __init__(
        self,
        client: Wyrlo,
        read: Reader,
        k: Optional[int] = None,
        labels_any: Optional[List[str]] = None,
        tenant: Optional[str] = None,
    ) -> None:
        super().__init__()
        self._client = client
        self._read = read
        self._k = k
        self._labels_any = labels_any
        self._tenant = tenant

    def _retrieve(self, query_bundle: QueryBundle) -> List[NodeWithScore]:
        found = self._client.search(
            query_bundle.query_str, k=self._k, labels_any=self._labels_any, tenant=self._tenant
        )
        return [
            NodeWithScore(
                node=TextNode(
                    id_=p["id"],
                    text=p["text"],
                    metadata={"source": p["source"], "address": p["address"]},
                    # L'adresse reste hors du texte vu par le LLM et par les vecteurs.
                    excluded_llm_metadata_keys=["address"],
                    excluded_embed_metadata_keys=["address"],
                ),
                score=p.get("score"),
            )
            for p in passages_from_search(found.results, self._read)
        ]


class GuardedQueryEngine:
    """Recherche, génération, puis vérification par WYRLO, en un appel à ``query``."""

    def __init__(
        self,
        retriever: Any,
        llm: Any,
        wyrlo: Optional[Wyrlo] = None,
        prompt: str = DEFAULT_PROMPT,
        language: Optional[str] = None,
    ) -> None:
        self._retriever = retriever
        self._llm = llm
        self._wyrlo = wyrlo or Wyrlo()
        self._prompt = prompt
        self._language = language

    def query(self, question: str) -> GuardResult:
        passages = passages_from_nodes(self._retriever.retrieve(question))

        def generate(items: List[Dict[str, Any]]) -> str:
            context = "\n\n".join(item["text"] for item in items)
            prompt = self._prompt.format(context=context, question=question)
            return str(self._llm.complete(prompt).text)

        return self._wyrlo.guard(
            question=question, passages=passages, generate=generate, language=self._language
        )

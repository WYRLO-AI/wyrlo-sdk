"""Tests des intégrations LangChain et LlamaIndex, avec les vraies bibliothèques
(langchain-core, llama-index-core), un faux LLM et un faux serveur WYRLO local.
Données fictives uniquement.

Sans ces bibliothèques, les tests sont sautés ; scripts/deploy.sh les lance dans un
environnement où elles sont installées (versions de requirements-integrations.txt).
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from test_wyrlo import KEY, OK, FakeApi  # noqa: E402
from wyrlo import Wyrlo  # noqa: E402

try:
    import langchain_core  # noqa: F401

    HAS_LANGCHAIN = True
except ImportError:
    HAS_LANGCHAIN = False

try:
    import llama_index.core  # noqa: F401

    HAS_LLAMAINDEX = True
except ImportError:
    HAS_LLAMAINDEX = False

REQUIRED = os.environ.get("WYRLO_REQUIRE_INTEGRATIONS") == "1"
PASSAGES = [
    ("cgv-11", "Le délai de rétractation est de 14 jours après la livraison.", "CGV.pdf"),
    ("faq-2", "La livraison est offerte dès 50 euros.", "FAQ.md"),
]
FINAL = {
    "trace_id": "t1", "decision": "answer", "confidence": "probable",
    "answer": "Le délai est de 14 jours.",
    "sentences": [{"text": "Le délai est de 14 jours.", "confidence": "probable",
                   "sources": ["cgv-11"], "supported": True}],
    "leads": [], "reason": "ok", "model": {"provider": "wyrlo", "name": "petit"},
    "usage": {"input_tokens": 90, "output_tokens": 10}, "degraded": False,
}
ABSTAIN = {**OK, "decision": "abstain", "confidence": "uncertain", "confidence_score": 0.1}


class _Base(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi()

    def tearDown(self):
        self.api.close()

    def client(self):
        return Wyrlo(api_key=KEY, base_url=self.api.url + "/")


@unittest.skipUnless(HAS_LANGCHAIN or REQUIRED, "langchain-core non installé")
class LangChainTests(_Base):
    def build(self, answer="Le délai est de 14 jours."):
        from langchain_core.callbacks import CallbackManagerForRetrieverRun
        from langchain_core.documents import Document
        from langchain_core.language_models import FakeListLLM
        from langchain_core.prompts import PromptTemplate
        from langchain_core.retrievers import BaseRetriever

        from wyrlo.langchain import guarded_chain

        class Retriever(BaseRetriever):
            def _get_relevant_documents(
                self, query: str, *, run_manager: CallbackManagerForRetrieverRun
            ):
                return [
                    Document(id=i, page_content=t, metadata={"source": s})
                    for i, t, s in PASSAGES
                ]

        self.llm = FakeListLLM(responses=[answer])
        self.retriever = Retriever()
        prompt = PromptTemplate.from_template("Passages : {context}\nQuestion : {question}")
        return guarded_chain(self.retriever, prompt | self.llm, wyrlo=self.client())

    def test_chaine_verifiee_passages_et_reponse_envoyes(self):
        self.api.responses = [(200, OK, 0)]
        result = self.build().invoke("Quel est le délai de rétractation ?")
        self.assertTrue(result.should_answer)
        self.assertEqual(result.answer, "Le délai est de 14 jours.")
        body = self.api.calls[0]["body"]
        self.assertEqual(body["question"], "Quel est le délai de rétractation ?")
        self.assertEqual(body["answer"], "Le délai est de 14 jours.")
        self.assertEqual(
            body["passages"],
            [{"id": i, "text": t, "source": s} for i, t, s in PASSAGES],
        )

    def test_entree_dictionnaire_et_refus(self):
        self.api.responses = [(200, ABSTAIN, 0)]
        result = self.build().invoke({"question": "Question hors sujet ?"})
        self.assertFalse(result.should_answer)
        self.assertEqual(self.api.calls[0]["body"]["question"], "Question hors sujet ?")

    def test_verification_de_sortie_seule(self):
        from langchain_core.documents import Document
        from langchain_core.messages import AIMessage

        from wyrlo.langchain import output_verifier

        self.api.responses = [(200, OK, 0)]
        documents = [Document(id=i, page_content=t, metadata={"source": s}) for i, t, s in PASSAGES]
        result = output_verifier(wyrlo=self.client(), tenant="client-1").invoke(
            {
                "question": "Quel est le délai ?",
                "answer": AIMessage(content="Le délai est de 14 jours."),
                "documents": documents,
            }
        )
        self.assertTrue(result.should_answer)
        body = self.api.calls[0]["body"]
        self.assertEqual(body["answer"], "Le délai est de 14 jours.")
        self.assertEqual(body["tenant"], "client-1")
        self.assertEqual([p["id"] for p in body["passages"]], ["cgv-11", "faq-2"])

    def test_moteur_de_questions_answer(self):
        from wyrlo.langchain import answer_chain

        self.build()
        retriever = self.retriever
        self.api.responses = [(200, FINAL, 0)]
        model = {"provider": "openai", "name": "modele-fictif", "api_key": "cle-fictive"}
        out = answer_chain(retriever, wyrlo=self.client(), model=model).invoke(
            {"question": "Quel est le délai ?"}
        )
        self.assertEqual(out["sentences"][0]["sources"], ["cgv-11"])
        call = self.api.calls[0]
        self.assertTrue(call["path"].endswith("/answer"))
        self.assertEqual(call["body"]["model"], model)
        self.assertEqual([p["id"] for p in call["body"]["passages"]], ["cgv-11", "faq-2"])
        self.assertNotIn("answer", call["body"])

    def test_panne_de_wyrlo_reponse_transmise_sans_exception(self):
        self.api.close()
        result = self.build().invoke("Quel est le délai de rétractation ?")
        self.assertTrue(result.degraded)
        self.assertEqual(result.answer, "Le délai est de 14 jours.")
        # Réouvert pour tearDown.
        self.api = FakeApi()


@unittest.skipUnless(HAS_LLAMAINDEX or REQUIRED, "llama-index-core non installé")
class LlamaIndexTests(_Base):
    def build(self, answer="Le délai est de 14 jours."):
        from llama_index.core.base.base_retriever import BaseRetriever
        from llama_index.core.llms.mock import MockLLM
        from llama_index.core.schema import NodeWithScore, TextNode

        from wyrlo.llamaindex import GuardedQueryEngine

        class Retriever(BaseRetriever):
            def _retrieve(self, query_bundle):
                return [
                    NodeWithScore(
                        node=TextNode(id_=i, text=t, metadata={"file_name": s}),
                        score=0.9 - n * 0.1,
                    )
                    for n, (i, t, s) in enumerate(PASSAGES)
                ]

        class Llm(MockLLM):
            def complete(self, prompt, formatted=False, **kwargs):
                seen.append(prompt)
                return super().complete(prompt, formatted=formatted, **kwargs).model_copy(
                    update={"text": answer}
                )

        seen = []
        self.prompts = seen
        self.retriever = Retriever()
        return GuardedQueryEngine(self.retriever, Llm(), wyrlo=self.client())

    def test_moteur_verifie_passages_scores_et_prompt(self):
        self.api.responses = [(200, OK, 0)]
        result = self.build().query("Quel est le délai de rétractation ?")
        self.assertTrue(result.should_answer)
        body = self.api.calls[0]["body"]
        self.assertEqual(body["answer"], "Le délai est de 14 jours.")
        self.assertEqual([p["id"] for p in body["passages"]], ["cgv-11", "faq-2"])
        self.assertEqual(body["passages"][0]["source"], "CGV.pdf")
        self.assertAlmostEqual(body["passages"][0]["score"], 0.9)
        # Le prompt contient les passages et la question.
        self.assertIn("14 jours après la livraison", self.prompts[0])
        self.assertIn("Quel est le délai de rétractation ?", self.prompts[0])

    def test_refus(self):
        self.api.responses = [(200, ABSTAIN, 0)]
        self.assertFalse(self.build().query("Question hors sujet ?").should_answer)

    def test_verification_de_sortie_seule(self):
        from llama_index.core.base.response.schema import Response

        from wyrlo.llamaindex import verify_response

        self.build()
        nodes = self.retriever.retrieve("Quel est le délai ?")
        self.api.responses = [(200, OK, 0)]
        result = verify_response(
            "Quel est le délai ?",
            Response(response="Le délai est de 14 jours.", source_nodes=nodes),
            wyrlo=self.client(),
        )
        self.assertTrue(result.should_answer)
        body = self.api.calls[0]["body"]
        self.assertEqual(body["answer"], "Le délai est de 14 jours.")
        self.assertEqual([p["id"] for p in body["passages"]], ["cgv-11", "faq-2"])

    def test_moteur_de_questions_answer(self):
        from wyrlo.llamaindex import AnswerQueryEngine

        self.build()
        self.api.responses = [(200, FINAL, 0)]
        out = AnswerQueryEngine(self.retriever, wyrlo=self.client(), tenant="client-1").query(
            "Quel est le délai ?"
        )
        self.assertEqual(out["answer"], "Le délai est de 14 jours.")
        call = self.api.calls[0]
        self.assertTrue(call["path"].endswith("/answer"))
        self.assertEqual(call["body"]["tenant"], "client-1")
        self.assertNotIn("model", call["body"])
        self.assertEqual([p["id"] for p in call["body"]["passages"]], ["cgv-11", "faq-2"])


FP = "a" * 64
DOC = "Préambule. Le délai de rétractation est de 14 jours après la livraison."
SEARCH = {
    "results": [
        {"document": "cgv", "version": "v1", "start": 11, "length": 60,
         "fingerprint": FP, "index": 1, "labels": [], "score": 0.8},
        {"document": "efface", "version": "v1", "start": 0, "length": 5,
         "fingerprint": FP, "index": 0, "labels": [], "score": 0.4},
    ]
}
ADDRESS = {"document": "cgv", "version": "v1", "start": 11, "length": 60, "fingerprint": FP}


def read(document, version, start, length):
    return DOC[start : start + length] if document == "cgv" else None


@unittest.skipUnless(HAS_LANGCHAIN or REQUIRED, "langchain-core non installé")
class LangChainIndexTests(_Base):
    def test_retriever_mode_b_puis_guard_avec_l_adresse(self):
        from langchain_core.language_models import FakeListLLM
        from langchain_core.prompts import PromptTemplate

        from wyrlo.langchain import WyrloRetriever, guarded_chain

        self.api.responses = [(200, SEARCH, 0), (200, OK, 0)]
        client = self.client()
        retriever = WyrloRetriever(client=client, read=read, k=3)
        prompt = PromptTemplate.from_template("Passages : {context}\nQuestion : {question}")
        rag = guarded_chain(retriever, prompt | FakeListLLM(responses=["14 jours."]), wyrlo=client)
        result = rag.invoke("Quel est le délai ?")
        self.assertTrue(result.should_answer)
        self.assertEqual(self.api.calls[0]["path"], "/v1/guard/search")
        self.assertEqual(self.api.calls[0]["body"]["k"], 3)
        self.assertEqual(
            self.api.calls[1]["body"]["passages"],
            [{"id": "cgv#11", "text": DOC[11:71], "source": "cgv", "score": 0.8,
              "address": ADDRESS}],
        )

    def test_retriever_mode_c_espace_transmis(self):
        from wyrlo.langchain import WyrloRetriever

        self.api.responses = [(200, SEARCH, 0)]
        WyrloRetriever(client=self.client(), read=read, tenant="client-42").invoke("Q ?")
        self.assertEqual(self.api.calls[0]["body"]["tenant"], "client-42")

    def test_retriever_panne_liste_vide(self):
        from wyrlo.langchain import WyrloRetriever

        self.api.responses = [(503, {}, 0)]
        self.assertEqual(WyrloRetriever(client=self.client(), read=read).invoke("Q ?"), [])


@unittest.skipUnless(HAS_LLAMAINDEX or REQUIRED, "llama-index-core non installé")
class LlamaIndexIndexTests(_Base):
    def test_retriever_mode_b_puis_guard_avec_l_adresse(self):
        from llama_index.core.llms.mock import MockLLM

        from wyrlo.llamaindex import GuardedQueryEngine, WyrloRetriever

        self.api.responses = [(200, SEARCH, 0), (200, OK, 0)]
        client = self.client()
        prompts = []

        class Llm(MockLLM):
            def complete(self, prompt, formatted=False, **kwargs):
                prompts.append(prompt)
                return super().complete(prompt, formatted=formatted, **kwargs).model_copy(
                    update={"text": "14 jours."}
                )

        engine = GuardedQueryEngine(WyrloRetriever(client, read, k=3), Llm(), wyrlo=client)
        self.assertTrue(engine.query("Quel est le délai ?").should_answer)
        sent = self.api.calls[1]["body"]["passages"]
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["address"], ADDRESS)
        self.assertEqual(sent[0]["text"], DOC[11:71])
        self.assertAlmostEqual(sent[0]["score"], 0.8)
        self.assertNotIn("fingerprint", prompts[0])

    def test_retriever_mode_c_espace_transmis(self):
        from wyrlo.llamaindex import WyrloRetriever

        self.api.responses = [(200, SEARCH, 0)]
        WyrloRetriever(self.client(), read, tenant="client-42").retrieve("Q ?")
        self.assertEqual(self.api.calls[0]["body"]["tenant"], "client-42")


if __name__ == "__main__":
    unittest.main()

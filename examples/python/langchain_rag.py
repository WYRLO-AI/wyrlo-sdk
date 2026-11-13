"""A LangChain RAG chain whose answers are checked by WYRLO.

Run: pip install "wyrlo[langchain]" && WYRLO_API_KEY=wyr_live_… python langchain_rag.py
The fake embeddings and LLM below make the file run anywhere: use your own.
"""

from langchain_core.documents import Document
from langchain_core.embeddings import DeterministicFakeEmbedding
from langchain_core.language_models import FakeListLLM
from langchain_core.prompts import PromptTemplate
from langchain_core.vectorstores import InMemoryVectorStore

from wyrlo.langchain import guarded_chain

store = InMemoryVectorStore(DeterministicFakeEmbedding(size=256))
store.add_documents(
    [
        Document(
            id="refunds-2",
            page_content="Customers can ask for a refund within 30 days of delivery.",
            metadata={"source": "Refund policy.pdf"},
        ),
        Document(
            id="shipping-1",
            page_content="Orders ship within 2 working days.",
            metadata={"source": "Shipping terms.pdf"},
        ),
    ]
)
retriever = store.as_retriever(search_kwargs={"k": 2})

prompt = PromptTemplate.from_template(
    "Answer from the context only.\n\nContext:\n{context}\n\nQuestion: {question}"
)
llm = FakeListLLM(responses=["Customers have 30 days after delivery to ask for a refund."])

# The chain retrieves, generates, then has WYRLO verify the answer.
rag = guarded_chain(retriever, prompt | llm, language="en")
res = rag.invoke("How long do customers have to ask for a refund?")

print(res.answer if res.should_answer else "I don't know.")
print("confidence:", res.confidence, "| sources:", [p.id for p in res.kept_passages])

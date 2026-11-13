"""A LlamaIndex query engine whose answers are checked by WYRLO.

Run: pip install "wyrlo[llamaindex]" && WYRLO_API_KEY=wyr_live_… python llamaindex_rag.py
The mock embeddings and LLM below make the file run anywhere (MockLLM only repeats
placeholder text): use your own.
"""

from llama_index.core import Document, Settings, VectorStoreIndex
from llama_index.core.embeddings import MockEmbedding
from llama_index.core.llms import MockLLM

from wyrlo.llamaindex import GuardedQueryEngine

Settings.embed_model = MockEmbedding(embed_dim=256)
llm = MockLLM(max_tokens=32)

index = VectorStoreIndex.from_documents(
    [
        Document(
            id_="refunds-2",
            text="Customers can ask for a refund within 30 days of delivery.",
            metadata={"file_name": "Refund policy.pdf"},
        ),
        Document(
            id_="shipping-1",
            text="Orders ship within 2 working days.",
            metadata={"file_name": "Shipping terms.pdf"},
        ),
    ]
)

# Retrieve, generate, then have WYRLO verify the answer.
engine = GuardedQueryEngine(index.as_retriever(similarity_top_k=2), llm, language="en")
res = engine.query("How long do customers have to ask for a refund?")

print(res.answer if res.should_answer else "I don't know.")
print("confidence:", res.confidence, "| sources:", [p.id for p in res.kept_passages])

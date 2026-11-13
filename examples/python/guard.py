"""Check two answers with WYRLO: one the passages support, one they don't.

Run: WYRLO_API_KEY=wyr_live_… python guard.py
"""

from wyrlo import Wyrlo

wyrlo = Wyrlo()  # reads WYRLO_API_KEY

# What your retrieval found (fictitious company).
passages = [
    {
        "id": "refunds-2",
        "text": "Customers can ask for a refund within 30 days of delivery, with the order number.",
        "source": "Refund policy.pdf",
    },
    {
        "id": "shipping-1",
        "text": "Orders ship within 2 working days. Delivery takes 3 to 5 working days in France.",
        "source": "Shipping terms.pdf",
    },
]


def check(question: str, answer: str) -> None:
    res = wyrlo.guard(question=question, passages=passages, answer=answer, language="en")
    print(f"\nQ: {question}\nLLM: {answer}")
    if not res.should_answer:
        print(f"→ I don't know. ({res.confidence})")
        print("  Unsupported:", res.unsupported_sentences)
    else:
        cited = ", ".join(p.id for p in res.kept_passages)
        print(f"→ {res.answer} ({res.confidence}, sources: {cited})")


# Supported by the "refunds-2" passage.
check("How long do customers have to ask for a refund?", "Customers have 30 days after delivery.")
# Nothing in the passages talks about gift cards: the answer is invented.
check("Can I pay with a gift card?", "Yes, all gift cards are accepted at checkout.")

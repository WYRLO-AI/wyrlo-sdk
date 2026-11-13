// Check two answers with WYRLO: one the passages support, one they don't.
// Run: WYRLO_API_KEY=wyr_live_… npx tsx guard.ts
import { Wyrlo } from "@wyrlo/sdk";

const wyrlo = new Wyrlo(); // reads WYRLO_API_KEY

// What your retrieval found (fictitious company).
const passages = [
  {
    id: "refunds-2",
    text: "Customers can ask for a refund within 30 days of delivery, with the order number.",
    source: "Refund policy.pdf",
  },
  {
    id: "shipping-1",
    text: "Orders ship within 2 working days. Delivery takes 3 to 5 working days in France.",
    source: "Shipping terms.pdf",
  },
];

async function check(question: string, answer: string) {
  const res = await wyrlo.guard({ question, passages, answer, language: "en" });
  console.log(`\nQ: ${question}\nLLM: ${answer}`);
  if (res.decision === "abstain") {
    console.log(`→ I don't know. (${res.confidence})`);
    console.log("  Unsupported:", res.unsupported_sentences);
  } else {
    const cited = res.passages.filter((p) => p.kept).map((p) => p.id);
    console.log(`→ ${res.answer} (${res.confidence}, sources: ${cited.join(", ")})`);
  }
}

async function main() {
  // Supported by the "refunds-2" passage.
  await check("How long do customers have to ask for a refund?", "Customers have 30 days after delivery.");
  // Nothing in the passages talks about gift cards: the answer is invented.
  await check("Can I pay with a gift card?", "Yes, all gift cards are accepted at checkout.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// Exemple : vérifier une réponse, puis demander une réponse citée et vérifiée.
// WYRLO_API_KEY=wyr_test_… go run ./example
package main

import (
	"context"
	"fmt"
	"os"

	wyrlo "github.com/WYRLO-AI/wyrlo-sdk/go"
)

func main() {
	client := wyrlo.New(os.Getenv("WYRLO_API_KEY"))
	if base := os.Getenv("WYRLO_BASE_URL"); base != "" {
		client.BaseURL = base
	}
	ctx := context.Background()
	passages := []map[string]any{
		{"id": "cgv#1", "text": "Le délai de rétractation est de 14 jours après la livraison.", "source": "cgv.md"},
	}

	// 1. Votre RAG a rédigé une réponse : WYRLO la vérifie contre les passages.
	checked, err := client.Guard(ctx, map[string]any{
		"question": "Quel est le délai de rétractation ?",
		"answer":   "Vous avez 14 jours après la livraison.",
		"passages": passages,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("guard:", checked["decision"], checked["confidence"])

	// 2. Ou WYRLO fait rédiger la réponse, puis la vérifie (préversion).
	answered, err := client.Answer(ctx, map[string]any{
		"question": "Quel est le délai de rétractation ?",
		"passages": passages,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if answered["decision"] == "answer" {
		fmt.Println("answer:", answered["answer"])
	} else {
		fmt.Println("answer: je ne sais pas")
	}
}

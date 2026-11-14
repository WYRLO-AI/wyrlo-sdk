// Exemple : vérifier une réponse, puis demander une réponse citée et vérifiée.
// WYRLO_API_KEY=wyr_test_… dotnet run --project Example
using System;
using Wyrlo;

var baseUrl = Environment.GetEnvironmentVariable("WYRLO_BASE_URL");
var client = new WyrloClient(
    Environment.GetEnvironmentVariable("WYRLO_API_KEY") ?? "",
    string.IsNullOrEmpty(baseUrl) ? WyrloClient.DefaultBaseUrl : baseUrl);
var passages = new[]
{
    new { id = "cgv#1", text = "Le délai de rétractation est de 14 jours après la livraison.", source = "cgv.md" },
};

try
{
    // 1. Votre RAG a rédigé une réponse : WYRLO la vérifie contre les passages.
    var check = await client.GuardAsync(new
    {
        question = "Quel est le délai de rétractation ?",
        answer = "Vous avez 14 jours après la livraison.",
        passages,
    });
    Console.WriteLine($"guard: {check?["decision"]} {check?["confidence"]}");

    // 2. Ou WYRLO fait rédiger la réponse, puis la vérifie (préversion).
    var answered = await client.AnswerAsync(new { question = "Quel est le délai de rétractation ?", passages });
    Console.WriteLine(answered?["decision"]?.GetValue<string>() == "answer"
        ? $"answer: {answered?["answer"]}"
        : "answer: je ne sais pas");
}
catch (WyrloException error)
{
    Console.Error.WriteLine(error.Message);
    Environment.Exit(1);
}

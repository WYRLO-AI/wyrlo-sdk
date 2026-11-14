<?php
// Exemple : vérifier une réponse, puis demander une réponse citée et vérifiée.
// WYRLO_API_KEY=wyr_test_… php example.php

declare(strict_types=1);

require __DIR__ . '/src/Client.php';

$client = new Wyrlo\Client(
    (string) getenv('WYRLO_API_KEY'),
    getenv('WYRLO_BASE_URL') ?: Wyrlo\Client::DEFAULT_BASE_URL,
);
$passages = [
    ['id' => 'cgv#1', 'text' => 'Le délai de rétractation est de 14 jours après la livraison.', 'source' => 'cgv.md'],
];

try {
    // 1. Votre RAG a rédigé une réponse : WYRLO la vérifie contre les passages.
    $checked = $client->guard([
        'question' => 'Quel est le délai de rétractation ?',
        'answer' => 'Vous avez 14 jours après la livraison.',
        'passages' => $passages,
    ]);
    echo 'guard: ', $checked['decision'], ' ', $checked['confidence'], PHP_EOL;

    // 2. Ou WYRLO fait rédiger la réponse, puis la vérifie (préversion).
    $answered = $client->answer([
        'question' => 'Quel est le délai de rétractation ?',
        'passages' => $passages,
    ]);
    echo 'answer: ', $answered['decision'] === 'answer' ? $answered['answer'] : 'je ne sais pas', PHP_EOL;
} catch (Wyrlo\ApiException $error) {
    fwrite(STDERR, $error->getMessage() . PHP_EOL);
    exit(1);
}

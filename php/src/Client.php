<?php
// Code généré depuis la spécification OpenAPI https://api.wyrlo.io/openapi.json
// (API WYRLO, contrat 2026-09-25). Ne pas modifier à la main.
// Préversion 0.1.0-preview : l'interface peut encore changer.

declare(strict_types=1);

namespace Wyrlo;

/** Réponse d'erreur de l'API : { "error": { "code", "message" } }, ou panne réseau (statut 0). */
final class ApiException extends \RuntimeException
{
    public function __construct(
        public readonly int $status,
        public readonly string $errorCode,
        string $message,
        public readonly string $body = '',
    ) {
        parent::__construct("wyrlo: {$status} {$errorCode}: {$message}", $status);
    }
}

/**
 * Appelle l'API WYRLO : vérifier une réponse de RAG contre ses sources, chercher dans
 * l'index sans copie, obtenir une réponse citée et vérifiée. Extension requise : curl.
 */
final class Client
{
    public const VERSION = '0.1.0-preview';
    public const DEFAULT_BASE_URL = 'https://api.wyrlo.io/functions/v1';
    /** Délai de la rédaction (answer), plus long que les autres appels, en secondes. */
    public const ANSWER_TIMEOUT = 60;

    public function __construct(
        private readonly string $apiKey,
        private readonly string $baseUrl = self::DEFAULT_BASE_URL,
        private readonly int $timeout = 30,
    ) {
    }

    private function call(string $method, string $path, array $query, ?array $body, int $timeout): array
    {
        $query = array_filter($query, static fn ($value) => $value !== null && $value !== '');
        $url = $this->baseUrl . $path . ($query ? '?' . http_build_query($query) : '');
        $headers = [
            'Authorization: Bearer ' . $this->apiKey,
            'x-region: eu-west-3',
            'User-Agent: wyrlo-php/' . self::VERSION,
        ];
        $handle = curl_init($url);
        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
        ]);
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
            curl_setopt($handle, CURLOPT_POSTFIELDS, json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        }
        curl_setopt($handle, CURLOPT_HTTPHEADER, $headers);
        $raw = curl_exec($handle);
        if ($raw === false) {
            $reason = curl_error($handle);
            curl_close($handle);
            throw new ApiException(0, 'network_error', $reason);
        }
        $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        curl_close($handle);
        $decoded = json_decode((string) $raw, true);
        $decoded = is_array($decoded) ? $decoded : [];
        if ($status >= 400) {
            $error = is_array($decoded['error'] ?? null) ? $decoded['error'] : [];
            throw new ApiException($status, (string) ($error['code'] ?? 'unknown'), (string) ($error['message'] ?? ''), (string) $raw);
        }
        return $decoded;
    }

    /** Vérifier une réponse (POST /guard). */
    public function guard(array $body): array
    {
        return $this->call('POST', '/guard', [], $body, $this->timeout);
    }

    /** Préparer la recherche (POST /guard/prepare). */
    public function prepare(array $body): array
    {
        return $this->call('POST', '/guard/prepare', [], $body, $this->timeout);
    }

    /** Pouce de l'utilisateur final (POST /guard/feedback). */
    public function feedback(array $body): array
    {
        return $this->call('POST', '/guard/feedback', [], $body, $this->timeout);
    }

    /** Vérifier le branchement (GET /guard/health). */
    public function health(): array
    {
        return $this->call('GET', '/guard/health', [], null, $this->timeout);
    }

    /** Indexer un lot de documents (100 au plus) en un appel (POST /guard/index/documents). */
    public function indexDocuments(array $body): array
    {
        return $this->call('POST', '/guard/index/documents', [], $body, $this->timeout);
    }

    /** Ajouter ou remplacer un document dans l'index sans copie (PUT /guard/index/documents/{document}). */
    public function indexDocument(string $document, array $body): array
    {
        return $this->call('PUT', '/guard/index/documents/' . rawurlencode($document), [], $body, $this->timeout);
    }

    /** Retirer un document de l'index, tout de suite (DELETE /guard/index/documents/{document}). */
    public function deleteIndexedDocument(string $document, ?string $tenant = null): array
    {
        return $this->call('DELETE', '/guard/index/documents/' . rawurlencode($document), ['tenant' => $tenant], null, $this->timeout);
    }

    /** Effacer tout l'espace d'un client final (mode C), tout de suite (DELETE /guard/index). */
    public function deleteTenant(?string $tenant = null): array
    {
        return $this->call('DELETE', '/guard/index', ['tenant' => $tenant], null, $this->timeout);
    }

    /** Chiffres de l'index du projet (GET /guard/index/stats). */
    public function indexStats(?string $tenant = null): array
    {
        return $this->call('GET', '/guard/index/stats', ['tenant' => $tenant], null, $this->timeout);
    }

    /** Adresses des meilleurs passages pour une question (POST /guard/search). */
    public function search(array $body): array
    {
        return $this->call('POST', '/guard/search', [], $body, $this->timeout);
    }

    /** Rédiger une réponse citée à partir des passages, puis la vérifier (préversion) (POST /guard/answer). */
    public function answer(array $body): array
    {
        return $this->call('POST', '/guard/answer', [], $body, self::ANSWER_TIMEOUT);
    }
}

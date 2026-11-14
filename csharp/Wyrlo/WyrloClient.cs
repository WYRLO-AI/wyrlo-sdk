// Code généré depuis la spécification OpenAPI https://api.wyrlo.io/openapi.json
// (API WYRLO, contrat 2026-09-25). Ne pas modifier à la main.
// Préversion 0.1.0-preview : l'interface peut encore changer.

#nullable enable
using System;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Wyrlo
{
    /// <summary>Réponse d'erreur de l'API : { "error": { "code", "message" } }.</summary>
    public sealed class WyrloException : Exception
    {
        public int Status { get; }
        public string Code { get; }
        public string Body { get; }

        public WyrloException(int status, string code, string message, string body)
            : base($"wyrlo: {status} {code}: {message}")
        {
            Status = status;
            Code = code;
            Body = body;
        }
    }

    /// <summary>
    /// Appelle l'API WYRLO : vérifier une réponse de RAG contre ses sources, chercher dans
    /// l'index sans copie, obtenir une réponse citée et vérifiée. .NET 6 ou plus, aucune
    /// dépendance.
    /// </summary>
    public sealed class WyrloClient
    {
        public const string Version = "0.1.0-preview";
        public const string DefaultBaseUrl = "https://api.wyrlo.io/functions/v1";

        /// <summary>Délai de la rédaction (AnswerAsync), plus long que les autres appels.</summary>
        public static readonly TimeSpan AnswerTimeout = TimeSpan.FromSeconds(60);

        private readonly string _apiKey;
        private readonly string _baseUrl;
        private readonly TimeSpan _timeout;
        private readonly HttpClient _http;

        public WyrloClient(string apiKey, string baseUrl = DefaultBaseUrl, TimeSpan? timeout = null, HttpClient? http = null)
        {
            _apiKey = apiKey;
            _baseUrl = baseUrl;
            _timeout = timeout ?? TimeSpan.FromSeconds(30);
            _http = http ?? new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        }

        private async Task<JsonNode?> CallAsync(HttpMethod method, string path, (string, string?)[]? query, object? body, TimeSpan limit, CancellationToken cancellation)
        {
            var pairs = (query ?? Array.Empty<(string, string?)>())
                .Where(pair => !string.IsNullOrEmpty(pair.Item2))
                .Select(pair => pair.Item1 + "=" + Uri.EscapeDataString(pair.Item2!));
            var suffix = string.Join("&", pairs);
            using var request = new HttpRequestMessage(method, _baseUrl + path + (suffix.Length > 0 ? "?" + suffix : ""));
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
            request.Headers.TryAddWithoutValidation("x-region", "eu-west-3");
            request.Headers.TryAddWithoutValidation("User-Agent", "wyrlo-dotnet/" + Version);
            if (body != null)
            {
                request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
            }
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
            deadline.CancelAfter(limit);
            using var response = await _http.SendAsync(request, deadline.Token).ConfigureAwait(false);
            var raw = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            JsonNode? decoded = null;
            try { decoded = JsonNode.Parse(raw); } catch (JsonException) { }
            if ((int)response.StatusCode >= 400)
            {
                var error = decoded?["error"];
                throw new WyrloException(
                    (int)response.StatusCode,
                    error?["code"]?.GetValue<string>() ?? "unknown",
                    error?["message"]?.GetValue<string>() ?? "",
                    raw);
            }
            return decoded;
        }

    /// <summary>Vérifier une réponse (POST /guard).</summary>
    public Task<JsonNode?> GuardAsync(object body, CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Post, "/guard", null, body, _timeout, cancellation);

    /// <summary>Préparer la recherche (POST /guard/prepare).</summary>
    public Task<JsonNode?> PrepareAsync(object body, CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Post, "/guard/prepare", null, body, _timeout, cancellation);

    /// <summary>Pouce de l'utilisateur final (POST /guard/feedback).</summary>
    public Task<JsonNode?> FeedbackAsync(object body, CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Post, "/guard/feedback", null, body, _timeout, cancellation);

    /// <summary>Vérifier le branchement (GET /guard/health).</summary>
    public Task<JsonNode?> HealthAsync(CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Get, "/guard/health", null, null, _timeout, cancellation);

    /// <summary>Indexer un lot de documents (100 au plus) en un appel (POST /guard/index/documents).</summary>
    public Task<JsonNode?> IndexDocumentsAsync(object body, CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Post, "/guard/index/documents", null, body, _timeout, cancellation);

    /// <summary>Ajouter ou remplacer un document dans l'index sans copie (PUT /guard/index/documents/{document}).</summary>
    public Task<JsonNode?> IndexDocumentAsync(string document, object body, CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Put, "/guard/index/documents/" + Uri.EscapeDataString(document), null, body, _timeout, cancellation);

    /// <summary>Retirer un document de l'index, tout de suite (DELETE /guard/index/documents/{document}).</summary>
    public Task<JsonNode?> DeleteIndexedDocumentAsync(string document, string? tenant = null, CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Delete, "/guard/index/documents/" + Uri.EscapeDataString(document), new (string, string?)[] { ("tenant", tenant) }, null, _timeout, cancellation);

    /// <summary>Effacer tout l'espace d'un client final (mode C), tout de suite (DELETE /guard/index).</summary>
    public Task<JsonNode?> DeleteTenantAsync(string? tenant = null, CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Delete, "/guard/index", new (string, string?)[] { ("tenant", tenant) }, null, _timeout, cancellation);

    /// <summary>Chiffres de l'index du projet (GET /guard/index/stats).</summary>
    public Task<JsonNode?> IndexStatsAsync(string? tenant = null, CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Get, "/guard/index/stats", new (string, string?)[] { ("tenant", tenant) }, null, _timeout, cancellation);

    /// <summary>Adresses des meilleurs passages pour une question (POST /guard/search).</summary>
    public Task<JsonNode?> SearchAsync(object body, CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Post, "/guard/search", null, body, _timeout, cancellation);

    /// <summary>Rédiger une réponse citée à partir des passages, puis la vérifier (préversion) (POST /guard/answer).</summary>
    public Task<JsonNode?> AnswerAsync(object body, CancellationToken cancellation = default) =>
        CallAsync(HttpMethod.Post, "/guard/answer", null, body, AnswerTimeout, cancellation);
    }
}

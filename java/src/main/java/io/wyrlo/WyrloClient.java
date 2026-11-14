// Code généré depuis la spécification OpenAPI https://api.wyrlo.io/openapi.json
// (API WYRLO, contrat 2026-09-25). Ne pas modifier à la main.
// Préversion 0.1.0-preview : l'interface peut encore changer.

package io.wyrlo;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/**
 * Appelle l'API WYRLO : vérifier une réponse de RAG contre ses sources, chercher dans
 * l'index sans copie, obtenir une réponse citée et vérifiée. Java 11 ou plus, aucune
 * dépendance : les corps de requête et de réponse sont des chaînes JSON, à lire avec la
 * bibliothèque JSON de votre projet.
 */
public final class WyrloClient {
  public static final String VERSION = "0.1.0-preview";
  public static final String DEFAULT_BASE_URL = "https://api.wyrlo.io/functions/v1";
  /** Délai de la rédaction (answer), plus long que les autres appels. */
  public static final Duration ANSWER_TIMEOUT = Duration.ofSeconds(60);

  private final String apiKey;
  private final String baseUrl;
  private final Duration timeout;
  private final HttpClient http;

  public WyrloClient(String apiKey) {
    this(apiKey, DEFAULT_BASE_URL, Duration.ofSeconds(30));
  }

  public WyrloClient(String apiKey, String baseUrl, Duration timeout) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.timeout = timeout;
    this.http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
  }

  private static String encode(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
  }

  private String call(String method, String path, String jsonBody, Duration limit, String... query)
      throws IOException, InterruptedException {
    StringBuilder url = new StringBuilder(baseUrl).append(path);
    char separator = '?';
    for (int i = 0; i + 1 < query.length; i += 2) {
      if (query[i + 1] != null && !query[i + 1].isEmpty()) {
        url.append(separator).append(query[i]).append('=').append(encode(query[i + 1]));
        separator = '&';
      }
    }
    HttpRequest.Builder request =
        HttpRequest.newBuilder(URI.create(url.toString()))
            .timeout(limit)
            .header("Authorization", "Bearer " + apiKey)
            .header("x-region", "eu-west-3")
            .header("User-Agent", "wyrlo-java/" + VERSION);
    if (jsonBody != null) {
      request
          .header("Content-Type", "application/json")
          .method(method, HttpRequest.BodyPublishers.ofString(jsonBody, StandardCharsets.UTF_8));
    } else {
      request.method(method, HttpRequest.BodyPublishers.noBody());
    }
    HttpResponse<String> response =
        http.send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    if (response.statusCode() >= 400) {
      throw new WyrloException(response.statusCode(), response.body());
    }
    return response.body();
  }

  /** Vérifier une réponse (POST /guard). */
  public String guard(String jsonBody) throws IOException, InterruptedException {
    return call("POST", "/guard", jsonBody, timeout);
  }

  /** Préparer la recherche (POST /guard/prepare). */
  public String prepare(String jsonBody) throws IOException, InterruptedException {
    return call("POST", "/guard/prepare", jsonBody, timeout);
  }

  /** Pouce de l'utilisateur final (POST /guard/feedback). */
  public String feedback(String jsonBody) throws IOException, InterruptedException {
    return call("POST", "/guard/feedback", jsonBody, timeout);
  }

  /** Vérifier le branchement (GET /guard/health). */
  public String health() throws IOException, InterruptedException {
    return call("GET", "/guard/health", null, timeout);
  }

  /** Indexer un lot de documents (100 au plus) en un appel (POST /guard/index/documents). */
  public String indexDocuments(String jsonBody) throws IOException, InterruptedException {
    return call("POST", "/guard/index/documents", jsonBody, timeout);
  }

  /** Ajouter ou remplacer un document dans l'index sans copie (PUT /guard/index/documents/{document}). */
  public String indexDocument(String document, String jsonBody) throws IOException, InterruptedException {
    return call("PUT", "/guard/index/documents/" + encode(document), jsonBody, timeout);
  }

  /** Retirer un document de l'index, tout de suite (DELETE /guard/index/documents/{document}). */
  public String deleteIndexedDocument(String document, String tenant) throws IOException, InterruptedException {
    return call("DELETE", "/guard/index/documents/" + encode(document), null, timeout, "tenant", tenant);
  }

  /** Effacer tout l'espace d'un client final (mode C), tout de suite (DELETE /guard/index). */
  public String deleteTenant(String tenant) throws IOException, InterruptedException {
    return call("DELETE", "/guard/index", null, timeout, "tenant", tenant);
  }

  /** Chiffres de l'index du projet (GET /guard/index/stats). */
  public String indexStats(String tenant) throws IOException, InterruptedException {
    return call("GET", "/guard/index/stats", null, timeout, "tenant", tenant);
  }

  /** Adresses des meilleurs passages pour une question (POST /guard/search). */
  public String search(String jsonBody) throws IOException, InterruptedException {
    return call("POST", "/guard/search", jsonBody, timeout);
  }

  /** Rédiger une réponse citée à partir des passages, puis la vérifier (préversion) (POST /guard/answer). */
  public String answer(String jsonBody) throws IOException, InterruptedException {
    return call("POST", "/guard/answer", jsonBody, ANSWER_TIMEOUT);
  }
}

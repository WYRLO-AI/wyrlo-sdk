// Code généré depuis la spécification OpenAPI https://api.wyrlo.io/openapi.json
// (API WYRLO, contrat 2026-09-25). Ne pas modifier à la main.
// Préversion 0.1.0-preview : l'interface peut encore changer.

package io.wyrlo;

/** Réponse d'erreur de l'API : le statut HTTP et le corps JSON { "error": { "code", "message" } }. */
public final class WyrloException extends RuntimeException {
  private final int status;
  private final String body;

  public WyrloException(int status, String body) {
    super("wyrlo: " + status + " " + body);
    this.status = status;
    this.body = body;
  }

  public int status() {
    return status;
  }

  public String body() {
    return body;
  }
}

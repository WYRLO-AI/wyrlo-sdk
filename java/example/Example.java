// Exemple : vérifier une réponse, puis demander une réponse citée et vérifiée.
// javac -d out src/main/java/io/wyrlo/*.java example/Example.java
// WYRLO_API_KEY=wyr_test_… java -cp out Example
import io.wyrlo.WyrloClient;
import io.wyrlo.WyrloException;
import java.time.Duration;

public final class Example {
  public static void main(String[] args) throws Exception {
    String base = System.getenv("WYRLO_BASE_URL");
    WyrloClient client =
        new WyrloClient(
            System.getenv("WYRLO_API_KEY"),
            base == null || base.isEmpty() ? WyrloClient.DEFAULT_BASE_URL : base,
            Duration.ofSeconds(30));
    String passages =
        "[{\"id\":\"cgv#1\",\"text\":\"Le délai de rétractation est de 14 jours après la"
            + " livraison.\",\"source\":\"cgv.md\"}]";
    try {
      // 1. Votre RAG a rédigé une réponse : WYRLO la vérifie contre les passages.
      String checked =
          client.guard(
              "{\"question\":\"Quel est le délai de rétractation ?\","
                  + "\"answer\":\"Vous avez 14 jours après la livraison.\","
                  + "\"passages\":"
                  + passages
                  + "}");
      System.out.println("guard: " + checked);

      // 2. Ou WYRLO fait rédiger la réponse, puis la vérifie (préversion).
      String answered =
          client.answer(
              "{\"question\":\"Quel est le délai de rétractation ?\",\"passages\":" + passages + "}");
      System.out.println("answer: " + answered);
    } catch (WyrloException error) {
      System.err.println(error.getMessage());
      System.exit(1);
    }
  }
}

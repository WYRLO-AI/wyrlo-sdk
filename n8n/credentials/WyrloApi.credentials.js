// Identifiants WYRLO pour n8n : la clé d'API du projet, envoyée dans Authorization.
// Préversion : non publié sur npm sans l'accord du fondateur.
class WyrloApi {
  name = "wyrloApi";
  displayName = "WYRLO API";
  documentationUrl = "https://www.wyrlo.io/docs";
  properties = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description: "Project key (wyr_test_… or wyr_live_…), created in Project › Integration",
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://api.wyrlo.io/functions/v1",
      description: "API address. Keep the default unless WYRLO support tells you otherwise.",
    },
  ];
  authenticate = {
    type: "generic",
    properties: {
      headers: {
        Authorization: "=Bearer {{$credentials.apiKey}}",
        "x-region": "eu-west-3",
      },
    },
  };
  // Bouton « Test » de n8n : appelle une route qui lit la clé sans rien compter.
  test = {
    request: {
      baseURL: "={{$credentials.baseUrl}}",
      url: "/guard/index/stats",
      method: "GET",
    },
  };
}

module.exports = { WyrloApi };

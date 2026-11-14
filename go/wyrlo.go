// Code généré depuis la spécification OpenAPI https://api.wyrlo.io/openapi.json
// (API WYRLO, contrat 2026-09-25). Ne pas modifier à la main.
// Préversion 0.1.0-preview : l'interface peut encore changer.

// Package wyrlo appelle l'API WYRLO : vérifier une réponse de RAG contre ses sources,
// chercher dans l'index sans copie, obtenir une réponse citée et vérifiée.
package wyrlo

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Version de cette bibliothèque.
const Version = "0.1.0-preview"

// DefaultBaseURL est l'adresse de l'API (relais de Paris).
const DefaultBaseURL = "https://api.wyrlo.io/functions/v1"

// AnswerTimeout est le délai de la rédaction (Answer), plus long que les autres appels.
const AnswerTimeout = 60 * time.Second

// Client porte la clé d'API. BaseURL, HTTPClient et Timeout sont facultatifs.
type Client struct {
	APIKey     string
	BaseURL    string
	HTTPClient *http.Client
	Timeout    time.Duration
}

// New crée un client avec la clé d'API du projet (wyr_test_… ou wyr_live_…).
func New(apiKey string) *Client { return &Client{APIKey: apiKey} }

// APIError est une réponse d'erreur de l'API : { "error": { "code", "message" } }.
type APIError struct {
	Status  int
	Code    string
	Message string
	Body    string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("wyrlo: %d %s: %s", e.Status, e.Code, e.Message)
}

func (c *Client) timeout() time.Duration {
	if c.Timeout > 0 {
		return c.Timeout
	}
	return 30 * time.Second
}

func (c *Client) call(ctx context.Context, method, path string, query map[string]string, body any, timeout time.Duration) (map[string]any, error) {
	base := c.BaseURL
	if base == "" {
		base = DefaultBaseURL
	}
	target := base + path
	values := url.Values{}
	for name, value := range query {
		if value != "" {
			values.Set(name, value)
		}
	}
	if len(values) > 0 {
		target += "?" + values.Encode()
	}
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(raw)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, target, payload)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.APIKey)
	request.Header.Set("x-region", "eu-west-3")
	request.Header.Set("User-Agent", "wyrlo-go/"+Version)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client := c.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}
	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	if response.StatusCode >= 400 {
		apiError := &APIError{Status: response.StatusCode, Code: "unknown", Body: string(raw)}
		if detail, ok := decoded["error"].(map[string]any); ok {
			if code, ok := detail["code"].(string); ok {
				apiError.Code = code
			}
			if message, ok := detail["message"].(string); ok {
				apiError.Message = message
			}
		}
		return nil, apiError
	}
	return decoded, nil
}

// Guard : Vérifier une réponse (POST /guard).
func (c *Client) Guard(ctx context.Context, body any) (map[string]any, error) {
	return c.call(ctx, "POST", "/guard", nil, body, c.timeout())
}

// Prepare : Préparer la recherche (POST /guard/prepare).
func (c *Client) Prepare(ctx context.Context, body any) (map[string]any, error) {
	return c.call(ctx, "POST", "/guard/prepare", nil, body, c.timeout())
}

// Feedback : Pouce de l'utilisateur final (POST /guard/feedback).
func (c *Client) Feedback(ctx context.Context, body any) (map[string]any, error) {
	return c.call(ctx, "POST", "/guard/feedback", nil, body, c.timeout())
}

// Health : Vérifier le branchement (GET /guard/health).
func (c *Client) Health(ctx context.Context) (map[string]any, error) {
	return c.call(ctx, "GET", "/guard/health", nil, nil, c.timeout())
}

// IndexDocuments : Indexer un lot de documents (100 au plus) en un appel (POST /guard/index/documents).
func (c *Client) IndexDocuments(ctx context.Context, body any) (map[string]any, error) {
	return c.call(ctx, "POST", "/guard/index/documents", nil, body, c.timeout())
}

// IndexDocument : Ajouter ou remplacer un document dans l'index sans copie (PUT /guard/index/documents/{document}).
func (c *Client) IndexDocument(ctx context.Context, document string, body any) (map[string]any, error) {
	return c.call(ctx, "PUT", "/guard/index/documents/"+url.PathEscape(document), nil, body, c.timeout())
}

// DeleteIndexedDocument : Retirer un document de l'index, tout de suite (DELETE /guard/index/documents/{document}).
func (c *Client) DeleteIndexedDocument(ctx context.Context, document string, tenant string) (map[string]any, error) {
	return c.call(ctx, "DELETE", "/guard/index/documents/"+url.PathEscape(document), map[string]string{"tenant": tenant}, nil, c.timeout())
}

// DeleteTenant : Effacer tout l'espace d'un client final (mode C), tout de suite (DELETE /guard/index).
func (c *Client) DeleteTenant(ctx context.Context, tenant string) (map[string]any, error) {
	return c.call(ctx, "DELETE", "/guard/index", map[string]string{"tenant": tenant}, nil, c.timeout())
}

// IndexStats : Chiffres de l'index du projet (GET /guard/index/stats).
func (c *Client) IndexStats(ctx context.Context, tenant string) (map[string]any, error) {
	return c.call(ctx, "GET", "/guard/index/stats", map[string]string{"tenant": tenant}, nil, c.timeout())
}

// Search : Adresses des meilleurs passages pour une question (POST /guard/search).
func (c *Client) Search(ctx context.Context, body any) (map[string]any, error) {
	return c.call(ctx, "POST", "/guard/search", nil, body, c.timeout())
}

// Answer : Rédiger une réponse citée à partir des passages, puis la vérifier (préversion) (POST /guard/answer).
func (c *Client) Answer(ctx context.Context, body any) (map[string]any, error) {
	return c.call(ctx, "POST", "/guard/answer", nil, body, AnswerTimeout)
}

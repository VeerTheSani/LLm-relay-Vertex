# LLM Relay (Google Cloud Vertex AI + OpenAI Gateway)

A lightweight, self-hosted, OpenAI-compatible API gateway for **Google Cloud Vertex AI (Gemini)** and any OpenAI-style LLM provider (NVIDIA NIM, Groq, OpenRouter, DeepSeek).

Deploy effortlessly on **Render** using Google Cloud Service Account credentials and connect any OpenAI-compatible SDK, agent, or frontend client via a single `/v1/chat/completions` endpoint.

---

## Setting Up Google Vertex AI on Render

### Step 1: Create a Google Cloud Service Account Key
1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Vertex AI API** in your project.
3. Go to **IAM & Admin → Service Accounts** and create a service account with the **Vertex AI User** (`roles/aiplatform.user`) role.
4. Open the Service Account → **Keys → Add Key → Create new key → JSON** to download your `.json` credentials file.

### Step 2: Add Credentials in Render
On your Render Web Service dashboard, go to **Environment** and choose any of these methods:

- **Option A — Environment Variable (`GOOGLE_SERVICE_ACCOUNT_JSON`):**
  Add `GOOGLE_SERVICE_ACCOUNT_JSON` and paste your `.json` file contents (raw JSON, Base64, or `key=value` format).
- **Option B — Individual Environment Variables ("Add from .env"):**
  Provide `project_id`, `private_key`, `client_email`, and `private_key_id` directly as environment variables.
- **Option C — Render Secret File:**
  Upload your `.json` file under **Secret Files** (the gateway automatically scans `/etc/secrets/*.json`, or you can set `GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/<filename>.json`).

Optional settings:
- `PROXY_KEYS`: Comma-separated client API keys for authenticating requests
- `VERTEX_LOCATION`: `global` (default) or any regional endpoint such as `us-central1`
- `VERTEX_SAFETY_THRESHOLD`: `BLOCK_NONE` (default)

### Step 3: Connect Any OpenAI-Compatible Client
Point any OpenAI SDK or client application to your gateway:
- **Chat Completions Endpoint**: `https://<your-render-app>.onrender.com/v1/chat/completions`
- **Base URL (OpenAI SDK)**: `https://<your-render-app>.onrender.com/v1`
- **Model ID**: Any Vertex AI Gemini model ID, such as:
  - `gemini-3.1-pro-preview`
  - `gemini-3-flash-preview`
  - `gemini-2.5-pro`
  - `gemini-2.5-flash`
- **API Key**: Your configured `PROXY_KEYS` secret.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | — | Raw Google Cloud Service Account JSON string (or Base64 / key-value) |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Path to a Service Account JSON file (e.g., `/etc/secrets/vertex-key.json`) |
| `VERTEX_PROJECT_ID` | *(from JSON)* | Overrides `project_id` from the Service Account credentials if needed |
| `VERTEX_LOCATION` | `global` | Vertex AI location (`global`, `us-central1`, `europe-west4`, etc.) |
| `VERTEX_SAFETY_THRESHOLD` | `BLOCK_NONE` | Vertex AI content filter threshold (`BLOCK_NONE`, `OFF`, `BLOCK_ONLY_HIGH`) |
| `PROXY_KEYS` | — | Comma-separated client keys used to authenticate incoming API requests |
| `REASONING_MODE` | `hide` | `hide` strips thinking tokens, `show` wraps them in `<think>` tags, `passthrough` forwards `reasoning_content` |
| `UPSTREAM_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Fallback OpenAI-compatible provider URL for non-Gemini models |
| `UPSTREAM_API_KEY` | — | Optional API key for non-Vertex OpenAI-compatible models |
| `MODEL_OVERRIDE` | — | Force every request to use a specific model ID |
| `MODEL_ALLOWLIST` | — | Comma-separated allowed model IDs |
| `RATE_LIMIT_PER_MIN` | `0` (off) | Max requests per minute per client key |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout in milliseconds |
| `MAX_RETRIES` | `2` | Retry attempts on transient upstream errors (429/502/503/504) |
| `PORT` | `3000` | HTTP server port |

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | none | Interactive Web Playground & Client Endpoint Configuration |
| GET | `/health` | none | Gateway health, uptime, and Vertex AI status check |
| GET | `/stats` | key | Request counts, error counts, and per-model usage |
| GET | `/v1/models` | key | Lists available Vertex AI Gemini and upstream models |
| POST | `/v1/chat/completions` | key | OpenAI-compatible chat completions (streaming & non-streaming) |

## License

MIT — Veer Rabari

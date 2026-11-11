# LLM Relay (Google Vertex AI Gemini + Janitor AI Proxy)

A lightweight, self-hosted, OpenAI-compatible gateway for **Google Cloud Vertex AI (Gemini)** and any OpenAI-style LLM API (NVIDIA NIM, Groq, OpenRouter, DeepSeek).

Designed to deploy effortlessly on **Render** using a Google Cloud Service Account JSON (either pasted directly as an environment variable or mounted as a Secret File) and connect directly to **Janitor AI** as a custom OpenAI proxy with `BLOCK_NONE` safety settings.

---

## Setting Up Google Vertex AI on Render for Janitor AI

### Step 1: Get Your Google Cloud Service Account JSON
1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Vertex AI API** in your project.
3. Go to **IAM & Admin → Service Accounts** and create a service account with the **Vertex AI User** (`roles/aiplatform.user`) role.
4. Open the Service Account → **Keys → Add Key → Create new key → JSON** to download your `.json` credentials file.

### Step 2: Add the JSON in Render
On your Render Web Service dashboard, go to **Environment** and choose **either** of these two methods:

- **Option A — Environment Variable (Fastest):**
  Add a new Environment Variable named `GOOGLE_SERVICE_ACCOUNT_JSON` and paste the entire contents of your downloaded `.json` file as the value (raw JSON or Base64-encoded JSON are both supported).
- **Option B — Render Secret File:**
  Under **Secret Files**, create a file named `vertex-key.json` with your JSON contents, then add an Environment Variable:
  `GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/vertex-key.json`

Also set:
- `PROXY_KEYS`: Your chosen secret key for Janitor AI (e.g. `my-secret-key`)
- `VERTEX_LOCATION`: `us-central1` (or `global`)
- `VERTEX_SAFETY_THRESHOLD`: `BLOCK_NONE` (enabled by default for roleplay compatibility)

### Step 3: Connect to Janitor AI
Open a chat in **Janitor AI**, click **API Settings → Proxy / Custom**, and enter:
- **Custom Proxy URL**: `https://<your-render-app>.onrender.com/v1/chat/completions`
- **Model Name**: Type any Gemini model ID normally, such as:
  - `gemini-2.5-pro`
  - `gemini-2.5-flash`
  - `gemini-2.5-flash-lite`
  - `gemini-2.0-flash`
  - `gemini-1.5-pro`
- **API Key**: Your `PROXY_KEYS` secret value from Render.

Click **Check Proxy / Save Settings** in Janitor AI — the gateway supports `GET /v1/models` and automatically merges consecutive system/character prompts and disables Vertex safety filters (`BLOCK_NONE`).

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | — | Raw Google Cloud Service Account JSON string (or Base64) pasted directly in Render |
| `GOOGLE_APPLICATION_CREDENTIALS` | — | Path to a Service Account JSON file (e.g., `/etc/secrets/vertex-key.json`) |
| `VERTEX_PROJECT_ID` | *(from JSON)* | Overrides `project_id` from the Service Account JSON if needed |
| `VERTEX_LOCATION` | `us-central1` | Vertex AI region (`us-central1`, `global`, `europe-west4`, etc.) |
| `VERTEX_SAFETY_THRESHOLD` | `BLOCK_NONE` | Vertex AI harm category threshold (`BLOCK_NONE`, `OFF`, `BLOCK_ONLY_HIGH`) |
| `PROXY_KEYS` | — | Comma-separated client keys used to authenticate Janitor AI / OpenAI clients |
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
| GET | `/` | none | Interactive Web Playground & One-Click Janitor AI Setup Helper |
| GET | `/health` | none | Gateway health, uptime, and Vertex AI configuration check |
| GET | `/stats` | key | Request counts, error counts, and per-model usage |
| GET | `/v1/models` | key | Lists Vertex AI Gemini models (and any configured OpenAI upstream models) |
| POST | `/v1/chat/completions` | key | OpenAI-compatible chat completions (streaming & non-streaming) |

## License

MIT — Veer Rabari

# Google Vertex AI Gemini Gateway & Janitor AI Proxy Integration

This update transforms the LLM Relay Gateway into a dual-capable OpenAI-compatible proxy that natively authenticates with Google Cloud Vertex AI using a Service Account JSON (via environment variable or secret file on Render), translates OpenAI chat completion requests (including Janitor AI prompts and streaming) to Vertex AI Gemini endpoints with `BLOCK_NONE` safety settings, and provides a one-click Janitor AI setup panel in the live playground.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural and UX choices incorporate your answers from Phase 1. Please review and click **Proceed** to begin implementation.

- **Confirmed Decision 1 — Vertex AI Gemini Native & OpenAI-Compatible Routing**: Users can enter standard Gemini model IDs (e.g., `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-1.5-pro`) in Janitor AI's model input. The gateway automatically routes `gemini-*` models (or all requests when Vertex mode is set as primary) through Google Vertex AI while preserving existing NVIDIA NIM / OpenAI upstream compatibility.
- **Confirmed Decision 2 — Dual Service Account JSON Loading on Render**: The gateway accepts credentials via either `GOOGLE_SERVICE_ACCOUNT_JSON` (raw JSON string or base64-encoded JSON pasted directly into a Render Environment Variable) or `GOOGLE_APPLICATION_CREDENTIALS` (file path to a Render Secret File), automatically extracting `project_id`, `client_email`, and `private_key` to mint short-lived OAuth2 Bearer tokens with zero external SDK bloat.
- **Confirmed Decision 3 — Roleplay Safety Bypass (`BLOCK_NONE` / `OFF`)**: Requests routed to Vertex AI Gemini automatically inject permissive `safetySettings` (`BLOCK_NONE` across `HARM_CATEGORY_HARASSMENT`, `HARM_CATEGORY_HATE_SPEECH`, `HARM_CATEGORY_SEXUALLY_EXPLICIT`, `HARM_CATEGORY_DANGEROUS_CONTENT`, and `HARM_CATEGORY_CIVIC_INTEGRITY`) so creative writing and Janitor AI roleplay prompts are not prematurely blocked.
- **Confirmed Decision 4 — One-Click Janitor AI Setup Helper**: The web console includes a dedicated **Janitor AI Proxy Setup** card displaying the exact Custom Proxy URL (`/v1/chat/completions`), copyable Gemini model IDs, API key status, and a one-click configuration copy & test workflow.

---

## 1. Overview & Core Concept

- **What It Does**: Bridges OpenAI-formatted clients—specifically **Janitor AI**—to **Google Cloud Vertex AI Gemini models** using standard Google Service Account JSON credentials hosted on Render.
- **Target Audience / Persona**: Users deploying a private LLM proxy on Render who want to use their Google Cloud credits / Vertex AI quota inside Janitor AI without running local tunnels.
- **Key Value**: Eliminates Vertex AI's complex IAM token rotation and request schema mismatches by exposing a single static `/v1/chat/completions` URL and static proxy key that Janitor AI understands natively.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Render Status & Vertex Credential Check**: Upon opening the dashboard, the user immediately sees whether Vertex AI Service Account credentials are loaded (showing the detected GCP Project ID and Region) alongside gateway health and uptime.
  2. **One-Click Janitor AI Setup**: A dedicated panel displays the exact **Janitor AI API URL** (`https://<your-render-domain>/v1/chat/completions`), the selected **Gemini Model ID** (`gemini-2.5-pro`, `gemini-2.5-flash`, etc.), and a **Copy for Janitor AI** button that copies each field cleanly with inline visual confirmation (replacing browser `alert()` popups).
  3. **Live Gemini & Roleplay Taste Test**: Users can select a Vertex Gemini preset chip, toggle `BLOCK_NONE` safety bypass verification, and stream a test response in real time before pasting the URL into Janitor AI.
- **Visual Identity & Theme**:
  - *Aesthetic Direction*: High-craft dark developer telemetry console with crisp structural hierarchy and zero visual clutter.
  - *Color Palette & Mood*: Deep obsidian-slate canvas (`#090D16`), translucent slate structural panels (`rgba(18, 25, 38, 0.78)`), hairline borders (`rgba(255, 255, 255, 0.08)`), sky-cyan primary accents (`#38BDF8`) for active controls, and semantic emerald (`#10B981`), amber (`#F59E0B`), and coral (`#EF4444`) indicators paired with explicit text labels.
  - *Typography & Hierarchy*: Clean sans-serif structural headings paired with `Fira Code` monospace (`tabular-nums`) for endpoints, model identifiers, token counters, and latency readouts.
  - *Component Styling & Layout*: Balanced two-column workspace with a new **Janitor AI Quick-Connect Bar** above the console grid, single-line controls (`whitespace-nowrap`), and inline toast feedback instead of blocking browser alerts.
- **Interactive Feedback & Motion**:
  - Clicking any copy button transitions the button label to `"Copied!"` for 1.8 seconds with a smooth `150ms` opacity/color transition.
  - Model preset buttons dynamically switch between Vertex AI Gemini models and NVIDIA NIM models based on active upstream availability.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: Native Node.js Crypto JWT Signing vs. Heavy Google Cloud SDKs**
  - *Chosen Approach*: Use Node's built-in `crypto` module (`RS256` JWT assertion exchanged at `https://oauth2.googleapis.com/token` with automatic in-memory caching for 55 minutes).
  - *Why*: Keeps the repository ultra-lightweight (`express` + `cors` only), deploys in seconds on Render free/starter tiers, and avoids multi-hundred-megabyte `@google-cloud/vertexai` dependency trees while supporting both raw JSON strings and file paths.
  - *Alternatives Considered*: Installing `google-auth-library`, which adds extra install time and file-system assumptions when users paste raw JSON strings in Render environment variables.
- **Decision 2: Native Vertex `generateContent` / `streamGenerateContent` Translation with `BLOCK_NONE`**
  - *Chosen Approach*: Translate incoming OpenAI `/v1/chat/completions` payloads (`messages`, `system` prompts, `temperature`, `max_tokens`, `top_p`, `stream`) directly into Vertex AI's `generateContent` and `streamGenerateContent?alt=sse` REST API, and convert Vertex responses back into standard OpenAI JSON and SSE chunks (`choices[0].delta.content` and `reasoning_content` for Gemini thinking tokens).
  - *Why*: Vertex AI's OpenAI-compatible endpoint does not always expose full `safetySettings` (`BLOCK_NONE`) or thinking-budget controls across all Gemini models. Direct translation guarantees `BLOCK_NONE` safety settings work reliably for Janitor AI roleplay and seamlessly integrates with the gateway's existing `REASONING_MODE` (`hide`, `show`, `passthrough`).

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Architecture & Component Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Client Layer (Janitor AI / Web Playground)                │
│  ┌───────────────────────────────┐      ┌────────────────────────────────┐  │
│  │ Janitor AI Custom Proxy       │      │ Live Model Playground UI       │  │
│  │ POST /v1/chat/completions     │      │ • Janitor AI 1-Click Copy Card │  │
│  │ GET  /v1/models               │      │ • Vertex Gemini Preset Selector│  │
│  └───────────────┬───────────────┘      └────────────────┬───────────────┘  │
└──────────────────┼───────────────────────────────────────┼──────────────────┘
                   │ Bearer <PROXY_KEY>                    │
                   ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         LLM Relay Gateway (Express)                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ Auth & Sliding-Window Rate Limiter + Gateway Status (/health, /stats) │  │
│  └───────────────────────────────────┬───────────────────────────────────┘  │
│                                      ▼                                      │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │Provider Router: Detects `gemini-*` / `vertex/*` or UPSTREAM_PROVIDER  │  │
│  └───────────────┬───────────────────────────────────────┬───────────────┘  │
│                  │ Gemini / Vertex Route                 │ Standard OpenAI  │
│                  ▼                                       ▼                  │
│  ┌───────────────────────────────────────┐  ┌────────────────────────────┐  │
│  │ Vertex AI Adapter & Token Manager     │  │ OpenAI / NVIDIA NIM Proxy  │  │
│  │ • Parses JSON String / Base64 / File  │  │ • Upstream Bearer Fetch    │  │
│  │ • Signs RS256 JWT -> Cached OAuth2    │  │ • Retries & SSE Rewriter   │  │
│  │ • Injects BLOCK_NONE Safety Settings  │  └────────────────────────────┘  │
│  │ • OpenAI <-> Vertex SSE Translator    │                                  │
│  └───────────────┬───────────────────────┘                                  │
└──────────────────┼──────────────────────────────────────────────────────────┘
                   │ OAuth2 Bearer Token
                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│        Google Cloud Vertex AI (`aiplatform.googleapis.com/v1beta1`)         │
│        models/{gemini-2.5-pro, gemini-2.5-flash, ...}:streamGenerateContent │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Model & Configuration State

- **Vertex Credential Configuration**:
  - `GOOGLE_SERVICE_ACCOUNT_JSON`: Accepts raw JSON (`{"type":"service_account",...}`) or Base64-encoded JSON directly from Render's Environment Variables UI.
  - `GOOGLE_APPLICATION_CREDENTIALS`: Accepts a file path (e.g., `/etc/secrets/vertex-key.json` on Render Secret Files).
  - `VERTEX_LOCATION`: Defaults to `us-central1` (supports `global` or any GCP region, with automatic global endpoint formatting when `VERTEX_LOCATION=global`).
  - `VERTEX_PROJECT_ID`: Automatically extracted from the Service Account JSON `project_id` field, with optional env override.
  - `VERTEX_SAFETY_THRESHOLD`: Defaults to `BLOCK_NONE` across all harm categories for Janitor AI compatibility.
- **Health & Capabilities Endpoint (`/health`)**:
  - Returns non-sensitive provider diagnostics (`vertexConfigured: true/false`, `vertexProjectId`, `vertexLocation`, `safetyMode: "BLOCK_NONE"`, `activeProvider`) so the web UI can display live setup verification without exposing keys.

### Interactive Component & State Mapping

- **Janitor AI Quick-Connect Panel**:
  - Dynamically computes the full Janitor AI Proxy URL (`${origin}/v1/chat/completions`) and Models Check URL (`${origin}/v1/models`).
  - Clicking a Gemini model chip (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`) updates both the Janitor AI copy box and the live Taste Tester input simultaneously.
  - Inline copy handlers write to `navigator.clipboard` and display non-blocking visual confirmation badges.
- **Vertex OpenAI-to-Gemini Request & Stream Pipeline**:
  - Consolidates `system` / `developer` messages into Vertex's `systemInstruction` block.
  - Merges consecutive same-role messages (common in Janitor AI when system prompt + character card + jailbreak/post-history instructions are sent in sequence) so Vertex AI never rejects the payload due to strict alternating-turn validation.
  - Maps Gemini thought parts (`part.thought === true`) to `reasoning_content` so the existing `SseRewriter` and `transformCompletion` respect `REASONING_MODE=hide|show|passthrough`.

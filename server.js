const express = require("express");
const cors = require("cors");
const { Readable } = require("stream");
const path = require("path");
const config = require("./config");
const { SlidingWindowLimiter } = require("./lib/ratelimit");
const { transformCompletion, SseRewriter } = require("./lib/reasoning");
const {
  VERTEX_GEMINI_MODELS,
  isVertexModel,
  fetchVertexWithRetry,
  convertVertexResponseToOpenAI,
  pipeVertexSseToOpenAiSse,
} = require("./lib/vertex");

const app = express();
const limiter = new SlidingWindowLimiter(config.rateLimitPerMin);
const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  upstreamErrors: 0,
  rateLimited: 0,
  models: {},
};

const corsOptions =
  config.allowedOrigins.length === 0 || config.allowedOrigins.includes("*")
    ? {}
    : { origin: config.allowedOrigins };

app.use(cors(corsOptions));
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ limit: config.bodyLimit, extended: true }));

function clientKey(req) {
  const authHeader = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (authHeader) return authHeader;
  return (req.headers["x-api-key"] || "").trim();
}

function apiError(res, status, message, type, code) {
  return res.status(status).json({ error: { message, type, code: code || null } });
}

function requireAuth(req, res, next) {
  if (config.proxyKeys.length === 0) return next();
  if (config.proxyKeys.includes(clientKey(req))) return next();
  return apiError(
    res,
    401,
    "The server is locked behind a key. Contact @veerthesani to get access.",
    "authentication_error",
    "invalid_api_key"
  );
}

function rateLimit(req, res, next) {
  const verdict = limiter.check(clientKey(req) || req.ip);
  if (verdict.allowed) return next();
  stats.rateLimited += 1;
  res.set("Retry-After", String(verdict.retryAfterSeconds));
  return apiError(
    res,
    429,
    `Rate limit of ${config.rateLimitPerMin} requests per minute exceeded. Retry in ${verdict.retryAfterSeconds}s.`,
    "rate_limit_error",
    "rate_limit_exceeded"
  );
}

function logRequest(req, status, model, startedMs, provider) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      method: req.method,
      path: req.path,
      provider: provider || "openai",
      model: model || null,
      status,
      ms: Date.now() - startedMs,
    })
  );
}

function upstreamHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.upstreamApiKey}`,
  };
}

async function fetchUpstream(endpointPath, init) {
  let lastError;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(config.upstreamBaseUrl + endpointPath, {
        ...init,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      const retryable = [429, 502, 503, 504].includes(response.status);
      if (retryable && attempt < config.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < config.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
  }
  throw lastError || new Error("Upstream request failed after retries");
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptimeSeconds: Math.floor(process.uptime()),
    authRequired: config.proxyKeys.length > 0,
    vertex: {
      configured: config.vertexConfigured,
      projectId: config.vertexProjectId || null,
      location: config.vertexLocation || "us-central1",
      credentialSource: config.vertexCredentialSource,
      safetyThreshold: config.vertexSafetyThreshold,
    },
    openaiUpstream: {
      configured: Boolean(config.upstreamApiKey),
      baseUrl: config.upstreamBaseUrl,
    },
  });
});

app.get("/stats", requireAuth, (req, res) => {
  res.json(stats);
});

app.get("/v1/models", requireAuth, async (req, res) => {
  const started = Date.now();
  const combinedModels = [...VERTEX_GEMINI_MODELS];

  if (config.upstreamApiKey) {
    try {
      const upstream = await fetchUpstream("/models", { headers: upstreamHeaders() });
      if (upstream.ok) {
        const data = await upstream.json();
        if (data && Array.isArray(data.data)) {
          const existingIds = new Set(combinedModels.map((m) => m.id));
          for (const model of data.data) {
            if (model && model.id && !existingIds.has(model.id)) {
              combinedModels.push(model);
            }
          }
        }
      }
    } catch {
      // Keep Vertex Gemini models available even if secondary upstream is unreachable
    }
  }

  logRequest(req, 200, null, started, config.vertexConfigured ? "vertex+upstream" : "models");
  return res.json({
    object: "list",
    data: combinedModels,
  });
});

// Helpful GET handler so users testing the Janitor AI proxy URL in a browser see a clear status message
app.get("/v1/chat/completions", (req, res) => {
  res.json({
    status: "ready",
    endpoint: "/v1/chat/completions",
    message:
      "Janitor AI Custom Proxy endpoint is active. Use POST requests with your Proxy Key and a Gemini model (e.g. gemini-2.5-pro or gemini-2.5-flash).",
    vertexConfigured: config.vertexConfigured,
    safetyThreshold: config.vertexSafetyThreshold,
    recommendedModels: VERTEX_GEMINI_MODELS.map((m) => m.id),
  });
});

app.post("/v1/chat/completions", requireAuth, rateLimit, async (req, res) => {
  const started = Date.now();
  const body = { ...req.body };

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return apiError(res, 400, "'messages' must be a non-empty array.", "invalid_request_error", "invalid_messages");
  }

  if (config.modelOverride) body.model = config.modelOverride;

  if (!body.model || typeof body.model !== "string") {
    return apiError(res, 400, "'model' is required.", "invalid_request_error", "missing_model");
  }

  if (config.modelAllowlist.length > 0 && !config.modelAllowlist.includes(body.model)) {
    return apiError(
      res,
      403,
      `Model '${body.model}' is not allowed on this gateway.`,
      "invalid_request_error",
      "model_not_allowed"
    );
  }

  stats.requests += 1;
  stats.models[body.model] = (stats.models[body.model] || 0) + 1;

  const useVertex = isVertexModel(body.model, config);

  // === ROUTE 1: Google Cloud Vertex AI (Gemini) ===
  if (useVertex) {
    if (!config.vertexConfigured) {
      stats.upstreamErrors += 1;
      logRequest(req, 500, body.model, started, "vertex");
      return apiError(
        res,
        500,
        "Google Vertex AI credentials are not configured on this server. Add GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON string) or GOOGLE_APPLICATION_CREDENTIALS (Secret File path) in your Render environment variables.",
        "configuration_error",
        "vertex_not_configured"
      );
    }

    let vertexResponse;
    try {
      vertexResponse = await fetchVertexWithRetry(config, body);
    } catch (error) {
      stats.upstreamErrors += 1;
      logRequest(req, 502, body.model, started, "vertex");
      return apiError(res, 502, `Vertex AI error: ${error.message}`, "upstream_error", "vertex_unreachable");
    }

    if (!vertexResponse.ok) {
      stats.upstreamErrors += 1;
      let errText = "";
      try {
        errText = await vertexResponse.text();
      } catch {}
      let errMsg = `Vertex AI returned HTTP ${vertexResponse.status}`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error && parsed.error.message) {
          errMsg = parsed.error.message;
        } else if (Array.isArray(parsed) && parsed[0]?.error?.message) {
          errMsg = parsed[0].error.message;
        }
      } catch {
        if (errText) errMsg = errText.slice(0, 400);
      }
      logRequest(req, vertexResponse.status, body.model, started, "vertex");
      return apiError(res, vertexResponse.status, errMsg, "vertex_api_error");
    }

    if (!body.stream) {
      let vertexData;
      try {
        vertexData = await vertexResponse.json();
      } catch {
        stats.upstreamErrors += 1;
        logRequest(req, 502, body.model, started, "vertex");
        return apiError(res, 502, "Vertex AI returned a non-JSON response.", "upstream_error");
      }

      const openAiData = convertVertexResponseToOpenAI(vertexData, body.model);
      logRequest(req, 200, body.model, started, "vertex");
      return res.status(200).json(transformCompletion(openAiData, config.reasoningMode));
    }

    if (!vertexResponse.body) {
      stats.upstreamErrors += 1;
      logRequest(req, 502, body.model, started, "vertex");
      return apiError(res, 502, "Vertex AI stream failed to start.", "upstream_error");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const rewriter = new SseRewriter(config.reasoningMode);
    const reader = pipeVertexSseToOpenAiSse(
      vertexResponse.body,
      body.model,
      rewriter,
      res,
      () => logRequest(req, 200, body.model, started, "vertex"),
      () => {
        stats.upstreamErrors += 1;
        res.end();
        logRequest(req, 500, body.model, started, "vertex");
      }
    );

    req.on("close", () => reader.destroy());
    return;
  }

  // === ROUTE 2: Standard OpenAI-Compatible Upstream (NVIDIA NIM, OpenRouter, etc.) ===
  let upstream;
  try {
    upstream = await fetchUpstream("/chat/completions", {
      method: "POST",
      headers: upstreamHeaders(),
      body: JSON.stringify(body),
    });
  } catch (error) {
    stats.upstreamErrors += 1;
    logRequest(req, 502, body.model, started, "openai");
    return apiError(res, 502, `Upstream unreachable: ${error.message}`, "upstream_error");
  }

  if (!body.stream) {
    let data;
    try {
      data = await upstream.json();
    } catch {
      data = { error: { message: "Upstream returned a non-JSON response.", type: "upstream_error" } };
    }
    if (!upstream.ok) stats.upstreamErrors += 1;
    logRequest(req, upstream.status, body.model, started, "openai");
    return res.status(upstream.status).json(transformCompletion(data, config.reasoningMode));
  }

  if (!upstream.ok || !upstream.body) {
    stats.upstreamErrors += 1;
    let detail = null;
    try {
      detail = await upstream.json();
    } catch {}
    logRequest(req, upstream.status, body.model, started, "openai");
    if (detail) return res.status(upstream.status).json(detail);
    return apiError(res, upstream.status, "Upstream stream failed to start.", "upstream_error");
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const rewriter = new SseRewriter(config.reasoningMode);
  const reader = Readable.fromWeb(upstream.body);

  reader.on("data", (chunk) => {
    res.write(rewriter.feed(chunk.toString("utf8")));
  });

  reader.on("end", () => {
    res.write(rewriter.flush());
    res.end();
    logRequest(req, 200, body.model, started, "openai");
  });

  reader.on("error", () => {
    stats.upstreamErrors += 1;
    res.end();
    logRequest(req, 500, body.model, started, "openai");
  });

  req.on("close", () => reader.destroy());
});

app.use((req, res) => {
  apiError(
    res,
    404,
    `No route for ${req.method} ${req.path}. Available: GET /health, GET /stats, GET /v1/models, POST /v1/chat/completions.`,
    "invalid_request_error",
    "unknown_endpoint"
  );
});

app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      message: "gateway started",
      port: config.port,
      vertexConfigured: config.vertexConfigured,
      vertexProjectId: config.vertexProjectId || null,
      vertexLocation: config.vertexLocation,
      vertexSafetyThreshold: config.vertexSafetyThreshold,
      upstream: config.upstreamBaseUrl,
      reasoningMode: config.reasoningMode,
      authEnabled: config.proxyKeys.length > 0,
      rateLimitPerMin: config.rateLimitPerMin || "off",
    })
  );
});

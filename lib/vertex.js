const crypto = require("crypto");
const { Readable } = require("stream");

const VERTEX_GEMINI_MODELS = [
  {
    id: "gemini-3.1-pro-preview",
    object: "model",
    created: 1746000000,
    owned_by: "google-vertex-ai",
    description: "Gemini 3.1 Pro Preview on Vertex AI Global",
  },
  {
    id: "gemini-3-flash-preview",
    object: "model",
    created: 1745000000,
    owned_by: "google-vertex-ai",
    description: "Gemini 3 Flash Preview on Vertex AI Global",
  },
  {
    id: "gemini-2.5-pro",
    object: "model",
    created: 1740000000,
    owned_by: "google-vertex-ai",
    description: "Gemini 2.5 Pro on Vertex AI",
  },
  {
    id: "gemini-2.5-flash",
    object: "model",
    created: 1740000000,
    owned_by: "google-vertex-ai",
    description: "Gemini 2.5 Flash on Vertex AI Global",
  },
];

const HARM_CATEGORIES = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
];

let cachedToken = null;
let cachedTokenExpiryMs = 0;

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createSignedJwt(serviceAccount) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  if (serviceAccount.private_key_id) {
    header.kid = serviceAccount.private_key_id;
  }

  const payload = {
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600,
    scope: "https://www.googleapis.com/auth/cloud-platform",
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer.sign(serviceAccount.private_key);
  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

async function getVertexAccessToken(config) {
  if (!config.vertexConfigured) {
    throw new Error(
      "Google Vertex AI credentials are not configured. Set GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS in Render."
    );
  }

  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiryMs - 60000) {
    return cachedToken;
  }

  const assertion = createSignedJwt(config.vertexServiceAccount);
  const tokenUri = config.vertexServiceAccount.token_uri || "https://oauth2.googleapis.com/token";

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google OAuth2 token exchange failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  cachedTokenExpiryMs = now + (Number(data.expires_in) || 3600) * 1000;
  return cachedToken;
}

function isVertexModel(modelName, config) {
  if (!modelName || typeof modelName !== "string") return false;
  const normalized = modelName.trim().toLowerCase();
  if (
    normalized.startsWith("gemini-") ||
    normalized.startsWith("google/gemini-") ||
    normalized.startsWith("vertex/") ||
    normalized.startsWith("models/gemini-")
  ) {
    return true;
  }
  if (config.vertexConfigured && !config.upstreamApiKey) {
    return true;
  }
  return false;
}

function normalizeVertexModelId(modelName) {
  return String(modelName || "")
    .trim()
    .replace(/^(vertex\/|google\/|models\/|publishers\/google\/models\/)/i, "");
}

function buildVertexEndpoint(config, modelName, stream) {
  const modelId = normalizeVertexModelId(modelName);
  const location = (config.vertexLocation || "us-central1").trim();
  const projectId = config.vertexProjectId;
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";

  const host =
    location.toLowerCase() === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://${location}-aiplatform.googleapis.com`;

  return `${host}/v1beta1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(
    location
  )}/publishers/google/models/${encodeURIComponent(modelId)}:${method}`;
}

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function convertContentParts(content) {
  if (typeof content === "string") {
    return content ? [{ text: content }] : [{ text: " " }];
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (typeof item === "string" && item) {
        parts.push({ text: item });
      } else if (item && item.type === "text" && typeof item.text === "string") {
        parts.push({ text: item.text });
      } else if (item && item.type === "image_url" && item.image_url && item.image_url.url) {
        const url = item.image_url.url;
        const dataMatch = url.match(/^data:([^;]+);base64,(.+)$/);
        if (dataMatch) {
          parts.push({
            inlineData: {
              mimeType: dataMatch[1],
              data: dataMatch[2],
            },
          });
        }
      }
    }
    return parts.length > 0 ? parts : [{ text: " " }];
  }
  return [{ text: " " }];
}

function buildVertexRequestPayload(openAiBody, config) {
  const systemParts = [];
  const contents = [];

  const messages = Array.isArray(openAiBody.messages) ? openAiBody.messages : [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg.role || "user").toLowerCase();

    if (role === "system" || role === "developer") {
      const sysText = extractTextFromContent(msg.content);
      if (sysText.trim()) {
        systemParts.push({ text: sysText });
      }
      continue;
    }

    const vertexRole = role === "assistant" || role === "model" ? "model" : "user";
    const parts = convertContentParts(msg.content);

    // Merge consecutive messages with the same role (common in Janitor AI character + jailbreak prompts)
    const prev = contents[contents.length - 1];
    if (prev && prev.role === vertexRole) {
      prev.parts.push(...parts);
    } else {
      contents.push({ role: vertexRole, parts });
    }
  }

  // Vertex AI requires at least one user turn
  if (contents.length === 0) {
    contents.push({
      role: "user",
      parts: [{ text: systemParts.length > 0 ? "Please proceed." : "Hello" }],
    });
  } else if (contents[0].role === "model") {
    contents.unshift({
      role: "user",
      parts: [{ text: "[Start Conversation]" }],
    });
  }

  const generationConfig = {};
  if (typeof openAiBody.temperature === "number") {
    generationConfig.temperature = openAiBody.temperature;
  }
  if (typeof openAiBody.top_p === "number") {
    generationConfig.topP = openAiBody.top_p;
  }
  const maxTokens = openAiBody.max_completion_tokens ?? openAiBody.max_tokens;
  if (typeof maxTokens === "number" && maxTokens > 0) {
    generationConfig.maxOutputTokens = maxTokens;
  }
  if (openAiBody.stop) {
    const stops = Array.isArray(openAiBody.stop) ? openAiBody.stop : [openAiBody.stop];
    const cleanStops = stops.filter((s) => typeof s === "string" && s.length > 0).slice(0, 5);
    if (cleanStops.length > 0) {
      generationConfig.stopSequences = cleanStops;
    }
  }

  const threshold = config.vertexSafetyThreshold || "BLOCK_NONE";
  const safetySettings = HARM_CATEGORIES.map((category) => ({
    category,
    threshold,
  }));

  const payload = {
    contents,
    safetySettings,
  };

  if (systemParts.length > 0) {
    payload.systemInstruction = {
      role: "system",
      parts: systemParts,
    };
  }

  if (Object.keys(generationConfig).length > 0) {
    payload.generationConfig = generationConfig;
  }

  return payload;
}

function mapFinishReason(vertexReason) {
  if (!vertexReason) return null;
  switch (vertexReason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
      return "content_filter";
    default:
      return "stop";
  }
}

function extractVertexCandidateParts(vertexData) {
  const candidate = vertexData && Array.isArray(vertexData.candidates) ? vertexData.candidates[0] : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];

  let content = "";
  let reasoningContent = "";

  for (const part of parts) {
    if (!part || typeof part.text !== "string") continue;
    if (part.thought === true) {
      reasoningContent += part.text;
    } else {
      content += part.text;
    }
  }

  const finishReason = candidate && candidate.finishReason ? mapFinishReason(candidate.finishReason) : null;
  const promptFeedbackBlock =
    vertexData && vertexData.promptFeedback && vertexData.promptFeedback.blockReason
      ? vertexData.promptFeedback.blockReason
      : null;

  return {
    content,
    reasoningContent,
    finishReason,
    promptFeedbackBlock,
  };
}

function convertVertexResponseToOpenAI(vertexData, modelName) {
  const modelId = normalizeVertexModelId(modelName);
  const { content, reasoningContent, finishReason, promptFeedbackBlock } = extractVertexCandidateParts(vertexData);

  let finalContent = content;
  if (!finalContent && promptFeedbackBlock) {
    finalContent = `[Blocked by Vertex AI Prompt Feedback: ${promptFeedbackBlock}]`;
  }

  const message = {
    role: "assistant",
    content: finalContent || "",
  };

  if (reasoningContent) {
    message.reasoning_content = reasoningContent;
  }

  const usageMetadata = vertexData && vertexData.usageMetadata ? vertexData.usageMetadata : {};
  const promptTokens = usageMetadata.promptTokenCount || 0;
  const completionTokens =
    (usageMetadata.candidatesTokenCount || 0) + (usageMetadata.thoughtsTokenCount || 0);

  return {
    id: `chatcmpl-vertex-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason || "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: usageMetadata.totalTokenCount || promptTokens + completionTokens,
    },
  };
}

function convertVertexStreamChunkToOpenAISse(vertexChunk, modelName, streamId) {
  const modelId = normalizeVertexModelId(modelName);
  const { content, reasoningContent, finishReason } = extractVertexCandidateParts(vertexChunk);

  const delta = {};
  if (content) delta.content = content;
  if (reasoningContent) delta.reasoning_content = reasoningContent;

  // If neither content, reasoning, nor finishReason is present, skip emitting an empty chunk
  if (!delta.content && !delta.reasoning_content && !finishReason) {
    return "";
  }

  const chunkObj = {
    id: streamId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason || null,
      },
    ],
  };

  if (vertexChunk && vertexChunk.usageMetadata) {
    const u = vertexChunk.usageMetadata;
    chunkObj.usage = {
      prompt_tokens: u.promptTokenCount || 0,
      completion_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      total_tokens: u.totalTokenCount || 0,
    };
  }

  return `data: ${JSON.stringify(chunkObj)}\n\n`;
}

async function fetchVertexWithRetry(config, openAiBody) {
  const stream = Boolean(openAiBody.stream);
  const url = buildVertexEndpoint(config, openAiBody.model, stream);
  const payload = buildVertexRequestPayload(openAiBody, config);

  let lastError;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const token = await getVertexAccessToken(config);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });

      // If 401, invalidate token cache once and retry
      if (response.status === 401 && attempt < config.maxRetries) {
        cachedToken = null;
        cachedTokenExpiryMs = 0;
        continue;
      }

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

  throw lastError || new Error("Vertex AI request failed after retries");
}

function pipeVertexSseToOpenAiSse(vertexWebStream, modelName, rewriter, res, onDone, onError) {
  const reader = Readable.fromWeb(vertexWebStream);
  const streamId = `chatcmpl-vertex-${Date.now()}`;
  let buffer = "";

  // Send initial role chunk for strict OpenAI SSE clients (like Janitor AI)
  const initialChunk = {
    id: streamId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: normalizeVertexModelId(modelName),
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  };
  res.write(rewriter.feed(`data: ${JSON.stringify(initialChunk)}\n\n`));

  reader.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const rawJson = trimmed.slice(5).trim();
      if (!rawJson || rawJson === "[DONE]") continue;

      try {
        const vertexObj = JSON.parse(rawJson);
        const openAiSse = convertVertexStreamChunkToOpenAISse(vertexObj, modelName, streamId);
        if (openAiSse) {
          res.write(rewriter.feed(openAiSse));
        }
      } catch {
        // Ignore partial line
      }
    }
  });

  reader.on("end", () => {
    if (buffer.trim().startsWith("data:")) {
      const rawJson = buffer.trim().slice(5).trim();
      try {
        const vertexObj = JSON.parse(rawJson);
        const openAiSse = convertVertexStreamChunkToOpenAISse(vertexObj, modelName, streamId);
        if (openAiSse) {
          res.write(rewriter.feed(openAiSse));
        }
      } catch {}
    }
    res.write(rewriter.feed("data: [DONE]\n\n"));
    res.write(rewriter.flush());
    res.end();
    onDone();
  });

  reader.on("error", (err) => {
    onError(err);
  });

  return reader;
}

module.exports = {
  VERTEX_GEMINI_MODELS,
  isVertexModel,
  normalizeVertexModelId,
  fetchVertexWithRetry,
  convertVertexResponseToOpenAI,
  pipeVertexSseToOpenAiSse,
};

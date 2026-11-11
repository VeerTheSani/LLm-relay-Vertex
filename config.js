const fs = require("fs");
const path = require("path");

function csv(value) {
  return (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function int(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function findRenderSecretJsonFile() {
  const renderSecretsDir = "/etc/secrets";
  try {
    if (fs.existsSync(renderSecretsDir) && fs.statSync(renderSecretsDir).isDirectory()) {
      const files = fs.readdirSync(renderSecretsDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          return path.join(renderSecretsDir, file);
        }
      }
    }
  } catch {
    // Ignore if /etc/secrets is not accessible
  }
  return null;
}

function parseKeyValueString(text) {
  const result = {};
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim().toLowerCase();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  if (result.private_key && result.client_email) {
    return result;
  }
  return null;
}

function parseDirectEnvFields() {
  const privateKey =
    process.env.private_key ||
    process.env.PRIVATE_KEY ||
    process.env.VERTEX_PRIVATE_KEY ||
    process.env.GOOGLE_PRIVATE_KEY;
  const clientEmail =
    process.env.client_email ||
    process.env.CLIENT_EMAIL ||
    process.env.VERTEX_CLIENT_EMAIL ||
    process.env.GOOGLE_CLIENT_EMAIL;
  const projectId =
    process.env.project_id ||
    process.env.PROJECT_ID ||
    process.env.VERTEX_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT;

  if (privateKey && clientEmail) {
    return {
      type: process.env.type || process.env.TYPE || "service_account",
      project_id: projectId || "",
      private_key_id: process.env.private_key_id || process.env.PRIVATE_KEY_ID || "",
      private_key: privateKey,
      client_email: clientEmail,
      client_id: process.env.client_id || process.env.CLIENT_ID || "",
      auth_uri: process.env.auth_uri || process.env.AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
      token_uri: process.env.token_uri || process.env.TOKEN_URI || "https://oauth2.googleapis.com/token",
      universe_domain: process.env.universe_domain || process.env.UNIVERSE_DOMAIN || "googleapis.com",
    };
  }
  return null;
}

function parseServiceAccountCredentials(rawJsonEnv, credentialsFileEnv) {
  // 0. Check individual environment variables (e.g. project_id=..., private_key=..., client_email=...)
  const directFields = parseDirectEnvFields();
  if (directFields) {
    return { credentials: directFields, source: "env_fields" };
  }

  const autoDetectedSecretFile = findRenderSecretJsonFile();
  const candidates = [rawJsonEnv, credentialsFileEnv, autoDetectedSecretFile].filter(Boolean);

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;

    // 1. Direct JSON object string
    if (trimmed.startsWith("{")) {
      try {
        return { credentials: JSON.parse(trimmed), source: "env_json" };
      } catch (err) {
        console.error("Failed to parse inline Service Account JSON:", err.message);
      }
    }

    // 2. Key=Value format (type=service_account \n project_id=... \n private_key=...)
    const kvParsed = parseKeyValueString(trimmed);
    if (kvParsed) {
      return { credentials: kvParsed, source: "env_key_value" };
    }

    // 3. File path on disk (e.g. Render Secret File /etc/secrets/<filename>.json)
    const possiblePaths = [
      trimmed,
      path.join("/etc/secrets", path.basename(trimmed)),
      path.resolve(process.cwd(), trimmed),
    ];

    for (const filePath of possiblePaths) {
      try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const fileContent = fs.readFileSync(filePath, "utf8").trim();
          if (fileContent.startsWith("{")) {
            return { credentials: JSON.parse(fileContent), source: `file:${filePath}` };
          }
          const fileKv = parseKeyValueString(fileContent);
          if (fileKv) {
            return { credentials: fileKv, source: `file_kv:${filePath}` };
          }
        }
      } catch {
        // Continue checking next path
      }
    }

    // 4. Base64-encoded JSON string
    try {
      const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
      if (decoded.startsWith("{")) {
        return { credentials: JSON.parse(decoded), source: "env_base64" };
      }
    } catch {
      // Ignore base64 decode failure
    }
  }

  return { credentials: null, source: "none" };
}

const parsedVertex = parseServiceAccountCredentials(
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.VERTEX_SERVICE_ACCOUNT_JSON,
  process.env.GOOGLE_APPLICATION_CREDENTIALS
);

const serviceAccount = parsedVertex.credentials;
if (serviceAccount && typeof serviceAccount.private_key === "string") {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}

const config = {
  port: int(process.env.PORT, 3000),
  upstreamBaseUrl: (process.env.UPSTREAM_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
  upstreamApiKey: process.env.UPSTREAM_API_KEY || "",
  proxyKeys: csv(process.env.PROXY_KEYS),
  reasoningMode: (process.env.REASONING_MODE || "hide").toLowerCase(),
  modelOverride: process.env.MODEL_OVERRIDE || "",
  modelAllowlist: csv(process.env.MODEL_ALLOWLIST),
  rateLimitPerMin: int(process.env.RATE_LIMIT_PER_MIN, 0),
  requestTimeoutMs: int(process.env.REQUEST_TIMEOUT_MS, 120000),
  maxRetries: int(process.env.MAX_RETRIES, 2),
  allowedOrigins: csv(process.env.ALLOWED_ORIGINS),
  bodyLimit: process.env.BODY_LIMIT || "50mb",

  // Google Cloud Vertex AI configuration
  vertexServiceAccount: serviceAccount,
  vertexCredentialSource: parsedVertex.source,
  vertexProjectId:
    process.env.VERTEX_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.project_id ||
    process.env.PROJECT_ID ||
    (serviceAccount && serviceAccount.project_id) ||
    "",
  vertexLocation: (process.env.VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || "global").trim(),
  vertexSafetyThreshold: (process.env.VERTEX_SAFETY_THRESHOLD || "BLOCK_NONE").trim().toUpperCase(),
};

config.vertexConfigured = Boolean(
  config.vertexServiceAccount &&
    config.vertexServiceAccount.client_email &&
    config.vertexServiceAccount.private_key &&
    config.vertexProjectId
);

const VALID_REASONING_MODES = ["hide", "show", "passthrough"];

if (!VALID_REASONING_MODES.includes(config.reasoningMode)) {
  console.error(`Invalid REASONING_MODE "${config.reasoningMode}". Valid values: ${VALID_REASONING_MODES.join(", ")}`);
  process.exit(1);
}

if (!config.vertexConfigured && !config.upstreamApiKey) {
  console.warn(
    "Warning: Neither Vertex AI credentials nor UPSTREAM_API_KEY is set. Requests will fail until credentials are configured."
  );
}

if (config.proxyKeys.length === 0) {
  console.warn("Warning: PROXY_KEYS is not set. The gateway will accept requests from anyone.");
}

module.exports = config;

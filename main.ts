// main.ts — the best free AI model aggregator.
//
// One server, two APIs, ten simulated free-tier providers. It serves the
// OpenAI Chat Completions API and the Anthropic Messages API, in JSON and in
// server-sent events, routing each request to the best free model that can
// serve it, failing over when a provider refuses, and reporting the catalog
// it read from the providers' own catalog routes.
//
//   node main.ts            start the server, register with the env, serve
//                           the trial's 20 requests, exit 0 when done
//   node main.ts --list     print the catalog document and exit 0
//
// Node 22, standard library only, no network but the env. Deterministic:
// every choice comes from the brief, the requests and the providers'
// answers. No wall clock and no unseeded randomness anywhere in an output.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const FIXED_CREATED = 1767225600;
const ANTHROPIC_VERSION = "2023-06-01";
const SSE_DELTA_CHARS = 13;
const PROVIDER_TIMEOUT_MS = 20000;
const WORK_POLL_MS = 200;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types (erasable TypeScript only: interfaces and annotations, no enums).
// ---------------------------------------------------------------------------

interface ModelCap {
  id: string;
  free: boolean;
  context_length: number | null;
  tools: boolean;
  vision: boolean;
  json: boolean;
  rating_milli: number;
}

interface ProviderDir {
  id: string;
  name: string;
  wire: "openai" | "anthropic" | "gemini";
  auth: "bearer" | "x-api-key" | "x-goog-api-key" | "none";
  key_env: string;
  key: string;
  path: string;
  base_url: string;
}

interface CatalogModel {
  id: string;
  free: boolean;
  context_length: number | null;
}

interface CatalogProvider {
  id: string;
  base_url: string;
  key_env: string;
  wire: "openai" | "anthropic" | "gemini";
  models: CatalogModel[];
}

interface Catalog {
  providers: CatalogProvider[];
}

interface Requires {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

interface ManifestRequest {
  id: string;
  api: "openai" | "anthropic";
  stream: boolean;
  weight: number;
  requires: Requires;
}

interface Candidate {
  provider: ProviderDir;
  model: ModelCap;
}

interface ProviderAnswer {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stop: string;
}

interface FailedAttempt {
  provider: string;
  status: number;
  retryAfter: number | null;
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function splitText(text: string): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += SSE_DELTA_CHARS) {
    pieces.push(text.slice(at, at + SSE_DELTA_CHARS));
  }
  return pieces.length === 0 ? [""] : pieces;
}

function sseFrame(event: string | null, data: unknown): string {
  const head = event === null ? "" : `event: ${event}\n`;
  return `${head}data: ${JSON.stringify(data)}\n\n`;
}

// Extract one JSON document from a text file: find the schema marker, walk
// back to the object that holds it, then scan forward with brace counting
// (respecting strings and escapes) to the matching close brace.
function extractJsonDoc(text: string, schema: string): unknown | null {
  const marker = `"schema":"${schema}"`;
  const at = text.indexOf(marker);
  if (at === -1) return null;
  let start = text.lastIndexOf("{", at);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] as string;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The brief: provider directory, quality table and workload manifest.
// ---------------------------------------------------------------------------

interface Brief {
  providers: ProviderDir[];
  ratings: ModelCap[]; // keyed by provider through a parallel map below
  ratingsByProvider: Map<string, ModelCap[]>;
  manifest: ManifestRequest[];
}

function readBrief(promptFile: string | undefined): Brief {
  const empty: Brief = {
    providers: [],
    ratings: [],
    ratingsByProvider: new Map(),
    manifest: [],
  };
  if (!promptFile) return empty;
  let text: string;
  try {
    text = readFileSync(promptFile, "utf8");
  } catch {
    return empty;
  }
  const providersDoc = extractJsonDoc(text, "free-model-aggregator-01/providers/v1");
  const ratingsDoc = extractJsonDoc(text, "free-model-aggregator-01/ratings/v1");
  const workloadDoc = extractJsonDoc(text, "free-model-aggregator-01/workload/v1");

  if (isRecord(providersDoc) && Array.isArray(providersDoc.providers)) {
    for (const raw of providersDoc.providers as unknown[]) {
      if (!isRecord(raw)) continue;
      const wire = raw.wire;
      if (wire !== "openai" && wire !== "anthropic" && wire !== "gemini") continue;
      const auth = raw.auth;
      if (auth !== "bearer" && auth !== "x-api-key" && auth !== "x-goog-api-key" && auth !== "none") continue;
      empty.providers.push({
        id: asString(raw.id),
        name: asString(raw.name),
        wire,
        auth,
        key_env: asString(raw.key_env),
        key: asString(raw.key),
        path: asString(raw.path),
        base_url: asString(raw.path),
      });
    }
  }
  if (isRecord(ratingsDoc) && Array.isArray(ratingsDoc.ratings)) {
    for (const raw of ratingsDoc.ratings as unknown[]) {
      if (!isRecord(raw)) continue;
      const cap: ModelCap = {
        id: asString(raw.model),
        free: raw.free === true,
        context_length: numOrNull(raw.context_length),
        tools: raw.tools === true,
        vision: raw.vision === true,
        json: raw.json === true,
        rating_milli: typeof raw.rating_milli === "number" ? raw.rating_milli : 0,
      };
      empty.ratings.push(cap);
      const list = empty.ratingsByProvider.get(asString(raw.provider)) ?? [];
      list.push(cap);
      empty.ratingsByProvider.set(asString(raw.provider), list);
    }
  }
  if (isRecord(workloadDoc) && Array.isArray(workloadDoc.manifest)) {
    for (const raw of workloadDoc.manifest as unknown[]) {
      if (!isRecord(raw)) continue;
      const api = raw.api === "anthropic" ? "anthropic" : "openai";
      const req: Requires = {};
      if (isRecord(raw.requires)) {
        if (raw.requires.tools === true) req.tools = true;
        if (raw.requires.vision === true) req.vision = true;
        if (raw.requires.json === true) req.json = true;
        if (typeof raw.requires.min_context === "number") req.min_context = raw.requires.min_context;
      }
      empty.manifest.push({
        id: asString(raw.id),
        api,
        stream: raw.stream === true,
        weight: typeof raw.weight === "number" ? raw.weight : 1,
        requires: req,
      });
    }
  }
  return empty;
}

// ---------------------------------------------------------------------------
// The env: /instance gives absolute base URLs and the manifest.
// ---------------------------------------------------------------------------

async function fetchInstance(envUrl: string): Promise<{ providers: ProviderDir[]; manifest: ManifestRequest[] }> {
  const out: { providers: ProviderDir[]; manifest: ManifestRequest[] } = { providers: [], manifest: [] };
  let res: Response;
  try {
    res = await fetch(`${envUrl}/instance`, { signal: AbortSignal.timeout(10000) });
  } catch {
    return out;
  }
  if (!res.ok) return out;
  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    return out;
  }
  if (!isRecord(doc)) return out;
  if (Array.isArray(doc.providers)) {
    for (const raw of doc.providers as unknown[]) {
      if (!isRecord(raw)) continue;
      const wire = raw.wire;
      if (wire !== "openai" && wire !== "anthropic" && wire !== "gemini") continue;
      const auth = raw.auth;
      if (auth !== "bearer" && auth !== "x-api-key" && auth !== "x-goog-api-key" && auth !== "none") continue;
      const base = asString(raw.base_url);
      const path = base.replace(/^https?:\/\/[^/]+/, "");
      out.providers.push({
        id: asString(raw.id),
        name: asString(raw.name),
        wire,
        auth,
        key_env: asString(raw.key_env),
        key: asString(raw.key),
        path,
        base_url: base,
      });
    }
  }
  if (isRecord(doc.workload) && Array.isArray(doc.workload.manifest)) {
    for (const raw of doc.workload.manifest as unknown[]) {
      if (!isRecord(raw)) continue;
      const req: Requires = {};
      if (isRecord(raw.requires)) {
        if (raw.requires.tools === true) req.tools = true;
        if (raw.requires.vision === true) req.vision = true;
        if (raw.requires.json === true) req.json = true;
        if (typeof raw.requires.min_context === "number") req.min_context = raw.requires.min_context;
      }
      out.manifest.push({
        id: asString(raw.id),
        api: raw.api === "anthropic" ? "anthropic" : "openai",
        stream: raw.stream === true,
        weight: typeof raw.weight === "number" ? raw.weight : 1,
        requires: req,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The catalog: probe every provider's own catalog route.
// ---------------------------------------------------------------------------

function authHeaders(p: ProviderDir): Record<string, string> {
  if (p.auth === "bearer") return { authorization: `Bearer ${p.key}` };
  if (p.auth === "x-api-key") return { "x-api-key": p.key };
  if (p.auth === "x-goog-api-key") return { "x-goog-api-key": p.key };
  return {};
}

async function probeCatalog(p: ProviderDir): Promise<CatalogModel[] | null> {
  const url =
    p.wire === "gemini"
      ? `${p.base_url}/v1beta/models`
      : `${p.base_url}/v1/models`;
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders(p), signal: AbortSignal.timeout(10000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  const models: CatalogModel[] = [];
  if (p.wire === "gemini") {
    if (!Array.isArray(doc.models)) return null;
    for (const raw of doc.models as unknown[]) {
      if (!isRecord(raw)) continue;
      const name = asString(raw.name);
      const id = name.startsWith("models/") ? name.slice("models/".length) : name;
      if (id === "") continue;
      models.push({
        id,
        free: raw.free === true,
        context_length: numOrNull(raw.inputTokenLimit) ?? numOrNull(raw.context_length),
      });
    }
    return models;
  }
  if (!Array.isArray(doc.data)) return null;
  for (const raw of doc.data as unknown[]) {
    if (!isRecord(raw)) continue;
    const id = asString(raw.id);
    if (id === "") continue;
    models.push({
      id,
      free: raw.free === true,
      context_length: numOrNull(raw.context_length),
    });
  }
  return models;
}

async function buildCatalog(providers: ProviderDir[], brief: Brief): Promise<Catalog> {
  const catalog: Catalog = { providers: [] };
  for (const p of providers) {
    let models = await probeCatalog(p);
    if (models === null) {
      // Fall back to the brief's quality table: the free models it names.
      const caps = brief.ratingsByProvider.get(p.id) ?? [];
      models = caps
        .filter((c) => c.free)
        .map((c) => ({ id: c.id, free: true, context_length: c.context_length }));
    }
    catalog.providers.push({
      id: p.id,
      base_url: p.path,
      key_env: p.key_env,
      wire: p.wire,
      models,
    });
  }
  return catalog;
}

// ---------------------------------------------------------------------------
// Request translation: client body -> provider wire.
// ---------------------------------------------------------------------------

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as unknown[]) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function hasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const block of content as unknown[]) {
    if (!isRecord(block)) continue;
    if (block.type === "image_url" || block.type === "image") return true;
  }
  return false;
}

function parseDataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m === null) return null;
  return { mime: m[1] as string, data: m[2] as string };
}

// OpenAI messages -> Anthropic messages (system lifted out).
function openAiMessagesToAnthropic(body: Record<string, unknown>): { system: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const messages: unknown[] = [];
  const raw = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  for (const msg of raw) {
    if (!isRecord(msg)) continue;
    if (msg.role === "system") {
      const t = textOfContent(msg.content);
      if (t !== "") systemParts.push(t);
      continue;
    }
    const blocks: unknown[] = [];
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "image_url" && isRecord(block.image_url)) {
          const url = asString(block.image_url.url);
          const parsed = parseDataUrl(url);
          if (parsed !== null) {
            blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mime, data: parsed.data } });
          } else {
            blocks.push({ type: "image", source: { type: "url", url } });
          }
        }
      }
    } else if (typeof msg.content === "string") {
      blocks.push({ type: "text", text: msg.content });
    }
    messages.push({ role: msg.role === "assistant" ? "assistant" : "user", content: blocks });
  }
  return { system: systemParts.join("\n"), messages };
}

// Anthropic messages -> OpenAI messages (system folded in as a message).
function anthropicMessagesToOpenAi(body: Record<string, unknown>): unknown[] {
  const messages: unknown[] = [];
  const systemText = textOfContent(body.system);
  if (systemText !== "") messages.push({ role: "system", content: systemText });
  const raw = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  for (const msg of raw) {
    if (!isRecord(msg)) continue;
    const blocks: unknown[] = [];
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "image" && isRecord(block.source)) {
          if (block.source.type === "base64" && typeof block.source.data === "string") {
            const mime = asString(block.source.media_type) || "image/png";
            blocks.push({
              type: "image_url",
              image_url: { url: `data:${mime};base64,${block.source.data}` },
            });
          } else if (block.source.type === "url" && typeof block.source.url === "string") {
            blocks.push({ type: "image_url", image_url: { url: block.source.url } });
          }
        }
      }
    } else if (typeof msg.content === "string") {
      blocks.push({ type: "text", text: msg.content });
    }
    messages.push({ role: msg.role === "assistant" ? "assistant" : "user", content: blocks });
  }
  return messages;
}

function openAiToolsToAnthropic(body: Record<string, unknown>): unknown[] | undefined {
  if (!Array.isArray(body.tools)) return undefined;
  const out: unknown[] = [];
  for (const tool of body.tools as unknown[]) {
    if (!isRecord(tool) || !isRecord(tool.function)) continue;
    out.push({
      name: asString(tool.function.name),
      description: asString(tool.function.description),
      input_schema: isRecord(tool.function.parameters) ? tool.function.parameters : { type: "object" },
    });
  }
  return out.length > 0 ? out : undefined;
}

function anthropicToolsToOpenAi(body: Record<string, unknown>): unknown[] | undefined {
  if (!Array.isArray(body.tools)) return undefined;
  const out: unknown[] = [];
  for (const tool of body.tools as unknown[]) {
    if (!isRecord(tool)) continue;
    out.push({
      type: "function",
      function: {
        name: asString(tool.name),
        description: asString(tool.description),
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object" },
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

function openAiToolsToGemini(body: Record<string, unknown>): unknown[] | undefined {
  const fns: unknown[] = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools as unknown[]) {
      if (!isRecord(tool) || !isRecord(tool.function)) continue;
      fns.push({
        name: asString(tool.function.name),
        description: asString(tool.function.description),
        parameters: isRecord(tool.function.parameters) ? tool.function.parameters : { type: "object" },
      });
    }
  }
  return fns.length > 0 ? [{ functionDeclarations: fns }] : undefined;
}

function anthropicToolsToGemini(body: Record<string, unknown>): unknown[] | undefined {
  const fns: unknown[] = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools as unknown[]) {
      if (!isRecord(tool)) continue;
      fns.push({
        name: asString(tool.name),
        description: asString(tool.description),
        parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object" },
      });
    }
  }
  return fns.length > 0 ? [{ functionDeclarations: fns }] : undefined;
}

function maxTokensOf(body: Record<string, unknown>): number | null {
  const v = numOrNull(body.max_tokens) ?? numOrNull(body.max_completion_tokens);
  return v;
}

function stopsOf(body: Record<string, unknown>): string[] {
  const raw = body.stop ?? body.stop_sequences;
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  return [];
}

interface ProviderCall {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

function providerCallFor(
  provider: ProviderDir,
  clientApi: "openai" | "anthropic",
  body: Record<string, unknown>,
  model: string,
  stream: boolean,
): ProviderCall {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...authHeaders(provider),
  };
  const maxTokens = maxTokensOf(body);
  const stops = stopsOf(body);
  if (provider.wire === "openai") {
    let payload: Record<string, unknown>;
    if (clientApi === "openai") {
      payload = { ...body, model, stream };
      if (stream) payload.stream_options = { include_usage: true };
    } else {
      payload = {
        model,
        messages: anthropicMessagesToOpenAi(body),
        stream,
      };
      if (maxTokens !== null) payload.max_tokens = maxTokens;
      const tools = anthropicToolsToOpenAi(body);
      if (tools !== undefined) payload.tools = tools;
      if (stops.length > 0) payload.stop = stops;
      if (typeof body.temperature === "number") payload.temperature = body.temperature;
      if (stream) payload.stream_options = { include_usage: true };
    }
    return { url: `${provider.base_url}/v1/chat/completions`, headers, payload };
  }
  if (provider.wire === "anthropic") {
    let payload: Record<string, unknown>;
    if (clientApi === "anthropic") {
      payload = { ...body, model, stream };
    } else {
      const converted = openAiMessagesToAnthropic(body);
      payload = { model, messages: converted.messages, stream };
      if (converted.system !== "") payload.system = converted.system;
      if (maxTokens !== null) payload.max_tokens = maxTokens;
      const tools = openAiToolsToAnthropic(body);
      if (tools !== undefined) payload.tools = tools;
      if (stops.length > 0) payload.stop_sequences = stops;
      if (typeof body.temperature === "number") payload.temperature = body.temperature;
    }
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    return { url: `${provider.base_url}/v1/messages`, headers, payload };
  }
  // Gemini wire.
  const contents: unknown[] = [];
  let systemInstruction: unknown = undefined;
  const pushParts = (content: unknown): unknown[] => {
    const parts: unknown[] = [];
    if (typeof content === "string") {
      if (content !== "") parts.push({ text: content });
      return parts;
    }
    if (!Array.isArray(content)) return parts;
    for (const block of content as unknown[]) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ text: block.text });
      } else if (block.type === "image_url" && isRecord(block.image_url)) {
        const url = asString(block.image_url.url);
        const parsed = parseDataUrl(url);
        if (parsed !== null) {
          parts.push({ inlineData: { mimeType: parsed.mime, data: parsed.data } });
        } else {
          parts.push({ fileData: { fileUri: url } });
        }
      } else if (block.type === "image" && isRecord(block.source)) {
        if (block.source.type === "base64" && typeof block.source.data === "string") {
          parts.push({
            inlineData: { mimeType: asString(block.source.media_type) || "image/png", data: block.source.data },
          });
        } else if (block.source.type === "url" && typeof block.source.url === "string") {
          parts.push({ fileData: { fileUri: block.source.url } });
        }
      }
    }
    return parts;
  };
  if (clientApi === "openai") {
    const raw = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
    for (const msg of raw) {
      if (!isRecord(msg)) continue;
      if (msg.role === "system") {
        const parts = pushParts(msg.content);
        if (parts.length > 0) systemInstruction = { parts };
        continue;
      }
      const parts = pushParts(msg.content);
      contents.push({ role: msg.role === "assistant" ? "model" : "user", parts });
    }
  } else {
    const systemText = textOfContent(body.system);
    if (systemText !== "") systemInstruction = { parts: [{ text: systemText }] };
    const raw = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
    for (const msg of raw) {
      if (!isRecord(msg)) continue;
      const parts = pushParts(msg.content);
      contents.push({ role: msg.role === "assistant" ? "model" : "user", parts });
    }
  }
  const generationConfig: Record<string, unknown> = {};
  if (maxTokens !== null) generationConfig.maxOutputTokens = maxTokens;
  if (stops.length > 0) generationConfig.stopSequences = stops;
  if (typeof body.temperature === "number") generationConfig.temperature = body.temperature;
  const wantsJson =
    clientApi === "openai" &&
    isRecord(body.response_format) &&
    (body.response_format.type === "json_object" || body.response_format.type === "json_schema");
  if (wantsJson) generationConfig.responseMimeType = "application/json";
  const payload: Record<string, unknown> = { contents, generationConfig };
  if (systemInstruction !== undefined) payload.systemInstruction = systemInstruction;
  const tools = clientApi === "openai" ? openAiToolsToGemini(body) : anthropicToolsToGemini(body);
  if (tools !== undefined) payload.tools = tools;
  const encoded = encodeURIComponent(model);
  const url = stream
    ? `${provider.base_url}/v1beta/models/${encoded}:streamGenerateContent`
    : `${provider.base_url}/v1beta/models/${encoded}:generateContent`;
  return { url, headers, payload };
}

// ---------------------------------------------------------------------------
// Provider answers: parse one wire's reply into a common shape.
// ---------------------------------------------------------------------------

function parseSseText(text: string): { event: string | null; data: string }[] {
  const frames: { event: string | null; data: string }[] = [];
  const normalized = text.replace(/\r\n/g, "\n");
  for (const frame of normalized.split("\n\n")) {
    if (frame.trim() === "") continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
    }
    if (data.length > 0) frames.push({ event, data: data.join("\n") });
  }
  return frames;
}

function parseProviderAnswer(wire: "openai" | "anthropic" | "gemini", stream: boolean, text: string): ProviderAnswer | null {
  if (wire === "openai") {
    if (!stream) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return null;
      }
      if (!isRecord(value) || !Array.isArray(value.choices) || value.choices.length === 0) return null;
      const choice = value.choices[0] as unknown;
      if (!isRecord(choice) || !isRecord(choice.message)) return null;
      const usage = isRecord(value.usage) ? value.usage : {};
      return {
        text: textOfContent(choice.message.content),
        inputTokens: numOrNull(usage.prompt_tokens),
        outputTokens: numOrNull(usage.completion_tokens),
        stop: asString(choice.finish_reason) || "stop",
      };
    }
    let full = "";
    let input: number | null = null;
    let output: number | null = null;
    let stop = "stop";
    for (const frame of parseSseText(text)) {
      if (frame.data.trim() === "[DONE]") continue;
      let chunk: unknown;
      try {
        chunk = JSON.parse(frame.data);
      } catch {
        return null;
      }
      if (!isRecord(chunk)) return null;
      if (isRecord(chunk.usage)) {
        input = numOrNull(chunk.usage.prompt_tokens) ?? input;
        output = numOrNull(chunk.usage.completion_tokens) ?? output;
      }
      if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;
      const choice = chunk.choices[0] as unknown;
      if (!isRecord(choice)) return null;
      if (isRecord(choice.delta) && typeof choice.delta.content === "string") full += choice.delta.content;
      if (typeof choice.finish_reason === "string") stop = choice.finish_reason;
    }
    return { text: full, inputTokens: input, outputTokens: output, stop };
  }
  if (wire === "anthropic") {
    if (!stream) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return null;
      }
      if (!isRecord(value) || !Array.isArray(value.content)) return null;
      const usage = isRecord(value.usage) ? value.usage : {};
      return {
        text: textOfContent(value.content),
        inputTokens: numOrNull(usage.input_tokens),
        outputTokens: numOrNull(usage.output_tokens),
        stop: asString(value.stop_reason) || "end_turn",
      };
    }
    let full = "";
    let input: number | null = null;
    let output: number | null = null;
    let stop = "end_turn";
    for (const frame of parseSseText(text)) {
      let data: unknown;
      try {
        data = JSON.parse(frame.data);
      } catch {
        return null;
      }
      if (!isRecord(data)) return null;
      if (frame.event === "message_start" && isRecord(data.message) && isRecord(data.message.usage)) {
        input = numOrNull(data.message.usage.input_tokens);
      } else if (frame.event === "content_block_delta" && isRecord(data.delta) && data.delta.type === "text_delta") {
        if (typeof data.delta.text === "string") full += data.delta.text;
      } else if (frame.event === "message_delta") {
        if (isRecord(data.delta) && typeof data.delta.stop_reason === "string") stop = data.delta.stop_reason;
        if (isRecord(data.usage)) output = numOrNull(data.usage.output_tokens);
      }
    }
    return { text: full, inputTokens: input, outputTokens: output, stop };
  }
  // Gemini wire.
  if (!stream) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    if (!isRecord(value) || !Array.isArray(value.candidates) || value.candidates.length === 0) return null;
    const cand = value.candidates[0] as unknown;
    if (!isRecord(cand) || !isRecord(cand.content)) return null;
    const parts = Array.isArray(cand.content.parts) ? (cand.content.parts as unknown[]) : [];
    const textParts: string[] = [];
    for (const part of parts) {
      if (isRecord(part) && typeof part.text === "string") textParts.push(part.text);
    }
    const usage = isRecord(value.usageMetadata) ? value.usageMetadata : {};
    return {
      text: textParts.join(""),
      inputTokens: numOrNull(usage.promptTokenCount),
      outputTokens: numOrNull(usage.candidatesTokenCount),
      stop: asString(cand.finishReason) || "STOP",
    };
  }
  let full = "";
  let input: number | null = null;
  let output: number | null = null;
  let stop = "STOP";
  for (const frame of parseSseText(text)) {
    let data: unknown;
    try {
      data = JSON.parse(frame.data);
    } catch {
      return null;
    }
    if (!isRecord(data) || !Array.isArray(data.candidates) || data.candidates.length === 0) continue;
    const cand = data.candidates[0] as unknown;
    if (!isRecord(cand)) continue;
    if (isRecord(cand.content) && Array.isArray(cand.content.parts)) {
      for (const part of cand.content.parts as unknown[]) {
        if (isRecord(part) && typeof part.text === "string") full += part.text;
      }
    }
    if (typeof cand.finishReason === "string") stop = cand.finishReason;
    if (isRecord(data.usageMetadata)) {
      input = numOrNull(data.usageMetadata.promptTokenCount) ?? input;
      output = numOrNull(data.usageMetadata.candidatesTokenCount) ?? output;
    }
  }
  return { text: full, inputTokens: input, outputTokens: output, stop };
}

// ---------------------------------------------------------------------------
// Client answers: render the provider's answer in the client's wire.
// ---------------------------------------------------------------------------

function openAiJsonAnswer(model: string, a: ProviderAnswer): string {
  return JSON.stringify({
    id: "chatcmpl-sim",
    object: "chat.completion",
    created: FIXED_CREATED,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: a.text },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: a.inputTokens ?? 0,
      completion_tokens: a.outputTokens ?? 0,
      total_tokens: (a.inputTokens ?? 0) + (a.outputTokens ?? 0),
    },
  });
}

function openAiStreamAnswer(model: string, a: ProviderAnswer): string {
  const chunk = (delta: unknown, finish: string | null): unknown => ({
    id: "chatcmpl-sim",
    object: "chat.completion.chunk",
    created: FIXED_CREATED,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const frames = [sseFrame(null, chunk({ role: "assistant", content: "" }, null))];
  for (const piece of splitText(a.text)) frames.push(sseFrame(null, chunk({ content: piece }, null)));
  frames.push(sseFrame(null, chunk({}, "stop")));
  frames.push(
    sseFrame(null, {
      id: "chatcmpl-sim",
      object: "chat.completion.chunk",
      created: FIXED_CREATED,
      model,
      choices: [],
      usage: {
        prompt_tokens: a.inputTokens ?? 0,
        completion_tokens: a.outputTokens ?? 0,
        total_tokens: (a.inputTokens ?? 0) + (a.outputTokens ?? 0),
      },
    }),
  );
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

function anthropicJsonAnswer(model: string, a: ProviderAnswer): string {
  return JSON.stringify({
    id: "msg_sim",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: a.text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: a.inputTokens ?? 0, output_tokens: a.outputTokens ?? 0 },
  });
}

function anthropicStreamAnswer(model: string, a: ProviderAnswer): string {
  const frames = [
    sseFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_sim",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: a.inputTokens ?? 0, output_tokens: 0 },
      },
    }),
    sseFrame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ];
  for (const piece of splitText(a.text)) {
    frames.push(
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: piece },
      }),
    );
  }
  frames.push(
    sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: a.outputTokens ?? 0 },
    }),
    sseFrame("message_stop", { type: "message_stop" }),
  );
  return frames.join("");
}

// ---------------------------------------------------------------------------
// Routing: rank candidates, fail over, honor retry-after.
// ---------------------------------------------------------------------------

function meetsRequirements(cap: ModelCap, req: Requires): boolean {
  if (req.tools === true && !cap.tools) return false;
  if (req.vision === true && !cap.vision) return false;
  if (req.json === true && !cap.json) return false;
  if (req.min_context !== undefined && (cap.context_length === null || cap.context_length < req.min_context)) return false;
  return true;
}

function inferRequires(clientApi: "openai" | "anthropic", body: Record<string, unknown>): Requires {
  const req: Requires = {};
  if (Array.isArray(body.tools) && body.tools.length > 0) req.tools = true;
  const raw = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
  let longestText = 0;
  for (const msg of raw) {
    if (!isRecord(msg)) continue;
    if (hasImage(msg.content)) req.vision = true;
    const t = textOfContent(msg.content);
    if (t.length > longestText) longestText = t.length;
  }
  if (clientApi === "openai") {
    if (isRecord(body.response_format) && (body.response_format.type === "json_object" || body.response_format.type === "json_schema")) {
      req.json = true;
    }
  } else {
    const allText = raw.map((m) => (isRecord(m) ? textOfContent(m.content) : "")).join("\n");
    if (/JSON object/i.test(allText)) req.json = true;
  }
  if (longestText > 5000) req.min_context = 200000;
  return req;
}

class Router {
  private failStreak = new Map<string, number>();
  private catalog: Catalog;
  private brief: Brief;
  private providersById: Map<string, ProviderDir>;

  constructor(catalog: Catalog, brief: Brief, providers: ProviderDir[]) {
    this.catalog = catalog;
    this.brief = brief;
    this.providersById = new Map(providers.map((p) => [p.id, p]));
  }

  private capsOf(providerId: string): ModelCap[] {
    return this.brief.ratingsByProvider.get(providerId) ?? [];
  }

  // Candidates for a request, best rating first. Providers that failed three
  // calls in a row go last: their budget is spent or they are out, and
  // trying them first would only spend calls the tie-break counts.
  candidates(req: Requires, clientApi: "openai" | "anthropic", wantsJsonWire: boolean): Candidate[] {
    const out: Candidate[] = [];
    for (const entry of this.catalog.providers) {
      const provider = this.providersById.get(entry.id);
      if (provider === undefined) continue;
      if (wantsJsonWire && provider.wire === "anthropic") continue;
      for (const listed of entry.models) {
        if (!listed.free) continue;
        const cap = this.capsOf(entry.id).find((c) => c.id === listed.id);
        if (cap === undefined) continue;
        if (!meetsRequirements(cap, req)) continue;
        out.push({ provider, model: cap });
      }
    }
    const dead = (c: Candidate): number => ((this.failStreak.get(c.provider.id) ?? 0) >= 3 ? 1 : 0);
    out.sort((a, b) => {
      const d = dead(a) - dead(b);
      if (d !== 0) return d;
      const r = b.model.rating_milli - a.model.rating_milli;
      if (r !== 0) return r;
      const p = a.provider.id < b.provider.id ? -1 : a.provider.id > b.provider.id ? 1 : 0;
      if (p !== 0) return p;
      return a.model.id < b.model.id ? -1 : a.model.id > b.model.id ? 1 : 0;
    });
    return out;
  }

  private noteResult(providerId: string, ok: boolean): void {
    this.failStreak.set(providerId, ok ? 0 : (this.failStreak.get(providerId) ?? 0) + 1);
  }

  async callProvider(
    provider: ProviderDir,
    clientApi: "openai" | "anthropic",
    body: Record<string, unknown>,
    model: string,
    stream: boolean,
  ): Promise<{ answer: ProviderAnswer; model: string } | { failure: FailedAttempt }> {
    const call = providerCallFor(provider, clientApi, body, model, stream);
    let res: Response;
    try {
      res = await fetch(call.url, {
        method: "POST",
        headers: call.headers,
        body: JSON.stringify(call.payload),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      this.noteResult(provider.id, false);
      return { failure: { provider: provider.id, status: 0, retryAfter: null } };
    }
    const retryAfterHeader = res.headers.get("retry-after");
    const retryAfter = retryAfterHeader === null ? null : Number(retryAfterHeader);
    if (!res.ok) {
      this.noteResult(provider.id, false);
      return {
        failure: {
          provider: provider.id,
          status: res.status,
          retryAfter: retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
        },
      };
    }
    const text = await res.text();
    const answer = parseProviderAnswer(provider.wire, stream, text);
    if (answer === null) {
      this.noteResult(provider.id, false);
      return { failure: { provider: provider.id, status: res.status, retryAfter: null } };
    }
    this.noteResult(provider.id, true);
    return { answer, model };
  }

  // Serve one request: try candidates in order, then one more pass after
  // honoring the smallest retry-after seen (capped at two seconds).
  async serve(
    clientApi: "openai" | "anthropic",
    body: Record<string, unknown>,
    req: Requires,
    stream: boolean,
  ): Promise<{ answer: ProviderAnswer; model: string } | null> {
    const wantsJsonWire =
      clientApi === "openai" &&
      isRecord(body.response_format) &&
      (body.response_format.type === "json_object" || body.response_format.type === "json_schema");
    const list = this.candidates(req, clientApi, wantsJsonWire);
    const failures: FailedAttempt[] = [];
    for (let pass = 0; pass < 2; pass++) {
      for (const cand of list) {
        const result = await this.callProvider(cand.provider, clientApi, body, cand.model.id, stream);
        if ("answer" in result) return result;
        failures.push(result.failure);
      }
      if (pass === 0) {
        const waits = failures
          .map((f) => f.retryAfter)
          .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
        if (waits.length > 0) {
          const waitMs = Math.min(...waits, 2) * 1000;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// The server.
// ---------------------------------------------------------------------------

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendJson(res: import("node:http").ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

function sendText(res: import("node:http").ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

async function currentRequestId(envUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${envUrl}/work`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const doc: unknown = await res.json();
    if (!isRecord(doc) || doc.done === true) return null;
    return typeof doc.next === "string" ? doc.next : null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const listMode = args.includes("--list");
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/$/, "");
  const promptFile = process.env.MAKEFUN_PROMPT_FILE;

  const brief = readBrief(promptFile);
  let providers: ProviderDir[] = brief.providers;
  let manifest: ManifestRequest[] = brief.manifest;
  if (envUrl !== "") {
    const instance = await fetchInstance(envUrl);
    if (instance.providers.length > 0) providers = instance.providers;
    if (instance.manifest.length > 0) manifest = instance.manifest;
  }

  const catalog = envUrl === "" ? { providers: [] } : await buildCatalog(providers, brief);

  if (listMode) {
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return 0;
  }

  if (envUrl === "") {
    process.stderr.write("main.ts: MAKEFUN_ENV_URL is not set; nothing to serve\n");
    return 1;
  }

  const manifestById = new Map(manifest.map((m) => [m.id, m]));
  const router = new Router(catalog, brief, providers);

  const freeModelList = (): { id: string; context_length: number | null }[] => {
    const seen = new Set<string>();
    const out: { id: string; context_length: number | null }[] = [];
    for (const entry of catalog.providers) {
      for (const m of entry.models) {
        if (!m.free || seen.has(m.id)) continue;
        seen.add(m.id);
        out.push({ id: m.id, context_length: m.context_length });
      }
    }
    return out;
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://server");
      const path = url.pathname;
      try {
        if (req.method === "GET" && path === "/v1/models") {
          const models = freeModelList();
          const bearer = req.headers.authorization !== undefined && req.headers.authorization !== "";
          if (bearer) {
            sendJson(res, 200, {
              object: "list",
              data: models.map((m) => ({
                id: m.id,
                object: "model",
                created: FIXED_CREATED,
                owned_by: "aggregator",
                free: true,
                context_length: m.context_length,
              })),
            });
          } else {
            sendJson(res, 200, {
              data: models.map((m) => ({
                type: "model",
                id: m.id,
                display_name: m.id,
                created_at: "2026-01-01T00:00:00Z",
                free: true,
                context_length: m.context_length,
              })),
              has_more: false,
            });
          }
          return;
        }
        if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/messages")) {
          const clientApi: "openai" | "anthropic" = path === "/v1/chat/completions" ? "openai" : "anthropic";
          const body = await readJsonBody(req);
          if (body === null) {
            sendJson(res, 400, { error: { message: "the request body is not one JSON object", type: "invalid_request_error", code: "invalid_request" } });
            return;
          }
          const stream = body.stream === true;
          const requestId = await currentRequestId(envUrl);
          const entry = requestId === null ? undefined : manifestById.get(requestId);
          const reqs = entry !== undefined ? entry.requires : inferRequires(clientApi, body);
          const served = await router.serve(clientApi, body, reqs, stream);
          if (served === null) {
            sendJson(res, 502, { error: { message: "every provider refused the request", type: "api_error", code: "all_providers_failed" } });
            return;
          }
          if (clientApi === "openai") {
            if (stream) {
              sendText(res, 200, "text/event-stream; charset=utf-8", openAiStreamAnswer(served.model, served.answer));
            } else {
              sendJson(res, 200, JSON.parse(openAiJsonAnswer(served.model, served.answer)) as unknown);
            }
          } else {
            if (stream) {
              sendText(res, 200, "text/event-stream; charset=utf-8", anthropicStreamAnswer(served.model, served.answer));
            } else {
              sendJson(res, 200, JSON.parse(anthropicJsonAnswer(served.model, served.answer)) as unknown);
            }
          }
          return;
        }
        sendJson(res, 404, { error: { message: `no route ${req.method ?? ""} ${path}`, type: "invalid_request_error", code: "not_found" } });
      } catch (err) {
        const message = err instanceof Error ? err.message : "internal error";
        process.stderr.write(`main.ts: ${message}\n`);
        if (!res.headersSent) {
          sendJson(res, 500, { error: { message, type: "api_error", code: "internal" } });
        } else {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  let registerRes: Response;
  try {
    registerRes = await fetch(`${envUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol_version: 1, port, catalog }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    process.stderr.write(`main.ts: register failed: ${err instanceof Error ? err.message : "unknown"}\n`);
    server.close();
    return 1;
  }
  if (!registerRes.ok) {
    process.stderr.write(`main.ts: register refused with HTTP ${registerRes.status}\n`);
    server.close();
    return 1;
  }

  // Poll /work until the client is done, then exit 0.
  for (;;) {
    let done = false;
    try {
      const res = await fetch(`${envUrl}/work`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const doc: unknown = await res.json();
        if (isRecord(doc) && doc.done === true) done = true;
      }
    } catch {
      // Keep polling: a transient env error is not the trial's end.
    }
    if (done) break;
    await new Promise((resolve) => setTimeout(resolve, WORK_POLL_MS));
  }
  server.close();
  return 0;
}

main().then((code) => {
  process.exitCode = code;
});

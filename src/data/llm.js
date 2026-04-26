// Cliente Groq para generacion de argumentos.
// Free tier muy generoso. https://console.groq.com/keys
//
// Variable de entorno: GROQ_API_KEY (requerido)
//
// Modelos:
//   - PRIMARY:  llama-3.3-70b-versatile  (alta calidad, ~10 req/min en free)
//   - FALLBACK: llama-3.1-8b-instant     (mas rapido, mas tolerante a rate limit)

const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const PRIMARY  = process.env.GROQ_MODEL_PRIMARY  || "llama-3.3-70b-versatile";
const FALLBACK = process.env.GROQ_MODEL_FALLBACK || "llama-3.1-8b-instant";
const TIMEOUT_MS = 30_000;

let _missingKeyWarned = false;

function getKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key && !_missingKeyWarned) {
    console.warn("[Groq] GROQ_API_KEY no configurada. Argumentos extensos desactivados.");
    _missingKeyWarned = true;
  }
  return key || null;
}

async function callGroqOnce(model, { system, user, maxTokens = 1400, temperature = 0.4 }) {
  const key = getKey();
  if (!key) return null;
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user }
    ],
    max_tokens: maxTokens,
    temperature,
    top_p: 0.9
  };
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type":  "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) {
      console.warn(`[Groq] ${model}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text ? { text, model } : null;
  } catch (err) {
    console.warn(`[Groq] ${model}: ${err.message}`);
    return null;
  }
}

/**
 * Llama Groq con retry y fallback a modelo mas pequeno si hay rate limit.
 * Devuelve { text, model } o null.
 */
export async function callGroq(opts) {
  let r = await callGroqOnce(PRIMARY, opts);
  if (r?.text) return r;
  if (r?.rateLimited) {
    r = await callGroqOnce(FALLBACK, opts);
    if (r?.text) return r;
  }
  return null;
}

export function isGroqAvailable() {
  return Boolean(process.env.GROQ_API_KEY);
}

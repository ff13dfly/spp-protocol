/**
 * providers.mjs — vision model adapters for the perception eval.
 *
 * Each adapter is callFn(base64, mime, systemPrompt, userText) -> Promise<string>.
 * Keys come from the environment (never hardcode). Model ids are overridable via
 * env so you can point at whatever current version you have (e.g. a newer Gemini).
 * A model is only included in a run if its key is present.
 *
 * Fairness notes (so cross-model numbers mean something):
 *  - Each provider gets the system prompt through its OWN system channel:
 *    Claude `system`, Qwen `role:"system"` message, Gemini `systemInstruction`.
 *  - temperature=0.1 is set where the API accepts it (Qwen, Gemini). It is
 *    deliberately NOT set for Claude: claude-opus-4-8 REJECTS `temperature`
 *    (400). For run-to-run variance on any model, use run-eval's --repeats.
 *  - httpPost retries transient failures (429/5xx/network) so a single flaky
 *    response doesn't bias one model's score.
 */
import https from 'https';

function once(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function httpPost(url, headers, body, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await once(url, headers, body);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status}: ${String(res.body).slice(0, 200)}`);
        if (attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) { await sleep(500 * 2 ** attempt); continue; }
    }
  }
  throw lastErr;
}

const QWEN_KEY   = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

const QWEN_MODEL   = process.env.QWEN_MODEL   || 'qwen-vl-max';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro'; // set GEMINI_MODEL to your exact id

async function callQwen(base64, mime, systemPrompt, userText) {
  const payload = JSON.stringify({
    model: QWEN_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        { type: 'text', text: userText },
      ] },
    ],
    temperature: 0.1,
    max_tokens: 4000,
  });
  const res = await httpPost('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    { 'Content-Type': 'application/json', Authorization: `Bearer ${QWEN_KEY}` }, payload);
  if (res.status !== 200) throw new Error(`Qwen ${res.status}: ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body).choices?.[0]?.message?.content ?? '';
}

async function callClaude(base64, mime, systemPrompt, userText) {
  // NOTE: no `temperature` — claude-opus-4-8 rejects sampling params (400).
  const payload = JSON.stringify({
    model: CLAUDE_MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
      { type: 'text', text: userText },
    ] }],
  });
  const res = await httpPost('https://api.anthropic.com/v1/messages',
    { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' }, payload);
  if (res.status !== 200) throw new Error(`Claude ${res.status}: ${res.body.slice(0, 300)}`);
  return (JSON.parse(res.body).content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

async function callGemini(base64, mime, systemPrompt, userText) {
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [
      { inline_data: { mime_type: mime, data: base64 } },
      { text: userText },
    ] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4000 },
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const res = await httpPost(url, { 'Content-Type': 'application/json' }, payload);
  if (res.status !== 200) throw new Error(`Gemini ${res.status}: ${res.body.slice(0, 300)}`);
  const parts = JSON.parse(res.body).candidates?.[0]?.content?.parts ?? [];
  // skip "thought" parts (thinking models) — keep only answer text
  return parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
}

/** Models with a key present, in a stable order. */
export function availableModels() {
  const all = [
    { id: 'claude', name: `Claude (${CLAUDE_MODEL})`, key: CLAUDE_KEY, call: callClaude },
    { id: 'gemini', name: `Gemini (${GEMINI_MODEL})`, key: GEMINI_KEY, call: callGemini },
    { id: 'qwen',   name: `Qwen (${QWEN_MODEL})`,     key: QWEN_KEY,   call: callQwen },
  ];
  return all.filter(m => m.key);
}

export function missingKeyNotes() {
  const notes = [];
  if (!CLAUDE_KEY) notes.push('ANTHROPIC_API_KEY unset → Claude skipped');
  if (!GEMINI_KEY) notes.push('GEMINI_API_KEY/GOOGLE_API_KEY unset → Gemini skipped');
  if (!QWEN_KEY)   notes.push('QWEN_API_KEY/DASHSCOPE_API_KEY unset → Qwen skipped');
  return notes;
}

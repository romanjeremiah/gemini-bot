// Test variants of tool-call history shape against gpt-oss, Qwen, Llama 3.3
// to find which one each model accepts.

const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;

const MODELS = [
  '@cf/openai/gpt-oss-120b',
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
];

// 4 history shapes to test:
const VARIANTS = {
  'A: content:null, role:tool': [
    { role: 'user', content: 'remind me at 21 to take meds' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_reminder', arguments: '{"task":"meds"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"status":"ok"}' },
    { role: 'assistant', content: 'Set.' },
    { role: 'user', content: 'change to 22:00' },
  ],
  'B: content:empty-string, role:tool': [
    { role: 'user', content: 'remind me at 21 to take meds' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_reminder', arguments: '{"task":"meds"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '{"status":"ok"}' },
    { role: 'assistant', content: 'Set.' },
    { role: 'user', content: 'change to 22:00' },
  ],
  'C: no role:tool, results as user': [
    { role: 'user', content: 'remind me at 21 to take meds' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_reminder', arguments: '{"task":"meds"}' } }] },
    { role: 'user', content: '[tool result for set_reminder]: {"status":"ok"}' },
    { role: 'assistant', content: 'Set.' },
    { role: 'user', content: 'change to 22:00' },
  ],
  'D: prose-only history (no tool_calls at all)': [
    { role: 'user', content: 'remind me at 21 to take meds' },
    { role: 'assistant', content: 'OK, set for 21:00.' },
    { role: 'user', content: 'change to 22:00' },
  ],
};

const tools = [{
  type: 'function',
  function: {
    name: 'set_reminder',
    description: 'Set a reminder',
    parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  },
}, {
  type: 'function',
  function: {
    name: 'update_reminder',
    description: 'Update an existing reminder',
    parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  },
}];

for (const model of MODELS) {
  console.log(`\n=== ${model} ===`);
  for (const [name, messages] of Object.entries(VARIANTS)) {
    const t0 = Date.now();
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${model}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, tools, temperature: 0.6, max_tokens: 256 }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text();
      console.log(`  ${name.padEnd(45)} HTTP ${res.status} (${ms}ms)`);
      console.log(`    ${body.slice(0, 200)}`);
    } else {
      const data = await res.json();
      const msg = data?.result?.choices?.[0]?.message;
      const calls = msg?.tool_calls ?? [];
      const prose = (msg?.content ?? '').slice(0, 80);
      console.log(`  ${name.padEnd(45)} OK (${ms}ms) · ${calls.length} call(s)${calls[0] ? ` [${calls[0].function?.name}]` : ''} · prose: "${prose}"`);
    }
  }
}

import { personas } from './src/config/personas.js';
const SYS = personas.xaridotis.instruction;
const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/@cf/moonshotai/kimi-k2.6`;
for (let i = 1; i <= 5; i++) {
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: "okay so i've been thinking about my mum a lot this week and i don't really know why. help me unpack it i guess." }
      ],
      temperature: 1.0,
      max_tokens: 2048,
      chat_template_kwargs: { thinking: false }
    })
  });
  const data = await res.json();
  const content = data?.result?.choices?.[0]?.message?.content || '';
  const hasThink = content.includes('</think>') || content.includes('<think>');
  const looksLikeReasoning = /\b(I (need|should|want|will|'ll)|Let me|Possible replies|Actually,)/.test(content.slice(0, 150));
  console.log(`run ${i}: ${Date.now() - started}ms · len=${content.length} · </think>=${hasThink} · reasoning-shape=${looksLikeReasoning}`);
  console.log(`  FIRST 200: ${content.slice(0, 200)}`);
}

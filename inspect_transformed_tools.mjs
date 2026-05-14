// inspect_transformed_tools.mjs
// Print the first tool in each transformed format so I can verify shape.
import { readFileSync } from 'node:fs';
import { toOpenAIToolsArray, toCloudflareToolsArray, toGeminiToolsArray } from './schema_transform.mjs';

const RAW = JSON.parse(readFileSync('./tool_definitions_extracted.json', 'utf8'));
const setReminder = RAW.find(t => t.name === 'set_reminder');

console.log('=== ORIGINAL (Gemini Vertex-style) ===');
console.log(JSON.stringify(setReminder, null, 2));

console.log('\n=== OpenAI shape (Kimi, gpt-oss, Qwen, Gemma, Llama get this) ===');
console.log(JSON.stringify(toOpenAIToolsArray([setReminder])[0], null, 2));

console.log('\n=== Cloudflare "traditional" shape (alt) ===');
console.log(JSON.stringify(toCloudflareToolsArray([setReminder])[0], null, 2));

console.log('\n=== Gemini-native shape (what my Gemini test passes) ===');
console.log(JSON.stringify(toGeminiToolsArray([setReminder])[0], null, 2));

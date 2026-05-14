// dump_schema_size.mjs — find total size of all 34 tool schemas
import { readFileSync, readdirSync } from 'node:fs';
const dir = './src/tools';
let totalChars = 0;
let toolCount = 0;
for (const f of readdirSync(dir)) {
	if (!f.endsWith('.js') || f === 'index.js' || f === 'moodKeyboards.js') continue;
	const content = readFileSync(`${dir}/${f}`, 'utf8');
	// crude: find tool definitions and sum description lengths
	const matches = content.matchAll(/description:\s*"([^"]*)"/g);
	let fileChars = 0;
	for (const m of matches) { fileChars += m[1].length; }
	if (fileChars > 50) {
		toolCount++;
		console.log(`${f.padEnd(20)} description chars: ${fileChars}`);
		totalChars += fileChars;
	}
}
console.log(`\nTotal: ${toolCount} tool files, ~${totalChars} chars of descriptions`);
console.log(`Approx tokens (chars/4): ~${Math.round(totalChars / 4)}`);

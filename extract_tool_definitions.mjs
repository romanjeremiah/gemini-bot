// extract_tool_definitions.mjs
//
// One-off: walk src/tools/*.js, evaluate each file in an isolated context
// that stubs out the import resolution problem, and dump every tool
// definition into a JSON file the test bundles can consume.
//
// Why this approach: your production code uses Workers-style imports
// (no .js extensions, no relative dots in some cases) which Node ESM
// rejects. We could fix this with a tsconfig, but for a one-off test we
// just pull the definitions out by parsing the source.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const TOOLS_DIR = './src/tools';
const OUT = './tool_definitions_extracted.json';

// Find every `export const ... = { definition: {...}, ... }` block
// and pull out the `definition` object by balanced-brace scanning.
//
// This is brittle but predictable, and we only need it to work on YOUR code.

function extractDefinitions(source) {
	const results = [];
	// Match patterns like:
	//   export const fooTool = {
	//     definition: {
	//       name: "...",
	//       description: "...",
	//       parameters: { ... }
	//     },
	const re = /export\s+const\s+(\w+)\s*=\s*\{\s*definition\s*:\s*(\{)/g;
	let m;
	while ((m = re.exec(source)) !== null) {
		const exportName = m[1];
		const defStart = m.index + m[0].length - 1; // points at the opening {
		// Walk braces to find the matching close
		let depth = 0;
		let i = defStart;
		let inString = false;
		let stringChar = null;
		let escape = false;
		for (; i < source.length; i++) {
			const c = source[i];
			if (escape) { escape = false; continue; }
			if (c === '\\') { escape = true; continue; }
			if (inString) {
				if (c === stringChar) { inString = false; stringChar = null; }
				continue;
			}
			if (c === '"' || c === "'" || c === '`') { inString = true; stringChar = c; continue; }
			if (c === '{') depth++;
			else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
		}
		const defBlock = source.slice(defStart, i);
		// Evaluate the object literal. We rely on it being self-contained JS
		// (no imports referenced inside the literal). It is, in your codebase.
		try {
			// eslint-disable-next-line no-eval
			const def = eval(`(${defBlock})`);
			if (def && def.name && def.parameters) {
				results.push({ exportName, definition: def });
			}
		} catch (err) {
			console.error(`  failed to parse ${exportName}: ${err.message}`);
		}
	}
	return results;
}

const allDefs = [];
for (const file of readdirSync(TOOLS_DIR)) {
	if (!file.endsWith('.js') || file === 'index.js') continue;
	const src = readFileSync(`${TOOLS_DIR}/${file}`, 'utf8');
	const found = extractDefinitions(src);
	console.log(`${file.padEnd(22)} ${found.length} tool(s): ${found.map(f => f.definition.name).join(', ')}`);
	allDefs.push(...found);
}

console.log(`\nTotal: ${allDefs.length} tool definitions`);
const definitions = allDefs.map(d => d.definition);
writeFileSync(OUT, JSON.stringify(definitions, null, 2));
console.log(`Wrote ${OUT} (${(readFileSync(OUT).length / 1024).toFixed(1)} KB)`);

// schema_transform.mjs
//
// Transform Gemini Vertex-style tool definitions to OpenAI-compatible
// `tools` arrays usable by Kimi, gpt-oss, Qwen, and Gemma on Cloudflare.
//
// Differences handled:
//   - Type casing: "OBJECT" -> "object", "STRING" -> "string", etc.
//   - Wrapper shape: Gemini uses { name, description, parameters } directly;
//     OpenAI requires { type: "function", function: { name, description,
//     parameters } }.
//   - Required arrays: same shape, copied through.
//   - Enums: same shape, copied through.
//   - Nested properties: recursive walk.

const TYPE_MAP = {
	OBJECT: 'object',
	STRING: 'string',
	INTEGER: 'integer',
	NUMBER: 'number',
	BOOLEAN: 'boolean',
	ARRAY: 'array',
	NULL: 'null',
};

function lowercaseTypes(schema) {
	if (!schema || typeof schema !== 'object') return schema;
	if (Array.isArray(schema)) return schema.map(lowercaseTypes);
	const out = {};
	for (const [k, v] of Object.entries(schema)) {
		if (k === 'type' && typeof v === 'string') {
			out[k] = TYPE_MAP[v] || v.toLowerCase();
		} else if (k === 'properties' && typeof v === 'object') {
			out[k] = {};
			for (const [pk, pv] of Object.entries(v)) {
				out[k][pk] = lowercaseTypes(pv);
			}
		} else if (k === 'items') {
			out[k] = lowercaseTypes(v);
		} else if (typeof v === 'object') {
			out[k] = lowercaseTypes(v);
		} else {
			out[k] = v;
		}
	}
	return out;
}

/** Gemini-style -> OpenAI-style tools array */
export function toOpenAIToolsArray(geminiDefinitions) {
	return geminiDefinitions.map(def => ({
		type: 'function',
		function: {
			name: def.name,
			description: def.description,
			parameters: lowercaseTypes(def.parameters),
		},
	}));
}

/** Gemini-style -> Cloudflare Workers AI "traditional" function-calling tools.
 *  Per docs, this is the simpler `{ name, description, parameters }` array
 *  without the OpenAI wrapper. Used by some CF models in their `tools` field. */
export function toCloudflareToolsArray(geminiDefinitions) {
	return geminiDefinitions.map(def => ({
		name: def.name,
		description: def.description,
		parameters: lowercaseTypes(def.parameters),
	}));
}

/** Gemini-native format. Already correct shape, just normalised types where
 *  Gemini accepts both casings. (For test parity.) */
export function toGeminiToolsArray(geminiDefinitions) {
	return geminiDefinitions.map(def => ({
		name: def.name,
		description: def.description,
		parameters: def.parameters,  // Gemini accepts the uppercase form
	}));
}

// Gemini provider.
// Wraps the existing src/lib/ai/gemini.js helpers so the rest of the code
// can speak to Gemini and Cloudflare through the same AIProvider interface.
//
// This is a thin adapter: createChat + sendChatMessage(Stream) already exist
// and do the right thing. We just re-shape inputs/outputs to match.

import { createChat, sendChatMessage, sendChatMessageStream } from '../lib/ai/gemini';

export class GeminiProvider {
	constructor(env, model, options = {}) {
		this.name = 'gemini';
		this.env = env;
		this.model = model;
		// Owner persona instruction is composed by handlers.js per-turn;
		// we expect callers to pass it via config.systemInstruction.
	}

	async chat(messages, tools, config = {}) {
		// Build the Gemini Chat with the supplied history and system prompt.
		const history = this._toGeminiHistory(messages.slice(0, -1));
		const lastMessage = messages[messages.length - 1];
		const lastParts = this._messagePartsToGeminiParts(lastMessage);

		const chat = await createChat(
			history,
			config.systemInstruction || '',
			this.env,
			config.cachedContent || null,
			this.model,
			{ skipCodeExecution: !!config.skipCodeExecution }
		);

		// Collect chunks from the non-streaming path, which yields
		// { type:'text'|'functionCall', ... }.
		let text = '';
		const toolCalls = [];
		for await (const chunk of sendChatMessage(chat, lastParts)) {
			if (chunk.type === 'text') text += chunk.text;
			else if (chunk.type === 'functionCall') {
				for (const c of chunk.calls) {
					toolCalls.push({
						name: c.functionCall.name,
						args: c.functionCall.args || {},
						id: c.functionCall.id || `call_${Date.now()}`,
					});
				}
			}
		}
		return { text: text.trim(), toolCalls: toolCalls.length ? toolCalls : undefined };
	}

	async *chatStream(messages, tools, config = {}) {
		const history = this._toGeminiHistory(messages.slice(0, -1));
		const lastMessage = messages[messages.length - 1];
		const lastParts = this._messagePartsToGeminiParts(lastMessage);

		const chat = await createChat(
			history,
			config.systemInstruction || '',
			this.env,
			config.cachedContent || null,
			this.model,
			{ skipCodeExecution: !!config.skipCodeExecution }
		);

		// Pass-through; sendChatMessageStream already yields chunks in
		// the AIStreamChunk shape (text / functionCall / finishReason / blockReason).
		for await (const chunk of sendChatMessageStream(chat, lastParts)) {
			yield chunk;
		}
	}

	// --- Internal converters ---

	_toGeminiHistory(messages) {
		// Gemini expects { role:'user'|'model', parts:[{text}|{inlineData}|{functionCall}|{functionResponse}] }
		const out = [];
		for (const m of messages) {
			const role = m.role === 'tool' ? 'user' : (m.role === 'assistant' ? 'model' : m.role);
			const parts = this._messagePartsToGeminiParts(m);
			if (parts.length) out.push({ role, parts });
		}
		return out;
	}

	_messagePartsToGeminiParts(msg) {
		if (!msg) return [{ text: '' }];
		if (typeof msg.content === 'string') return [{ text: msg.content }];
		if (!Array.isArray(msg.content)) return [{ text: JSON.stringify(msg.content) }];

		const parts = [];
		for (const p of msg.content) {
			if (p.type === 'text') {
				parts.push({ text: p.text });
			} else if (p.type === 'inline_data') {
				parts.push({ inlineData: p.inline_data });
			} else if (p.type === 'tool_use') {
				parts.push({ functionCall: { name: p.name, args: p.args || {} } });
			} else if (p.type === 'tool_result') {
				parts.push({ functionResponse: { name: p.name || 'tool', response: { content: p.content } } });
			}
		}
		return parts.length ? parts : [{ text: '' }];
	}
}

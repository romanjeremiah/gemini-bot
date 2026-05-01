// Cloudflare Workers AI provider — Gemma + Qwen3.
// Implements the AIProvider interface with OpenAI-compatible function calling.
// Routes through AI Gateway for caching and observability.

import { runCfAi } from '../lib/ai-gateway';

export class CloudflareProvider {
	constructor(ai, model) {
		this.name = 'cloudflare';
		this.ai = ai;
		this.model = model;
	}

	async chat(messages, tools, config = {}) {
		const cfMessages = this._convertMessages(messages, config.systemInstruction);
		const cfTools = tools && tools.length ? this._convertTools(tools) : undefined;

		const result = await runCfAi(this.ai, this.model, {
			messages: cfMessages,
			tools: cfTools,
			temperature: config.temperature ?? 1.0,
			max_tokens: config.maxTokens ?? 2048,
		});

		return this._parseResponse(result);
	}

	async *chatStream(messages, tools, config = {}) {
		const cfMessages = this._convertMessages(messages, config.systemInstruction);

		const stream = await runCfAi(this.ai, this.model, {
			messages: cfMessages,
			temperature: config.temperature ?? 1.0,
			max_tokens: config.maxTokens ?? 2048,
			stream: true,
		});

		if (!(stream instanceof ReadableStream)) {
			const parsed = this._parseResponse(stream);
			if (parsed.text) yield { type: 'text', text: parsed.text };
			return;
		}

		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
				try {
					const data = JSON.parse(line.slice(6));
					if (data.response) yield { type: 'text', text: data.response };
				} catch { /* skip malformed chunks */ }
			}
		}
	}

	_convertMessages(messages, systemInstruction) {
		const result = [];
		if (systemInstruction) result.push({ role: 'system', content: systemInstruction });
		for (const msg of messages) {
			let content;
			if (typeof msg.content === 'string') {
				content = msg.content;
			} else if (Array.isArray(msg.content)) {
				const parts = [];
				let droppedMedia = false;
				for (const p of msg.content) {
					if (p.type === 'text') parts.push(p.text);
					else if (p.type === 'inline_data') droppedMedia = true;
				}
				if (droppedMedia) parts.push('[media attached — not processable by this model]');
				content = parts.join('\n');
			} else {
				content = JSON.stringify(msg.content);
			}
			const role = msg.role === 'model' ? 'assistant' : msg.role;
			result.push({ role, content });
		}
		return result;
	}

	_convertTools(tools) {
		return tools.map(t => {
			const decl = t.schema?.functionDeclarations?.[0] || t.schema?.function || t.schema;
			return {
				type: 'function',
				function: {
					name: decl.name,
					description: decl.description,
					parameters: decl.parameters,
				},
			};
		});
	}

	_parseResponse(result) {
		if (typeof result === 'string') return { text: result };
		if (!result) return { text: '' };

		let text = '';
		const toolCalls = [];

		if (result.choices && Array.isArray(result.choices)) {
			const message = result.choices[0]?.message;
			if (message?.content) text = message.content;
			if (message?.tool_calls && Array.isArray(message.tool_calls)) {
				for (const tc of message.tool_calls) {
					const args = typeof tc.function?.arguments === 'string'
						? safeJson(tc.function.arguments) : (tc.function?.arguments ?? {});
					toolCalls.push({
						name: tc.function?.name ?? '',
						args,
						id: tc.id ?? `call_${Date.now()}`,
					});
				}
			}
		} else {
			text = result.response ?? '';
			if (result.tool_calls && Array.isArray(result.tool_calls)) {
				for (const tc of result.tool_calls) {
					toolCalls.push({
						name: tc.name ?? tc.function?.name ?? '',
						args: tc.arguments ?? tc.function?.arguments ?? {},
						id: tc.id ?? `call_${Date.now()}`,
					});
				}
			}
		}

		return { text: (text || '').trim(), toolCalls: toolCalls.length ? toolCalls : undefined };
	}
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

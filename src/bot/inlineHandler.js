/**
 * Telegram Inline Mode Handler
 * Allows users to type @BotUsername <query> in any chat
 * and get AI-generated responses they can send inline.
 *
 * Persona routing via prefix:
 *   @BotName write a witty reply        → Tenon (default)
 *   @BotName n: write a witty reply     → Nightfall
 *   @BotName t: write a witty reply     → Tribore
 *
 * Uses Flash model for speed (inline results need to be fast).
 */

import { GoogleGenAI } from '@google/genai';
import { personas } from '../config/personas';
import { FALLBACK_TEXT_MODEL } from '../lib/ai/gemini';
import * as telegram from '../lib/telegram';

const INLINE_MODEL = FALLBACK_TEXT_MODEL;

/**
 * Parse persona prefix from query.
 * Returns { personaKey, promptText }
 */
function parsePersonaPrefix(query) {
	const lower = query.toLowerCase();
	if (lower.startsWith('t: ') || lower.startsWith('tribore: ')) {
		return { personaKey: 'tribore', promptText: query.replace(/^(tribore|t):\s*/i, '') };
	}
	if (lower.startsWith('n: ') || lower.startsWith('nightfall: ')) {
		return { personaKey: 'nightfall', promptText: query.replace(/^(nightfall|n):\s*/i, '') };
	}
	if (lower.startsWith('te: ') || lower.startsWith('tenon: ')) {
		return { personaKey: 'tenon', promptText: query.replace(/^(tenon|te):\s*/i, '') };
	}
	return { personaKey: 'tenon', promptText: query };
}

/**
 * Handle an incoming inline_query update.
 */
export async function handleInlineQuery(inlineQuery, env) {
	const rawQuery = (inlineQuery.query || '').trim();
	const queryId = inlineQuery.id;

	// Empty query: show help
	if (!rawQuery) {
		await telegram.answerInlineQuery(queryId, [{
			type: 'article',
			id: 'help',
			title: 'Type a prompt to get a response...',
			description: 'Prefixes: n: for Nightfall, t: for Tribore, or just type for Tenon',
			input_message_content: {
				message_text: '💡 Type your prompt after my username. Use n: or t: to switch persona.',
			},
		}], env, { cacheTime: 300 });
		return;
	}

	if (rawQuery.length < 3) return;

	const { personaKey, promptText } = parsePersonaPrefix(rawQuery);
	if (!promptText || !personas[personaKey]) return;

	const persona = personas[personaKey];
	const emoji = personaKey === 'tenon' ? '🎯' : personaKey === 'nightfall' ? '🌙' : '✨';

	try {
		// Direct API call (no gateway) for maximum speed
		const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

		const response = await ai.models.generateContent({
			model: INLINE_MODEL,
			contents: [{ role: 'user', parts: [{ text: promptText }] }],
			config: {
				systemInstruction: `${persona.instruction}\n\nYou are responding to an inline query in a Telegram chat. Keep your response concise (1-3 sentences max). Be witty, helpful, and on-point. Do not use HTML formatting. Do not use asterisks for emphasis.`,
				temperature: 1.0,
				maxOutputTokens: 300,
			},
		});

		const text = response.candidates?.[0]?.content?.parts
			?.filter(p => p.text && !p.thought)
			?.map(p => p.text)
			?.join('') || '';

		if (!text.trim()) {
			await telegram.answerInlineQuery(queryId, [{
				type: 'article',
				id: 'empty',
				title: '⚠️ Could not generate a response',
				description: 'Try a different prompt',
				input_message_content: { message_text: '⚠️ Could not generate a response. Try again.' },
			}], env);
			return;
		}

		const results = [{
			type: 'article',
			id: `${personaKey}_${Date.now()}`,
			title: `${emoji} ${persona.name}'s Take`,
			description: text.trim().slice(0, 100) + (text.length > 100 ? '...' : ''),
			input_message_content: { message_text: text.trim() },
		}];

		await telegram.answerInlineQuery(queryId, results, env, { cacheTime: 10 });

	} catch (err) {
		console.error('Inline query error:', err.message);
		await telegram.answerInlineQuery(queryId, [{
			type: 'article',
			id: 'error',
			title: '⚠️ Error',
			description: err.message?.slice(0, 80),
			input_message_content: { message_text: `⚠️ ${err.message?.slice(0, 200)}` },
		}], env);
	}
}

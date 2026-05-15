/**
 * Telegram Inline Mode Handler
 * Allows users to type @BotUsername <query> in any chat
 * and get AI-generated responses they can send inline.
 *
 * Single persona: Xaridotis. (Legacy aliases tenon/nightfall/tribore
 * were removed when the persona system was unified.)
 *
 * Uses Flash model for speed (inline results need to be fast).
 */

import { GoogleGenAI } from '@google/genai';
import { personas } from '../config/personas';
import { FALLBACK_TEXT_MODEL } from '../lib/ai/gemini';
import * as telegram from '../lib/telegram';

const INLINE_MODEL = FALLBACK_TEXT_MODEL;

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
			description: 'Xaridotis will reply inline.',
			input_message_content: {
				message_text: '💡 Type your prompt after my username.',
			},
		}], env, { cacheTime: 300 });
		return;
	}

	if (rawQuery.length < 3) return;

	const persona = personas.xaridotis;
	if (!persona) return;

	try {
		// Direct API call (no gateway) for maximum speed
		const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

		const response = await ai.models.generateContent({
			model: INLINE_MODEL,
			contents: [{ role: 'user', parts: [{ text: rawQuery }] }],
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
			id: `xaridotis_${Date.now()}`,
			title: `${persona.name}'s Take`,
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

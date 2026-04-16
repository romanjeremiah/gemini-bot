/**
 * Persona Service
 *
 * Per-user, per-persona configuration. Each user gets their own copy of
 * each built-in persona (overridable) plus the ability to create custom ones.
 *
 * Table: persona_config (composite PK: user_id + persona_key)
 * Active selection: KV key `persona_${chatId}_${threadId}` (per-chat)
 */

import { resolveVoice, isValidVoice, CHIRP3_HD_VOICES } from '../config/voices';

const BUILT_IN_PERSONAS = ['xaridotis', 'nightfall', 'mooncake', 'hue', 'tribore'];

/**
 * Ensure persona_config rows exist for a user (all built-ins seeded).
 * Called by upsertUser on first interaction.
 */
export async function ensurePersonas(env, userId) {
	// Check if the user already has any personas
	const { results } = await env.DB.prepare(
		'SELECT persona_key FROM persona_config WHERE user_id = ? LIMIT 1'
	).bind(userId).all();
	if (results?.length) return; // already seeded

	// Seed built-in personas with defaults
	const seeds = [
		[userId, 'xaridotis', 'Xaridotis', 0, 'xaridotis', 'warm', 'casual', 'moderate', 'moderate', 'supportive', 'Gacrux', 'en-US'],
		[userId, 'nightfall', 'Nightfall', 0, 'xaridotis', 'clinical', 'formal', 'low', 'minimal', 'supportive', 'Laomedeia', 'en-US'],
		[userId, 'mooncake', 'Mooncake', 0, 'xaridotis', 'witty', 'casual', 'high', 'moderate', 'supportive', 'Puck', 'en-GB'],
		[userId, 'hue', 'HUE', 0, 'xaridotis', 'deadpan', 'formal', 'dry', 'minimal', 'supportive', 'Sadaltager', 'en-US'],
		[userId, 'tribore', 'Tribore', 0, 'xaridotis', 'warm', 'casual', 'moderate', 'moderate', 'supportive', 'Erinome', 'en-US'],
	];
	const stmts = seeds.map(s =>
		env.DB.prepare(
			`INSERT OR IGNORE INTO persona_config (user_id, persona_key, display_name, is_custom, base_persona, tone, formality, humour_level, emoji_style, therapeutic_approach, voice_name, voice_locale) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).bind(...s)
	);
	await env.DB.batch(stmts);
}

/**
 * Get a specific persona config for a user.
 * Returns null if the persona doesn't exist for this user.
 */
export async function getPersona(env, userId, personaKey) {
	return env.DB.prepare(
		'SELECT * FROM persona_config WHERE user_id = ? AND persona_key = ?'
	).bind(userId, personaKey).first();
}

/**
 * Get all personas for a user (built-in + custom).
 */
export async function getAllPersonas(env, userId) {
	const { results } = await env.DB.prepare(
		'SELECT * FROM persona_config WHERE user_id = ? ORDER BY is_custom ASC, persona_key ASC'
	).bind(userId).all();
	return results || [];
}

/**
 * Create a custom persona for a user.
 */
export async function createPersona(env, userId, {
	personaKey, displayName, basedOn = 'xaridotis',
	tone = 'warm', formality = 'casual', humourLevel = 'moderate',
	emojiStyle = 'moderate', therapeuticApproach = 'supportive',
	voiceName = null, voiceLocale = 'en-US',
	customInstruction = null, topicsOfInterest = null
}) {
	// Validate voice if provided
	if (voiceName && !isValidVoice(voiceName)) {
		throw new Error(`Invalid voice: ${voiceName}. Use one of the Chirp 3: HD voices.`);
	}
	// Normalise the key
	const key = personaKey.toLowerCase().replace(/[^a-z0-9_]/g, '_');

	await env.DB.prepare(
		`INSERT INTO persona_config (user_id, persona_key, display_name, is_custom, base_persona, tone, formality, humour_level, emoji_style, therapeutic_approach, voice_name, voice_locale, custom_instruction, topics_of_interest)
		VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).bind(userId, key, displayName, basedOn, tone, formality, humourLevel, emojiStyle, therapeuticApproach, voiceName, voiceLocale, customInstruction, topicsOfInterest).run();

	return { personaKey: key, displayName };
}

/**
 * Update fields on an existing persona config.
 * Works for both built-in overrides and custom personas.
 */
export async function updatePersona(env, userId, personaKey, updates) {
	const allowed = [
		'display_name', 'tone', 'formality', 'humour_level', 'emoji_style',
		'therapeutic_approach', 'voice_name', 'voice_locale',
		'custom_instruction', 'topics_of_interest', 'communication_notes', 'evolved_traits'
	];
	const fields = Object.entries(updates).filter(([k]) => allowed.includes(k));
	if (!fields.length) return;

	// Validate voice if being updated
	if (updates.voice_name && !isValidVoice(updates.voice_name)) {
		throw new Error(`Invalid voice: ${updates.voice_name}`);
	}

	const sets = fields.map(([k]) => `${k} = ?`).join(', ');
	const values = fields.map(([, v]) => v);
	await env.DB.prepare(
		`UPDATE persona_config SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND persona_key = ?`
	).bind(...values, userId, personaKey).run();
}

/**
 * Delete a custom persona. Cannot delete built-in personas.
 */
export async function deletePersona(env, userId, personaKey) {
	if (BUILT_IN_PERSONAS.includes(personaKey)) {
		throw new Error(`Cannot delete built-in persona: ${personaKey}`);
	}
	await env.DB.prepare(
		'DELETE FROM persona_config WHERE user_id = ? AND persona_key = ? AND is_custom = 1'
	).bind(userId, personaKey).run();
}

/**
 * Resolve the TTS voice for a persona+user combination.
 * Checks persona_config for user override, falls back to defaults.
 */
export async function resolvePersonaVoice(env, userId, personaKey) {
	const config = await getPersona(env, userId, personaKey);
	const override = config?.voice_name ? { voice: config.voice_name, locale: config.voice_locale || 'en-US' } : null;
	return resolveVoice(personaKey, override);
}

/**
 * Build persona traits string for system prompt injection.
 */
export function buildPersonaTraits(config) {
	if (!config) return '';
	const lines = [
		`Tone: ${config.tone}`,
		`Formality: ${config.formality}`,
		`Humour: ${config.humour_level}`,
		`Emoji usage: ${config.emoji_style}`,
		`Therapeutic approach: ${config.therapeutic_approach}`,
		config.communication_notes ? `Communication notes: ${config.communication_notes}` : '',
		config.evolved_traits ? `Evolved traits: ${config.evolved_traits}` : '',
		config.topics_of_interest ? `User interests: ${config.topics_of_interest}` : '',
	].filter(Boolean);
	return lines.join('\n');
}

/**
 * Get the list of available voice names for display.
 */
export function getAvailableVoices() {
	return CHIRP3_HD_VOICES.map(v => ({ name: v.name, gender: v.gender, traits: v.traits }));
}

export { BUILT_IN_PERSONAS };

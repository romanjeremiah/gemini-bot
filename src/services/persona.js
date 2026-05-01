// Per-user persona service.
//
// Mirrors Eukara's persona system: every user has a persona_config row
// that evolves over time. The system instruction is rebuilt per turn,
// layering BASE_INSTRUCTION + user context + persona overlay + clinical
// directive + formatting rules + dynamic context.
//
// This sits alongside src/services/userStore.js (which already manages
// user_profiles). Persona config is read here every turn; mutations
// happen via background observation cron and an admin command.

import { personas, FORMATTING_RULES, MENTAL_HEALTH_DIRECTIVE } from '../config/personas';

const DEFAULT_PERSONA = {
	tone: 'warm',
	formality: 'casual',
	humour_level: 'moderate',
	emoji_style: 'moderate',
	therapeutic_approach: 'supportive',
	topics_of_interest: null,
	communication_notes: null,
	evolved_traits: null,
};

/**
 * Ensure persona_config row exists for a user.
 * Called on first interaction; idempotent.
 */
export async function ensurePersonaConfig(env, userId) {
	try {
		await env.DB.prepare(
			'INSERT OR IGNORE INTO persona_config (user_id) VALUES (?)'
		).bind(userId).run();
	} catch (err) {
		console.warn('ensurePersonaConfig failed:', err.message);
	}
}

/**
 * Read persona_config for a user. Returns DEFAULT_PERSONA shape if no row exists.
 */
export async function getPersonaConfig(env, userId) {
	try {
		const row = await env.DB.prepare(
			'SELECT * FROM persona_config WHERE user_id = ?'
		).bind(userId).first();
		return row || { ...DEFAULT_PERSONA, user_id: userId };
	} catch (err) {
		console.warn('getPersonaConfig failed:', err.message);
		return { ...DEFAULT_PERSONA, user_id: userId };
	}
}

/**
 * Update specific persona_config fields. Only allow-listed fields are accepted
 * to prevent malicious tool-call injection from corrupting the config.
 */
export async function updatePersonaConfig(env, userId, updates) {
	const allowed = ['tone', 'formality', 'humour_level', 'emoji_style',
		'therapeutic_approach', 'topics_of_interest', 'communication_notes', 'evolved_traits'];
	const fields = Object.entries(updates).filter(([k]) => allowed.includes(k));
	if (!fields.length) return;

	const sets = fields.map(([k]) => `${k} = ?`).join(', ');
	const values = fields.map(([, v]) => v);
	await env.DB.prepare(
		`UPDATE persona_config SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`
	).bind(...values, userId).run();
}

/**
 * Build the full system instruction for a turn.
 *
 * Composition order (matches Eukara's layered approach):
 *   1. BASE_INSTRUCTION   — Xaridotis identity, voice, frameworks
 *   2. USER CONTEXT       — name, days known, stable profile facts
 *   3. PERSONA OVERLAY    — tone, formality, evolved traits per user
 *   4. MENTAL_HEALTH_DIRECTIVE — clinical protocol (register-gated)
 *   5. FORMATTING_RULES   — typography, HTML, emoji discipline
 *   6. DYNAMIC CONTEXT    — passed in by caller (memory, time, weather)
 */
export async function buildSystemInstruction(env, userId, dynamicContext, options = {}) {
	const personaName = options.personaName || 'xaridotis';
	const personaInstruction = personas[personaName]?.instruction || personas.xaridotis.instruction;

	const personaConfig = await getPersonaConfig(env, userId);

	// User context — pull from user_profiles. Best-effort: missing row → empty block.
	let userContext = '';
	try {
		const profile = await env.DB.prepare(
			'SELECT first_name, first_seen_at, known_hobbies, core_traits, communication_preference FROM user_profiles WHERE user_id = ?'
		).bind(userId).first();

		if (profile) {
			const userName = profile.first_name || 'there';
			const daysKnown = profile.first_seen_at
				? Math.floor((Date.now() - new Date(profile.first_seen_at + 'Z').getTime()) / 86400000)
				: 0;
			const facts = [
				profile.known_hobbies ? `Known hobbies: ${profile.known_hobbies}` : '',
				profile.core_traits ? `Core traits: ${profile.core_traits}` : '',
				profile.communication_preference ? `Preferred style: ${profile.communication_preference}` : '',
			].filter(Boolean).join('\n');
			userContext = `\nCURRENT USER: ${userName} (known for ${daysKnown} days)${facts ? '\n' + facts : ''}`;
		}
	} catch (err) {
		console.warn('user profile fetch failed:', err.message);
	}

	// Persona overlay — surfaces evolved traits to the model.
	const overlay = [
		`Tone: ${personaConfig.tone}`,
		`Formality: ${personaConfig.formality}`,
		`Humour: ${personaConfig.humour_level}`,
		`Emoji usage: ${personaConfig.emoji_style}`,
		`Therapeutic approach: ${personaConfig.therapeutic_approach}`,
		personaConfig.communication_notes ? `Communication notes: ${personaConfig.communication_notes}` : '',
		personaConfig.evolved_traits ? `Evolved personality traits (learned from this user): ${personaConfig.evolved_traits}` : '',
		personaConfig.topics_of_interest ? `User's stated interests: ${personaConfig.topics_of_interest}` : '',
	].filter(Boolean).join('\n');

	const userBlock = `${userContext}\n\nYOUR PERSONALITY CALIBRATION FOR THIS USER:\n${overlay}`.trim();

	return [
		personaInstruction,
		userBlock,
		MENTAL_HEALTH_DIRECTIVE,
		FORMATTING_RULES,
		dynamicContext,
	].filter(Boolean).join('\n\n');
}

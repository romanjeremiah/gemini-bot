/**
 * Cloud TTS Voice Registry
 *
 * Comprehensive voice list for persona configuration.
 * Primary tier: Chirp 3: HD (30 voices x 52 locales, streaming support)
 * Voice name format: <locale>-Chirp3-HD-<VoiceName>
 *
 * Source: https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
 * Last updated: 2026-04-16
 */

// ---- Chirp 3: HD voices (30) ----
// These are the highest quality voices with streaming support.
// Each voice works across all supported locales.

export const CHIRP3_HD_VOICES = [
	{ name: 'Achernar',      gender: 'female', traits: 'warm, clear, professional' },
	{ name: 'Achird',        gender: 'male',   traits: 'calm, measured, trustworthy' },
	{ name: 'Algenib',       gender: 'male',   traits: 'energetic, upbeat, engaging' },
	{ name: 'Algieba',       gender: 'male',   traits: 'deep, resonant, authoritative' },
	{ name: 'Alnilam',       gender: 'male',   traits: 'smooth, gentle, reassuring' },
	{ name: 'Aoede',         gender: 'female', traits: 'expressive, lively, animated' },
	{ name: 'Autonoe',       gender: 'female', traits: 'soft, thoughtful, introspective' },
	{ name: 'Callirrhoe',    gender: 'female', traits: 'confident, articulate, polished' },
	{ name: 'Charon',        gender: 'male',   traits: 'deep, grounded, steady' },
	{ name: 'Despina',       gender: 'female', traits: 'bright, friendly, approachable' },
	{ name: 'Enceladus',     gender: 'male',   traits: 'warm, conversational, natural' },
	{ name: 'Erinome',       gender: 'female', traits: 'gentle, empathetic, nurturing' },
	{ name: 'Fenrir',        gender: 'male',   traits: 'bold, dynamic, assertive' },
	{ name: 'Gacrux',        gender: 'female', traits: 'neutral, balanced, versatile' },
	{ name: 'Iapetus',       gender: 'male',   traits: 'crisp, precise, informative' },
	{ name: 'Kore',          gender: 'female', traits: 'youthful, curious, enthusiastic' },
	{ name: 'Laomedeia',     gender: 'female', traits: 'serene, calming, meditative' },
	{ name: 'Leda',          gender: 'female', traits: 'warm, maternal, comforting' },
	{ name: 'Orus',          gender: 'male',   traits: 'direct, candid, matter-of-fact' },
	{ name: 'Pulcherrima',   gender: 'female', traits: 'elegant, refined, composed' },
	{ name: 'Puck',          gender: 'male',   traits: 'playful, witty, lighthearted' },
	{ name: 'Rasalgethi',    gender: 'male',   traits: 'contemplative, wise, measured' },
	{ name: 'Sadachbia',     gender: 'male',   traits: 'friendly, relaxed, easygoing' },
	{ name: 'Sadaltager',    gender: 'male',   traits: 'clear, focused, analytical' },
	{ name: 'Schedar',       gender: 'male',   traits: 'rich, narrative, storytelling' },
	{ name: 'Sulafat',       gender: 'female', traits: 'vibrant, spirited, encouraging' },
	{ name: 'Umbriel',       gender: 'male',   traits: 'quiet, understated, thoughtful' },
	{ name: 'Vindemiatrix',  gender: 'female', traits: 'poised, intelligent, articulate' },
	{ name: 'Zephyr',        gender: 'female', traits: 'airy, light, soothing' },
	{ name: 'Zubenelgenubi', gender: 'male',   traits: 'robust, confident, commanding' },
];

// ---- Supported locales for Chirp 3: HD ----

export const CHIRP3_HD_LOCALES = [
	'ar-XA', 'bg-BG', 'bn-IN', 'cmn-CN', 'cs-CZ', 'da-DK', 'de-DE',
	'el-GR', 'en-AU', 'en-GB', 'en-IN', 'en-US', 'es-ES', 'es-US',
	'et-EE', 'fi-FI', 'fr-CA', 'fr-FR', 'gu-IN', 'he-IL', 'hi-IN',
	'hr-HR', 'hu-HU', 'id-ID', 'it-IT', 'ja-JP', 'kn-IN', 'ko-KR',
	'lt-LT', 'lv-LV', 'ml-IN', 'mr-IN', 'nb-NO', 'nl-BE', 'nl-NL',
	'pa-IN', 'pl-PL', 'pt-BR', 'ro-RO', 'ru-RU', 'sk-SK', 'sl-SI',
	'sr-RS', 'sv-SE', 'sw-KE', 'ta-IN', 'te-IN', 'th-TH', 'tr-TR',
	'uk-UA', 'ur-IN', 'vi-VN', 'yue-HK',
];

// ---- Legacy voice tiers (for reference / fallback) ----

export const VOICE_TIERS = ['Chirp3-HD', 'Studio', 'Neural2', 'WaveNet', 'Standard'];

// ---- Helper functions ----

/**
 * Build the full Cloud TTS voice name from components.
 * @param {string} locale - e.g. 'en-GB'
 * @param {string} voiceName - e.g. 'Gacrux'
 * @returns {string} e.g. 'en-GB-Chirp3-HD-Gacrux'
 */
export function buildVoiceName(locale, voiceName) {
	return `${locale}-Chirp3-HD-${voiceName}`;
}

/**
 * Get a voice by name (case-insensitive).
 * @param {string} name - e.g. 'Gacrux', 'gacrux'
 * @returns {{ name: string, gender: string, traits: string } | null}
 */
export function getVoice(name) {
	if (!name) return null;
	const lower = name.toLowerCase();
	return CHIRP3_HD_VOICES.find(v => v.name.toLowerCase() === lower) || null;
}

/**
 * Get all voices filtered by gender.
 * @param {'male' | 'female'} gender
 */
export function getVoicesByGender(gender) {
	return CHIRP3_HD_VOICES.filter(v => v.gender === gender);
}

/**
 * Validate that a voice name exists in the Chirp 3: HD set.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidVoice(name) {
	return !!getVoice(name);
}

/**
 * Default voice assignments for built-in personas.
 * These are starting defaults that users can override via persona_config.
 */
export const DEFAULT_PERSONA_VOICES = {
	xaridotis: { voice: 'Gacrux',     locale: 'en-US' },
	tenon:     { voice: 'Gacrux',     locale: 'en-US' },
	nightfall: { voice: 'Laomedeia',  locale: 'en-US' },
	tribore:   { voice: 'Erinome',    locale: 'en-US' },
	mooncake:  { voice: 'Puck',       locale: 'en-GB' },
	hue:       { voice: 'Sadaltager', locale: 'en-US' },
};

/**
 * Resolve the TTS voice name for a persona, with user override support.
 * @param {string} personaKey - e.g. 'xaridotis'
 * @param {object} [userOverride] - { voice: string, locale: string } from persona_config
 * @returns {string} Full Cloud TTS voice name, e.g. 'en-GB-Chirp3-HD-Puck'
 */
export function resolveVoice(personaKey, userOverride = null) {
	if (userOverride?.voice && isValidVoice(userOverride.voice)) {
		const locale = userOverride.locale || 'en-US';
		return buildVoiceName(locale, userOverride.voice);
	}
	const def = DEFAULT_PERSONA_VOICES[personaKey] || DEFAULT_PERSONA_VOICES.xaridotis;
	return buildVoiceName(def.locale, def.voice);
}

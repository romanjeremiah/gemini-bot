import * as telegram from '../lib/telegram';

// Hardcoded free effects (always available, stable IDs)
// See: https://core.telegram.org/api/effects
// See: https://core.telegram.org/constructor/availableEffect
//
// The Bot API has no endpoint to list effects (messages.getAvailableEffects is MTProto-only).
// Premium effects are dynamic and sticker-based — their IDs are discovered at runtime
// when users send messages with effects. The bot auto-stores them in KV.
const BASE_EFFECTS = {
	hearts:   { id: "5159385139981059251", emoji: "❤️",  premium: false },
	like:     { id: "5107584321108051014", emoji: "👍",  premium: false },
	dislike:  { id: "5104858069142078462", emoji: "👎",  premium: false },
	fire:     { id: "5070445174516318631", emoji: "🔥",  premium: false },
	confetti: { id: "5066970843586925436", emoji: "🎉",  premium: false },
	poop:     { id: "5046589136895476101", emoji: "💩",  premium: false },
};

// ---- Dynamic effect discovery ----
// When a user sends a message with a premium effect, Telegram includes the effect_id
// in the update. We store { effectId -> emoji } in KV so the bot can reuse it.

// Store a discovered effect in KV (called from index.js when effect_id is seen)
export async function storeDiscoveredEffect(env, effectId, emoji) {
	// Store in both directions for lookup:
	// effect_emoji_{emoji} -> effectId (lookup by emoji/name)
	// effect_id_{effectId} -> emoji (reverse lookup)
	if (emoji) {
		await env.CHAT_KV.put(`effect_emoji_${emoji}`, effectId);
		await env.CHAT_KV.put(`effect_id_${effectId}`, emoji);
	}

	// Also add to the master list of discovered effects
	let discovered = {};
	try {
		const raw = await env.CHAT_KV.get("discovered_effects", { type: "json" });
		if (raw) discovered = raw;
	} catch {}
	discovered[effectId] = emoji || "unknown";
	await env.CHAT_KV.put("discovered_effects", JSON.stringify(discovered));
}

// Get all available effects (hardcoded + discovered from KV)
async function getAllEffects(env) {
	const effects = { ...BASE_EFFECTS };

	// Load dynamically discovered effects from KV
	try {
		const discovered = await env.CHAT_KV.get("discovered_effects", { type: "json" });
		if (discovered) {
			for (const [effectId, emoji] of Object.entries(discovered)) {
				// Skip if already in base effects
				const alreadyExists = Object.values(effects).some(e => e.id === effectId);
				if (!alreadyExists) {
					// Use emoji as the key name, or generate one from the ID
					const name = emoji !== "unknown" ? emoji : `premium_${effectId.slice(-6)}`;
					effects[name] = { id: effectId, emoji: emoji || "✨", premium: true };
				}
			}
		}
	} catch {}

	return effects;
}

// Resolve an effect by name, emoji, or ID
async function resolveEffect(query, env) {
	const q = query.toLowerCase().trim();
	const allEffects = await getAllEffects(env);

	// 1. Match by name (e.g., "hearts", "fire")
	if (allEffects[q]) return allEffects[q];

	// 2. Match by emoji (e.g., "❤️", "🔥")
	for (const info of Object.values(allEffects)) {
		if (info.emoji === q) return info;
	}

	// 3. Match by effect ID directly (for power users)
	for (const info of Object.values(allEffects)) {
		if (info.id === q) return info;
	}

	// 4. Check KV for a dynamically discovered emoji match
	const kvId = await env.CHAT_KV.get(`effect_emoji_${q}`);
	if (kvId) return { id: kvId, emoji: q, premium: true };

	return null;
}

export const effectTool = {
	definition: {
		name: "send_with_effect",
		description: `Send a message with a full-screen animated Telegram effect. Use sparingly for genuinely impactful moments. Built-in effects: hearts (❤️ emotional breakthroughs, love), like (👍 approval, encouragement), dislike (👎 playful disapproval), fire (🔥 hype, excitement), confetti (🎉 celebrations, achievements, milestones), poop (💩 playful teasing). Additional premium effects can be discovered dynamically. Do NOT overuse. Reserve for moments that truly deserve emphasis.`,
		parameters: {
			type: "OBJECT",
			properties: {
				text: {
					type: "STRING",
					description: "The message text to send with the effect."
				},
				effect: {
					type: "STRING",
					description: "Effect name (hearts, like, dislike, fire, confetti, poop), an emoji, or an effect ID."
				}
			},
			required: ["text", "effect"]
		}
	},
	async execute(args, env, context) {
		const effectInfo = await resolveEffect(args.effect, env);

		if (!effectInfo) {
			const baseNames = Object.keys(BASE_EFFECTS).join(", ");
			return { status: "error", message: `Unknown effect "${args.effect}". Built-in: ${baseNames}. Send a message with a premium effect to teach me new ones.` };
		}

		const res = await telegram.sendMessage(
			context.chatId,
			context.threadId,
			args.text,
			env,
			context.messageId,
			null,
			effectInfo.id
		);

		return {
			status: res?.ok ? "success" : "error",
			effect: args.effect,
			emoji: effectInfo.emoji,
			premium: effectInfo.premium || false
		};
	}
};

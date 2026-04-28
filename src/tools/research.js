import * as telegram from '../lib/telegram';
import { safeLike } from '../lib/db';

/**
 * Research Tool — lets Gemini search, list, and retrieve deep research results conversationally.
 *
 * Natural triggers: "recent discoveries", "what have you learned", "show me your findings",
 * "research history", "past research", "what did you study", "recent learnings"
 */
export const searchResearchTool = {
	definition: {
		name: "search_research",
		description: "Search and retrieve past deep research results. Use this when the user asks about previous research, recent discoveries, past learnings, what you have studied, your findings, what you have learned recently, or anything related to viewing research history. Actions: 'list' shows an interactive list with buttons, 'full' retrieves a complete report, 'audio' sends a report as a voice message.",
		parameters: {
			type: "OBJECT",
			properties: {
				action: {
					type: "STRING",
					enum: ["list", "full", "audio"],
					description: "'list' to show interactive research list with buttons. 'full' to get the complete text report. 'audio' to send the report as a voice message."
				},
				topic: {
					type: "STRING",
					description: "Search term to filter or retrieve a specific research topic. For 'full' and 'audio' actions, this selects which report to retrieve."
				},
				index: {
					type: "NUMBER",
					description: "1-based index from the research list. Use this when the user says 'number 2' or 'the second one' after seeing the list."
				}
			},
			required: ["action"]
		}
	},
	async execute(args, env, context) {
		const chatId = context.chatId;
		const userId = context.userId;
		const threadId = context.threadId || 'default';

		// Sanitise topic for D1 LIKE query safety
		const cleanTopic = safeLike(args.topic);

		if (args.action === 'list') {
			const { results } = await env.DB.prepare(
				`SELECT id, fact, category, created_at FROM memories WHERE user_id = ? AND fact LIKE 'Deep Research%' ORDER BY created_at DESC LIMIT 10`
			).bind(userId).all();

			if (!results?.length) return { status: "empty", message: "No deep research results found yet. Ask me to research any topic and I will investigate it deeply." };

			// Build numbered list — uses the user's stored timezone for date display
			const userTz = await env.CHAT_KV.get(`timezone_${chatId}`) || 'Etc/UTC';
			const items = results.map((r, i) => {
				const topicMatch = r.fact.match(/^Deep Research \(([^)]+)\):/);
				const topic = topicMatch ? topicMatch[1] : 'Unknown topic';
				const date = new Date(r.created_at + 'Z').toLocaleDateString('en-GB', {
					timeZone: userTz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
				});
				const summary = r.fact.replace(/^Deep Research \([^)]+\):\s*/, '').slice(0, 120);
				return { num: i + 1, topic, date, summary, category: r.category, id: r.id };
			});

			let text = '<b>Recent Research</b>\n\n';
			items.forEach(item => {
				text += `<b>${item.num}.</b> ${item.topic}\n<i>${item.date}</i> [${item.category}]\n${item.summary}...\n\n`;
			});

			// Build inline buttons: rows of [📝 Text] [🔊 Audio] per item
			const buttons = items.slice(0, 5).map(item => ([
				{ text: `📝 ${item.num}`, callback_data: `research_text_${item.num}` },
				{ text: `🔊 ${item.num}`, callback_data: `research_audio_${item.num}` },
			]));

			// Send the interactive message directly
			await telegram.sendMessage(chatId, threadId, text, env, null, { inline_keyboard: buttons });

			// Cache the list in KV so button callbacks can look up which topic was #1, #2, etc.
			const indexMap = items.reduce((acc, item) => {
				acc[item.num] = item.topic;
				return acc;
			}, {});
			await env.CHAT_KV.put(`research_list_${chatId}`, JSON.stringify(indexMap), { expirationTtl: 3600 });

			return { status: "sent_interactive", message: "I have sent an interactive list. The user can tap buttons to get text or audio for each result." };
		}

		if (args.action === 'full' || args.action === 'audio') {
			// Resolve topic from index if provided
			let searchTopic = cleanTopic;
			if (args.index && !searchTopic) {
				const indexMap = await env.CHAT_KV.get(`research_list_${chatId}`, { type: 'json' });
				if (indexMap && indexMap[args.index]) {
					searchTopic = indexMap[args.index];
				}
			}

			if (!searchTopic) return { status: "error", message: "Please specify which research topic, or say a number from the list." };

			// Sanitise for LIKE query
			const safeTopic = safeLike(searchTopic);

			// Try R2 full report first
			const { results: refs } = await env.DB.prepare(
				`SELECT fact FROM memories WHERE user_id = ? AND category = 'research_ref' AND fact LIKE ? ORDER BY created_at DESC LIMIT 1`
			).bind(userId, `%${safeTopic}%`).all();

			let reportText = null;

			if (refs?.length) {
				const keyMatch = refs[0].fact.match(/\[R2:([^\]]+)\]/);
				if (keyMatch && env.MEDIA_BUCKET) {
					const obj = await env.MEDIA_BUCKET.get(keyMatch[1]);
					if (obj) reportText = await obj.text();
				}
			}

			// Fallback: use the D1 summary if no R2 report
			if (!reportText) {
				const { results: summaries } = await env.DB.prepare(
					`SELECT fact FROM memories WHERE user_id = ? AND fact LIKE ? ORDER BY created_at DESC LIMIT 1`
				).bind(userId, `%Deep Research%${safeTopic}%`).all();
				if (summaries?.length) {
					reportText = summaries[0].fact.replace(/^Deep Research \([^)]+\):\s*/, '');
				}
			}

			if (!reportText) return { status: "not_found", message: `No report found matching "${searchTopic}".` };

			if (args.action === 'audio') {
				return {
					status: "success",
					action: "audio",
					topic: searchTopic,
					textForVoice: reportText.slice(0, 4000),
					instructions: "Use the voice tool to send this text as audio to the user."
				};
			}

			return {
				status: "success",
				topic: searchTopic,
				report: reportText,
				charCount: reportText.length,
				instructions: "Present this report in digestible sections. After sharing, ask if the user wants it as audio."
			};
		}

		return { status: "error", message: "Use 'list', 'full', or 'audio'." };
	}
};

/**
 * Start Research Tool — lets Gemini trigger deep research conversationally.
 */
export const startResearchTool = {
	definition: {
		name: "start_deep_research",
		description: "Start a deep research task on any topic. Use this when the user asks you to research something, investigate a topic, look into something, or find out about something in depth. The research runs in the background for 2-5 minutes and results are sent when ready.",
		parameters: {
			type: "OBJECT",
			properties: {
				topic: { type: "STRING", description: "The topic to research thoroughly" }
			},
			required: ["topic"]
		}
	},
	async execute(args, env, context) {
		if (!env.RESEARCH_WORKFLOW) return { status: "error", message: "Deep Research Workflow is not available." };

		const instanceId = `research-${Date.now()}`;
		await env.RESEARCH_WORKFLOW.create({
			id: instanceId,
			params: { chatId: context.chatId, topic: args.topic, manual: true }
		});

		return {
			status: "started",
			instanceId,
			topic: args.topic,
			message: `Deep research started on "${args.topic}". This will take 2-5 minutes. I will send you the findings when ready.`
		};
	}
};

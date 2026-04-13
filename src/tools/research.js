/**
 * Research Tool — lets Gemini search, list, and retrieve deep research results conversationally.
 * Replaces /researchhistory and /researchfull commands.
 */
export const searchResearchTool = {
	definition: {
		name: "search_research",
		description: "Search and retrieve past deep research results. Use this when the user asks about previous research, wants to see what topics were studied, or requests the full report on a specific topic. Actions: 'list' shows recent summaries, 'full' retrieves the complete report for a topic.",
		parameters: {
			type: "OBJECT",
			properties: {
				action: { type: "STRING", enum: ["list", "full"], description: "'list' to show recent research summaries, 'full' to get the complete report for a topic" },
				topic: { type: "STRING", description: "Optional search term to filter results by topic. Required for 'full' action." }
			},
			required: ["action"]
		}
	},
	async execute(args, env, context) {
		const chatId = context.chatId;

		// Sanitise topic: strip special chars, limit length for D1 LIKE queries
		const cleanTopic = (args.topic || '')
			.replace(/[%_\\'";\n\r]/g, '')
			.trim()
			.split(/\s+/).slice(0, 6).join(' ');

		if (args.action === 'list') {
			let query = `SELECT fact, category, created_at FROM memories WHERE chat_id = ? AND fact LIKE 'Deep Research%' ORDER BY created_at DESC LIMIT 10`;
			const { results } = await env.DB.prepare(query).bind(chatId).all();
			if (!results?.length) return { status: "empty", message: "No deep research results found." };

			const items = results.map(r => {
				const topicMatch = r.fact.match(/^Deep Research \(([^)]+)\):/);
				return {
					topic: topicMatch ? topicMatch[1] : 'Unknown',
					category: r.category,
					date: r.created_at,
					summary: r.fact.replace(/^Deep Research \([^)]+\):\s*/, '').slice(0, 300)
				};
			});
			return { status: "success", count: items.length, results: items };
		}

		if (args.action === 'full') {
			if (!cleanTopic) return { status: "error", message: "Please specify a topic keyword to retrieve the full report." };

			// Find the R2 reference
			const { results } = await env.DB.prepare(
				`SELECT fact FROM memories WHERE chat_id = ? AND category = 'research_ref' AND fact LIKE ? ORDER BY created_at DESC LIMIT 1`
			).bind(chatId, `%${cleanTopic}%`).all();

			if (!results?.length) return { status: "not_found", message: `No full report found matching "${cleanTopic}". Use action 'list' first to see available topics.` };

			const keyMatch = results[0].fact.match(/\[R2:([^\]]+)\]/);
			if (!keyMatch || !env.MEDIA_BUCKET) return { status: "error", message: "Full report reference not available." };

			const obj = await env.MEDIA_BUCKET.get(keyMatch[1]);
			if (!obj) return { status: "error", message: "Full report not found in storage. It may have been cleaned up." };

			const fullReport = await obj.text();
			return {
				status: "success",
				topic: args.topic,
				report: fullReport.slice(0, 10000), // Cap at 10K chars for context window safety
				truncated: fullReport.length > 10000
			};
		}

		return { status: "error", message: "Invalid action. Use 'list' or 'full'." };
	}
};

/**
 * Start Research Tool — lets Gemini trigger deep research conversationally.
 * Replaces the /research command.
 */
export const startResearchTool = {
	definition: {
		name: "start_deep_research",
		description: "Start a deep research task on any topic. Use this when the user asks you to research something, investigate a topic, or find out about something in depth. The research runs in the background for 2-5 minutes and results are sent when ready.",
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

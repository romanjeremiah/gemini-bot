export const fetchTool = {
	definition: {
		name: "read_webpage",
		description: "Fetch and read the plain text content of a webpage URL. Use this to read full articles, API documentation, or scientific papers after finding their URL via googleSearch. Returns stripped text content.",
		parameters: {
			type: "OBJECT",
			properties: {
				url: { type: "STRING", description: "The full URL to read." }
			},
			required: ["url"]
		}
	},
	async execute(args) {
		try {
			const res = await fetch(args.url, {
				headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GeminiBot/1.0)' },
				cf: { cacheTtl: 300 }
			});
			if (!res.ok) return { status: "error", message: `HTTP ${res.status}` };

			const html = await res.text();
			let text = html
				.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
				.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
				.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
				.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
				.replace(/<[^>]+>/g, ' ')
				.replace(/&nbsp;/g, ' ')
				.replace(/&amp;/g, '&')
				.replace(/&lt;/g, '<')
				.replace(/&gt;/g, '>')
				.replace(/\s+/g, ' ')
				.trim();

			// Cap at 12000 chars to stay within reasonable token limits
			if (text.length > 12000) text = text.slice(0, 12000) + '\n[...truncated]';

			return { status: "success", content: text, url: args.url, length: text.length };
		} catch (e) {
			return { status: "error", message: e.message };
		}
	}
};


export const tavilySearchTool = {
	definition: {
		name: "web_search_tavily",
		description: "Search the web for current, accurate information using Tavily's AI-optimised search. Returns clean, structured text with citations. Use this for any factual question, current events, latest developments, or research. Much better than raw Google Search for getting LLM-ready content.",
		parameters: {
			type: "OBJECT",
			properties: {
				query: { type: "STRING", description: "The search query" },
				topic: { type: "STRING", enum: ["general", "news"], description: "Type of search. Use 'news' for current events." },
				max_results: { type: "NUMBER", description: "Number of results (default 5, max 10)" }
			},
			required: ["query"]
		}
	},
	async execute(args, env) {
		if (!env.TAVILY_API_KEY) {
			return { status: "error", message: "Tavily API key not configured. Use googleSearch instead." };
		}
		try {
			const { tavilySearch } = await import('../services/tavily');
			const result = await tavilySearch(args.query, env, {
				topic: args.topic || 'general',
				maxResults: Math.min(args.max_results || 5, 10),
				depth: 'basic',
			});
			return {
				status: "success",
				answer: result.answer,
				results: result.results.map(r => ({
					title: r.title,
					url: r.url,
					content: r.content?.slice(0, 500),
				})),
				responseTime: result.responseTime,
			};
		} catch (e) {
			return { status: "error", message: e.message };
		}
	}
};

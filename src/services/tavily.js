/**
 * Tavily Search Service — AI-optimised web search for Xaridotis.
 *
 * Returns clean, LLM-ready text with citations instead of raw search snippets.
 * Used by /architect and the web search tool for higher quality research.
 *
 * Free tier: 1,000 searches/month (basic = 1 credit, advanced = 2 credits).
 * API docs: https://docs.tavily.com
 */

const TAVILY_API = 'https://api.tavily.com/search';

/**
 * Search the web using Tavily's AI-optimised search engine.
 *
 * @param {string} query - Search query
 * @param {object} env - Worker environment (needs TAVILY_API_KEY)
 * @param {object} options - Search options
 * @returns {object} { answer, results: [{ title, url, content, score }] }
 */
export async function tavilySearch(query, env, options = {}) {
	const apiKey = env.TAVILY_API_KEY;
	if (!apiKey) throw new Error('TAVILY_API_KEY not configured');

	const payload = {
		query,
		search_depth: options.depth || 'advanced',
		max_results: options.maxResults || 5,
		include_answer: options.includeAnswer ?? true,
		include_raw_content: false,
		topic: options.topic || 'general',
	};

	if (options.includeDomains) payload.include_domains = options.includeDomains;
	if (options.excludeDomains) payload.exclude_domains = options.excludeDomains;
	if (options.timeRange) payload.time_range = options.timeRange;

	const res = await fetch(TAVILY_API, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(payload),
	});

	if (!res.ok) {
		const err = await res.text().catch(() => 'Unknown error');
		throw new Error(`Tavily API error ${res.status}: ${err}`);
	}

	const data = await res.json();
	return {
		answer: data.answer || null,
		results: (data.results || []).map(r => ({
			title: r.title,
			url: r.url,
			content: r.content,
			score: r.score,
		})),
		responseTime: data.response_time,
	};
}


/**
 * Format Tavily results as a clean context string for Gemini prompts.
 * Much richer than Google Search snippets.
 */
export function formatTavilyForContext(tavilyResult, maxLen = 4000) {
	let ctx = '';

	if (tavilyResult.answer) {
		ctx += `QUICK ANSWER: ${tavilyResult.answer}\n\n`;
	}

	ctx += 'SOURCES:\n';
	for (const r of tavilyResult.results) {
		const entry = `[${r.title}] (${r.url})\n${r.content}\n\n`;
		if (ctx.length + entry.length > maxLen) break;
		ctx += entry;
	}

	return ctx;
}

/**
 * Run multiple Tavily searches in parallel for comprehensive research.
 * Used by /architect to search across multiple domains simultaneously.
 */
export async function tavilyMultiSearch(queries, env, options = {}) {
	const results = await Promise.allSettled(
		queries.map(q => tavilySearch(q, env, options))
	);

	const combined = { answer: null, results: [] };
	const seen = new Set();

	for (const r of results) {
		if (r.status !== 'fulfilled') continue;
		if (!combined.answer && r.value.answer) combined.answer = r.value.answer;
		for (const item of r.value.results) {
			if (seen.has(item.url)) continue;
			seen.add(item.url);
			combined.results.push(item);
		}
	}

	// Sort by relevance score
	combined.results.sort((a, b) => (b.score || 0) - (a.score || 0));
	return combined;
}

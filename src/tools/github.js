export const githubReadTool = {
	definition: {
		name: "read_repo_file",
		description: "Read the raw content of a specific file from the bot's GitHub repository. Use this to inspect the current code before suggesting improvements. Common paths: src/index.js, src/bot/handlers.js, src/config/personas.js, src/lib/ai/gemini.js, src/services/memoryStore.js, src/tools/index.js",
		parameters: {
			type: "OBJECT",
			properties: {
				file_path: { type: "STRING", description: "The path to the file, e.g., 'src/index.js' or 'src/bot/handlers.js'" }
			},
			required: ["file_path"]
		}
	},
	async execute(args, env) {
		const repo = 'romanjeremiah/gemini-bot';
		if (!env.GITHUB_TOKEN) return { status: 'error', message: 'GITHUB_TOKEN not configured' };
		try {
			const res = await fetch(`https://api.github.com/repos/${repo}/contents/${args.file_path}`, {
				headers: {
					'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
					'Accept': 'application/vnd.github.v3.raw',
					'User-Agent': 'GeminiBot',
					'X-GitHub-Api-Version': '2022-11-28'
				}
			});
			if (!res.ok) return { status: 'error', message: `File not found: ${args.file_path} (${res.status})` };
			const text = await res.text();
			return { status: 'success', file: args.file_path, content: text.slice(0, 15000), lines: text.split('\n').length };
		} catch (e) {
			return { status: 'error', message: e.message };
		}
	}
};

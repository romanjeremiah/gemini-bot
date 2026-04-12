import { Buffer } from 'node:buffer';

const REPO = 'romanjeremiah/gemini-bot';

function ghHeaders(env) {
	return {
		'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
		'Accept': 'application/vnd.github.v3+json',
		'User-Agent': 'GeminiBot',
		'X-GitHub-Api-Version': '2022-11-28'
	};
}

// ---- Read a file from the bot's own repo ----
export const githubReadTool = {
	definition: {
		name: "read_repo_file",
		description: "Read the raw content of a specific file from the bot's GitHub repository. Use this to inspect current code before suggesting changes. Common paths: src/index.js, src/bot/handlers.js, src/config/personas.js, src/lib/ai/gemini.js, src/tools/index.js, package.json, wrangler.jsonc",
		parameters: {
			type: "OBJECT",
			properties: {
				file_path: { type: "STRING", description: "Path to the file, e.g., 'src/index.js'" }
			},
			required: ["file_path"]
		}
	},
	async execute(args, env) {
		if (!env.GITHUB_TOKEN) return { status: 'error', message: 'GITHUB_TOKEN not configured' };
		try {
			const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${args.file_path}`, {
				headers: { ...ghHeaders(env), 'Accept': 'application/vnd.github.v3.raw' }
			});
			if (!res.ok) return { status: 'error', message: `File not found: ${args.file_path} (${res.status})` };
			const text = await res.text();
			return { status: 'success', file: args.file_path, content: text.slice(0, 15000), lines: text.split('\n').length };
		} catch (e) { return { status: 'error', message: e.message }; }
	}
};

// ---- Patch a file via Pull Request (safe, branch-based) ----
export const githubPatchTool = {
	definition: {
		name: "patch_repo_file",
		description: "Apply a small, targeted edit to a file in the bot's GitHub repository by opening a Pull Request. Use this ONLY after reading the file with read_repo_file, proposing the change, and getting explicit permission from the user. The edit works like find-and-replace: specify the exact old text and the new text to replace it with.",
		parameters: {
			type: "OBJECT",
			properties: {
				file_path: { type: "STRING", description: "Path to the file to edit, e.g., 'src/bot/handlers.js'" },
				old_text: { type: "STRING", description: "The exact text to find in the file (must match precisely)." },
				new_text: { type: "STRING", description: "The replacement text." },
				commit_message: { type: "STRING", description: "A concise commit message describing the change." },
				pr_title: { type: "STRING", description: "Title for the Pull Request." },
				pr_body: { type: "STRING", description: "Explanation of what this PR does and why." }
			},
			required: ["file_path", "old_text", "new_text", "commit_message", "pr_title", "pr_body"]
		}
	},
	async execute(args, env) {
		if (!env.GITHUB_TOKEN) return { status: 'error', message: 'GITHUB_TOKEN not configured' };
		const headers = ghHeaders(env);

		try {
			// 1. Read current file content
			const fileRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${args.file_path}`, { headers });
			if (!fileRes.ok) return { status: 'error', message: `File not found: ${args.file_path}` };
			const fileData = await fileRes.json();
			const currentContent = Buffer.from(fileData.content, 'base64').toString('utf-8');

			// 2. Verify old_text exists exactly once
			const occurrences = currentContent.split(args.old_text).length - 1;
			if (occurrences === 0) return { status: 'error', message: 'old_text not found in file. Use read_repo_file to check the exact content.' };
			if (occurrences > 1) return { status: 'error', message: `old_text found ${occurrences} times. It must be unique. Use a longer snippet.` };

			// 3. Apply the patch
			const newContent = currentContent.replace(args.old_text, args.new_text);

			// 4. Create branch
			const branchName = `patch-${Date.now()}`;
			const refRes = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/main`, { headers });
			const refData = await refRes.json();

			await fetch(`https://api.github.com/repos/${REPO}/git/refs`, {
				method: 'POST', headers,
				body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: refData.object.sha })
			});

			// 5. Commit the patched file
			await fetch(`https://api.github.com/repos/${REPO}/contents/${args.file_path}`, {
				method: 'PUT', headers,
				body: JSON.stringify({
					message: args.commit_message,
					content: Buffer.from(newContent).toString('base64'),
					sha: fileData.sha,
					branch: branchName
				})
			});

			// 6. Open Pull Request
			const prRes = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
				method: 'POST', headers,
				body: JSON.stringify({
					title: args.pr_title,
					body: `${args.pr_body}\n\n---\n**File:** \`${args.file_path}\`\n**Change:** Find-and-replace patch (${args.old_text.length} chars → ${args.new_text.length} chars)`,
					head: branchName, base: 'main'
				})
			});
			const prData = await prRes.json();

			if (!prData.html_url) return { status: 'error', message: prData.message || 'PR creation failed' };
			return { status: 'success', pr_url: prData.html_url, branch: branchName };
		} catch (e) { return { status: 'error', message: e.message }; }
	}
};

// ---- Explore open-source repos on GitHub ----
export const githubExploreTool = {
	definition: {
		name: "explore_github",
		description: "Search GitHub for open-source projects, code patterns, or documentation. Use this to discover how other developers build chatbots, AI companions, or Cloudflare Workers projects. Returns repository names, descriptions, stars, and README snippets.",
		parameters: {
			type: "OBJECT",
			properties: {
				query: { type: "STRING", description: "Search query, e.g., 'telegram bot cloudflare workers', 'therapeutic AI chatbot', 'gemini api advanced tools'" },
				search_type: { type: "STRING", description: "'repositories' to find projects, 'code' to find specific code patterns." }
			},
			required: ["query"]
		}
	},
	async execute(args, env) {
		if (!env.GITHUB_TOKEN) return { status: 'error', message: 'GITHUB_TOKEN not configured' };
		const searchType = args.search_type || 'repositories';
		const headers = ghHeaders(env);

		try {
			const q = encodeURIComponent(args.query);
			const url = searchType === 'code'
				? `https://api.github.com/search/code?q=${q}&per_page=5&sort=indexed`
				: `https://api.github.com/search/repositories?q=${q}&per_page=5&sort=stars&order=desc`;

			const res = await fetch(url, { headers });
			if (!res.ok) return { status: 'error', message: `GitHub search failed (${res.status})` };
			const data = await res.json();

			if (searchType === 'code') {
				const results = (data.items || []).map(item => ({
					repo: item.repository?.full_name,
					file: item.path,
					url: item.html_url,
					snippet: item.text_matches?.[0]?.fragment?.slice(0, 300) || 'No preview'
				}));
				return { status: 'success', type: 'code', count: results.length, results };
			} else {
				const results = (data.items || []).map(item => ({
					name: item.full_name,
					description: item.description?.slice(0, 200) || 'No description',
					stars: item.stargazers_count,
					language: item.language,
					url: item.html_url,
					updated: item.updated_at?.split('T')[0]
				}));
				return { status: 'success', type: 'repositories', count: results.length, results };
			}
		} catch (e) { return { status: 'error', message: e.message }; }
	}
};

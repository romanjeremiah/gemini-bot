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
		description: "Apply targeted edits to a file in the bot's GitHub repository by opening a Pull Request. Use ONLY after reading the file with read_repo_file, proposing the change, and getting explicit permission. Supports single edit (old_text/new_text) or multiple edits (replacements array). Each edit must match exactly once in the file.",
		parameters: {
			type: "OBJECT",
			properties: {
				file_path: { type: "STRING", description: "Path to the file to edit, e.g., 'src/bot/handlers.js'" },
				old_text: { type: "STRING", description: "For single edit: exact text to find (must match once)." },
				new_text: { type: "STRING", description: "For single edit: the replacement text." },
				replacements: {
					type: "ARRAY",
					description: "For multiple edits in one PR. Each item has 'find' (exact text) and 'replace' (new text). Every find must be unique in the file.",
					items: {
						type: "OBJECT",
						properties: {
							find: { type: "STRING", description: "Exact existing text to find. Must match once." },
							replace: { type: "STRING", description: "New text to replace it with." }
						}
					}
				},
				new_file_content: { type: "STRING", description: "For creating NEW files only. Complete file content." },
				commit_message: { type: "STRING", description: "A concise commit message." },
				pr_title: { type: "STRING", description: "Title for the Pull Request." },
				pr_body: { type: "STRING", description: "Explanation of what this PR does." }
			},
			required: ["file_path", "commit_message", "pr_title", "pr_body"]
		}
	},
	async execute(args, env) {
		if (!env.GITHUB_TOKEN) return { status: 'error', message: 'GITHUB_TOKEN not configured' };
		const headers = ghHeaders(env);

		try {
			// 1. Read current file (or confirm it doesn't exist for new files)
			const fileRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${args.file_path}`, { headers });
			let currentContent = '';
			let fileSha = null;

			if (fileRes.ok) {
				const fileData = await fileRes.json();
				fileSha = fileData.sha;
				currentContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
			} else if (fileRes.status === 404 && args.new_file_content) {
				// New file creation
				currentContent = null;
			} else if (fileRes.status === 404) {
				return { status: 'error', message: `File not found: ${args.file_path}. Use new_file_content to create a new file.` };
			}

			// 2. Build the patched content
			let finalContent;

			if (currentContent === null) {
				// New file
				finalContent = args.new_file_content;
			} else if (args.replacements && args.replacements.length > 0) {
				// Multiple replacements
				finalContent = currentContent;
				for (const patch of args.replacements) {
					const occurrences = finalContent.split(patch.find).length - 1;
					if (occurrences === 0) return { status: 'error', message: `Patch failed: "${patch.find.slice(0, 40)}..." not found. Use read_repo_file to verify.` };
					if (occurrences > 1) return { status: 'error', message: `Patch failed: "${patch.find.slice(0, 40)}..." found ${occurrences} times. Use a longer snippet.` };
					finalContent = finalContent.replace(patch.find, patch.replace);
				}
			} else if (args.old_text && args.new_text !== undefined) {
				// Single replacement
				const occurrences = currentContent.split(args.old_text).length - 1;
				if (occurrences === 0) return { status: 'error', message: 'old_text not found. Use read_repo_file to check the exact content.' };
				if (occurrences > 1) return { status: 'error', message: `old_text found ${occurrences} times. Use a longer snippet.` };
				finalContent = currentContent.replace(args.old_text, args.new_text);
			} else {
				return { status: 'error', message: 'Provide old_text/new_text, replacements array, or new_file_content.' };
			}

			// 3. Create branch
			const branchName = `patch-${Date.now()}`;
			const refRes = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/main`, { headers });
			const refData = await refRes.json();

			const branchRes = await fetch(`https://api.github.com/repos/${REPO}/git/refs`, {
				method: 'POST', headers,
				body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: refData.object.sha })
			});
			if (!branchRes.ok) return { status: 'error', message: 'Failed to create branch' };

			// 4. Commit
			const commitPayload = {
				message: args.commit_message,
				content: Buffer.from(finalContent).toString('base64'),
				branch: branchName
			};
			if (fileSha) commitPayload.sha = fileSha;

			const commitRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${args.file_path}`, {
				method: 'PUT', headers, body: JSON.stringify(commitPayload)
			});
			if (!commitRes.ok) return { status: 'error', message: 'Failed to commit file' };

			// 5. Open PR
			const patchCount = args.replacements?.length || 1;
			const prRes = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
				method: 'POST', headers,
				body: JSON.stringify({
					title: args.pr_title,
					body: `${args.pr_body}\n\n---\n**File:** \`${args.file_path}\`\n**Edits:** ${patchCount} patch(es)`,
					head: branchName, base: 'main'
				})
			});
			const prData = await prRes.json();

			if (!prData.html_url) return { status: 'error', message: prData.message || 'PR creation failed' };
			return { status: 'success', pr_url: prData.html_url, branch: branchName, patches_applied: patchCount };
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

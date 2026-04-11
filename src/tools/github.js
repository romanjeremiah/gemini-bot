export const githubTool = {
	definition: {
		name: "create_pull_request",
		description: "Modify a file in the user's GitHub repository and open a Pull Request. Use this for proposing code changes or architectural improvements.",
		parameters: {
			type: "OBJECT",
			properties: {
				file_path: { type: "STRING", description: "Path to the file, e.g., 'src/bot/handlers.js'" },
				new_content: { type: "STRING", description: "The complete, updated content of the file." },
				commit_message: { type: "STRING", description: "A brief description of the change." },
				pr_title: { type: "STRING", description: "Title for the Pull Request." },
				pr_body: { type: "STRING", description: "Technical explanation of the changes." }
			},
			required: ["file_path", "new_content", "commit_message", "pr_title", "pr_body"]
		}
	},
	async execute(args, env) {
		if (!env.GITHUB_TOKEN) return { status: "error", message: "GITHUB_TOKEN not found in env." };

		const repo = "romanjeremiah/gemini-bot";
		const headers = {
			"Authorization": `Bearer ${env.GITHUB_TOKEN}`,
			"Accept": "application/vnd.github+json",
			"User-Agent": "Nightfall-Bot",
			"X-GitHub-Api-Version": "2022-11-28"
		};

		try {
			// 1. Get Main Branch SHA
			const mainRef = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/main`, { headers }).then(r => r.json());
			const branchName = `bot-update-${Date.now()}`;

			// 2. Create New Branch
			await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
				method: "POST", headers,
				body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: mainRef.object.sha })
			});

			// 3. Get current file SHA (to update it)
			const fileData = await fetch(`https://api.github.com/repos/${repo}/contents/${args.file_path}`, { headers }).then(r => r.json());

			// 4. Commit Changes
			const { Buffer } = await import('node:buffer');
			await fetch(`https://api.github.com/repos/${repo}/contents/${args.file_path}`, {
				method: "PUT", headers,
				body: JSON.stringify({
					message: args.commit_message,
					content: Buffer.from(args.new_content).toString('base64'),
					sha: fileData.sha,
					branch: branchName
				})
			});

			// 5. Open Pull Request
			const pr = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
				method: "POST", headers,
				body: JSON.stringify({ title: args.pr_title, body: args.pr_body, head: branchName, base: "main" })
			}).then(r => r.json());

			return { status: "success", url: pr.html_url };
		} catch (e) {
			return { status: "error", message: e.message };
		}
	}
};

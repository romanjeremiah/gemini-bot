export const cloudflareAdminTool = {
	definition: {
		name: "manage_cloudflare",
		description: "Execute administrative tasks on Cloudflare services like D1, KV, and R2. Use this for cleanup, health checks, or infrastructure changes.",
		parameters: {
			type: "OBJECT",
			properties: {
				service: { type: "STRING", enum: ["D1", "KV", "R2", "Workers"] },
				action: { type: "STRING", description: "The task to perform, e.g., 'list_tables', 'clear_cache', 'inspect_storage'" },
				details: { type: "STRING", description: "Specific SQL queries or KV keys to target." }
			},
			required: ["service", "action"]
		}
	},
	async execute(args, env) {
		if (!env.CLOUDFLARE_ADMIN_TOKEN) return { status: "error", message: "Admin token missing." };

		// Example: Directly querying D1 for maintenance
		if (args.service === "D1" && args.action === "query") {
			const result = await env.DB.prepare(args.details).all();
			return { status: "success", data: result.results };
		}

		// Example: Clearing KV
		if (args.service === "KV" && args.action === "delete_prefix") {
			const list = await env.CHAT_KV.list({ prefix: args.details });
			for (const key of list.keys) {
				await env.CHAT_KV.delete(key.name);
			}
			return { status: "success", message: `Deleted ${list.keys.length} keys.` };
		}

		return { status: "error", message: "Action not yet implemented." };
	}
};

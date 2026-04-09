import * as telegram from '../lib/telegram';

// Build the checklist message text with progress info
function buildChecklistText(title, buttons) {
	const total = buttons.length;
	const done = buttons.filter(row => row[0].text.startsWith("✅")).length;
	const remaining = total - done;

	let text = `📝 <b>${title}</b>\n`;
	text += `<i>Checklist</i>\n\n`;

	const pct = total > 0 ? Math.round((done / total) * 100) : 0;
	const filled = Math.round(pct / 10);
	const bar = "▓".repeat(filled) + "░".repeat(10 - filled);
	text += `${bar} ${pct}%\n`;
	text += `<b>${done}</b> of <b>${total}</b> completed`;
	if (remaining > 0) text += ` · ${remaining} remaining`;
	if (done === total && total > 0) text += ` 🎉`;

	return text;
}

export const checklistTool = {
	definition: {
		name: "create_checklist",
		description: "Create a checklist with toggleable tasks. Use for step-by-step plans, shopping lists, to-do lists, or task breakdowns. Tasks can be marked as done by tapping them.",
		parameters: {
			type: "OBJECT",
			properties: {
				title: { type: "STRING", description: "The title of the checklist (e.g., 'Morning Routine'). Max 255 characters." },
				items: {
					type: "ARRAY",
					items: { type: "STRING" },
					description: "List of tasks (1-30 items)."
				}
			},
			required: ["title", "items"]
		}
	},
	async execute(args, env, context) {
		const kb = {
			inline_keyboard: args.items.map((item, idx) => ([{
				text: `☐  ${item}`,
				callback_data: `chk|${idx}|${args.title.slice(0, 40)}`
			}]))
		};

		const msgText = buildChecklistText(args.title, kb.inline_keyboard);

		await telegram.sendMessage(
			context.chatId,
			context.threadId,
			msgText,
			env,
			null,
			kb
		);

		return { status: "success", item_count: args.items.length };
	}
};

export { buildChecklistText };

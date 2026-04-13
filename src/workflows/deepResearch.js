import { WorkflowEntrypoint } from 'cloudflare:workers';

/**
 * Deep Research Workflow
 *
 * Uses the Gemini Interactions API to run Deep Research tasks in the background.
 * Each step is durable and independently retryable.
 *
 * Flow: Pick topic → Start Deep Research → Poll until complete → Save to memory → Notify user
 */
export class DeepResearchWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		const { chatId, topic, manual } = event.payload;
		if (!chatId || !topic) throw new Error('Missing chatId or topic in workflow payload');

		// Step 1: Start the Deep Research agent
		const interactionId = await step.do('start-research', {
			retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
			timeout: '30 seconds',
		}, async () => {
			const { GoogleGenAI } = await import('@google/genai');
			const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });

			const interaction = await ai.interactions.create({
				input: `Research this topic thoroughly: "${topic}". Find the most authoritative, recent, and practical information. Focus on concrete facts, techniques, or breakthroughs. Provide cited sources.`,
				agent: 'deep-research-pro-preview-12-2025',
				background: true,
			});

			if (!interaction?.id) throw new Error('Failed to start Deep Research interaction');
			console.log(`🔬 Deep Research started: ${interaction.id}`);
			return interaction.id;
		});

		// Step 2: Poll for results using step.sleep between checks
		// Deep Research can take 1-5 minutes. We poll every 15 seconds, up to 20 attempts (5 min).
		let researchOutput = null;
		for (let attempt = 0; attempt < 20; attempt++) {
			const pollResult = await step.do(`check-status-${attempt}`, {
				retries: { limit: 2, delay: '5 seconds', backoff: 'constant' },
				timeout: '30 seconds',
			}, async () => {
				const { GoogleGenAI } = await import('@google/genai');
				const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });
				const result = await ai.interactions.get(interactionId);

				if (result.status === 'completed') {
					const outputs = result.outputs || [];
					const textOutput = outputs.find(o => o.type === 'text' || o.text);
					const text = textOutput?.text || outputs[outputs.length - 1]?.text || '';
					return { done: true, text };
				}
				if (result.status === 'failed') {
					return { done: true, error: result.error || 'unknown' };
				}
				return { done: false, status: result.status };
			});

			if (pollResult.done) {
				if (pollResult.error) throw new Error(`Deep Research failed: ${pollResult.error}`);
				if (!pollResult.text) throw new Error('Deep Research completed but returned no text');
				researchOutput = pollResult.text;
				console.log(`🔬 Deep Research completed (attempt ${attempt}, ${researchOutput.length} chars)`);
				break;
			}

			// Sleep between polls (durable, doesn't consume CPU)
			await step.sleep(`wait-${attempt}`, '15 seconds');
		}

		if (!researchOutput) throw new Error('Deep Research timed out after 5 minutes');

		// Step 3: Save the full report to R2 for later retrieval
		const reportKey = await step.do('save-full-report', async () => {
			const key = `research/${chatId}/${Date.now()}_${topic.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 50)}.txt`;
			if (this.env.MEDIA_BUCKET) {
				await this.env.MEDIA_BUCKET.put(key, researchOutput, {
					customMetadata: { chatId: String(chatId), topic, createdAt: new Date().toISOString() }
				});
				console.log(`📄 Full research report saved to R2: ${key}`);
			}
			return key;
		});

		// Step 4: Synthesise and save summary to memory
		const savedInsight = await step.do('save-insight', async () => {
			const { GoogleGenAI } = await import('@google/genai');
			const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });

			// Compress the full research report into a concise learning note
			const response = await ai.models.generateContent({
				model: 'gemini-3-flash-preview',
				contents: [{ role: 'user', parts: [{ text: `You just completed deep research on: "${topic}".

Here is the full research report:
${researchOutput.slice(0, 15000)}

Synthesise this into a concise learning note (5-8 sentences). Capture:
1. The 2-3 most important findings
2. Why they matter practically
3. How this connects to other knowledge
4. One specific thing worth mentioning in casual conversation

Write as if noting this down for yourself.` }] }],
				config: { temperature: 0.5 }
			});

			const insight = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
			if (!insight || insight.length < 50) throw new Error('Failed to synthesise insight');

			// Save to D1
			const isTherapeutic = /therapy|adhd|ifs|dbt|schema|attachment|bipolar|emotion|mental/i.test(topic);
			const category = isTherapeutic ? 'growth' : 'discovery';
			const truncated = `Deep Research (${topic.split(' ').slice(0, 5).join(' ')}): ${insight.slice(0, 500)}`;

			await this.env.DB.prepare(
				'INSERT INTO memories (chat_id, category, fact, importance_score) VALUES (?, ?, ?, ?)'
			).bind(chatId, category, truncated, 2).run();

			// Also save the R2 key reference so we can find the full report
			await this.env.DB.prepare(
				'INSERT INTO memories (chat_id, category, fact, importance_score) VALUES (?, ?, ?, ?)'
			).bind(chatId, 'research_ref', `[R2:${reportKey}] Topic: ${topic}`, 0).run();

			console.log(`🧠 Deep Research insight saved: ${category}`);
			return { insight: truncated, category, reportKey };
		});

		// Step 4: Share results (always for manual triggers, 40% for automatic)
		await step.do('notify-user', async () => {
			if (!manual && Math.random() > 0.40) return { shared: false };

			const { GoogleGenAI } = await import('@google/genai');
			const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });

			const promptStyle = manual
				? `You just completed deep research on "${topic}" that Roman requested. Share the key findings in 3-5 sentences. Be thorough since they asked for this. Include the most actionable or surprising insight.`
				: `You just spent time doing deep research on: "${topic}". Send a casual 1-2 sentence text sharing the most interesting finding, like a friend who just read something cool. Do not ask a question.`;

			const response = await ai.models.generateContent({
				model: 'gemini-3-flash-preview',
				contents: [{ role: 'user', parts: [{ text: `${promptStyle}\n\nResearch findings: ${savedInsight.insight.slice(0, 500)}` }] }],
				config: { temperature: manual ? 0.5 : 0.8 }
			});

			const msg = response.candidates?.[0]?.content?.parts?.[0]?.text;
			if (msg) {
				await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_TOKEN}/sendMessage`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' }),
				});
			}
			return { shared: !!msg };
		});

		return {
			status: 'completed',
			topic,
			insightLength: savedInsight.insight.length,
			category: savedInsight.category,
		};
	}
}

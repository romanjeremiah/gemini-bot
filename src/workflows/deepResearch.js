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
		const { chatId, topic } = event.payload;
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

		// Step 2: Poll for results (Deep Research can take 1-5 minutes)
		const researchOutput = await step.do('poll-results', {
			retries: { limit: 2, delay: '30 seconds', backoff: 'linear' },
			timeout: '10 minutes',
		}, async () => {
			const { GoogleGenAI } = await import('@google/genai');
			const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });

			const maxAttempts = 60; // 60 * 10s = 10 minutes
			for (let i = 0; i < maxAttempts; i++) {
				const result = await ai.interactions.get(interactionId);

				if (result.status === 'completed') {
					// Extract text from the last output
					const outputs = result.outputs || [];
					const textOutput = outputs.find(o => o.type === 'text' || o.text);
					const text = textOutput?.text || outputs[outputs.length - 1]?.text || '';
					if (!text) throw new Error('Deep Research completed but returned no text');
					console.log(`🔬 Deep Research completed (${i * 10}s, ${text.length} chars)`);
					return text;
				}

				if (result.status === 'failed') {
					throw new Error(`Deep Research failed: ${result.error || 'unknown'}`);
				}

				// Wait 10 seconds before polling again
				await new Promise(resolve => setTimeout(resolve, 10000));
			}

			throw new Error('Deep Research timed out after 10 minutes');
		});

		// Step 3: Synthesise and save to memory
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

			console.log(`🧠 Deep Research insight saved: ${category}`);
			return { insight: truncated, category };
		});

		// Step 4: Optionally share with user (40% chance)
		await step.do('notify-user', async () => {
			if (Math.random() > 0.40) return { shared: false };

			const { GoogleGenAI } = await import('@google/genai');
			const ai = new GoogleGenAI({ apiKey: this.env.GEMINI_API_KEY });

			const response = await ai.models.generateContent({
				model: 'gemini-3-flash-preview',
				contents: [{ role: 'user', parts: [{ text: `You just spent time doing deep research on: "${topic}".
Here is what you learned: ${savedInsight.insight.slice(0, 300)}
Send a casual 1-2 sentence text sharing the most interesting finding, like a friend who just read something cool. Do not ask a question.` }] }],
				config: { temperature: 0.8 }
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

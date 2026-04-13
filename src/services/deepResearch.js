/**
 * Deep Research Service
 * Uses the Gemini Interactions API (Deep Research Agent) for multi-step
 * autonomous research. Falls back to standard Google Search if unavailable.
 *
 * Agent: deep-research-pro-preview-12-2025
 * API: Interactions API (not generateContent)
 */

const DEEP_RESEARCH_AGENT = 'deep-research-pro-preview-12-2025';
const POLL_INTERVAL_MS = 10000; // 10 seconds between polls
const MAX_POLL_ATTEMPTS = 30;   // 5 minutes max (30 × 10s)

/**
 * Run a Deep Research session.
 * Returns a structured report or null if the API is unavailable.
 *
 * @param {string} apiKey - Gemini API key
 * @param {string} query - Research topic
 * @returns {Promise<{text: string, status: string}|null>}
 */
export async function deepResearch(apiKey, query) {
	try {
		// 1. Start the research task
		const startRes = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': apiKey,
			},
			body: JSON.stringify({
				input: query,
				agent: DEEP_RESEARCH_AGENT,
				background: true,
			}),
		});

		if (!startRes.ok) {
			const err = await startRes.text();
			console.error(`Deep Research start failed (${startRes.status}):`, err);
			return null; // Signal to fall back to standard search
		}

		const startData = await startRes.json();
		const interactionId = startData.id || startData.name?.split('/')?.pop();
		if (!interactionId) {
			console.error('Deep Research: no interaction ID returned');
			return null;
		}

		console.log(`🔬 Deep Research started: ${interactionId}`);

		// 2. Poll for completion
		for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
			await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

			const pollRes = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/interactions/${interactionId}`,
				{ headers: { 'x-goog-api-key': apiKey } }
			);

			if (!pollRes.ok) continue;

			const pollData = await pollRes.json();
			const status = pollData.status || pollData.state;

			if (status === 'completed' || status === 'COMPLETED') {
				// Extract the final report from outputs
				const outputs = pollData.outputs || pollData.candidates || [];
				let reportText = '';

				for (const output of outputs) {
					if (output.text) reportText += output.text;
					else if (output.content?.parts) {
						for (const part of output.content.parts) {
							if (part.text) reportText += part.text;
						}
					}
				}

				if (!reportText && pollData.text) reportText = pollData.text;

				console.log(`🔬 Deep Research completed (${attempt + 1} polls, ~${reportText.length} chars)`);
				return { text: reportText, status: 'completed' };
			}

			if (status === 'failed' || status === 'FAILED' || status === 'cancelled' || status === 'CANCELLED') {
				console.error(`Deep Research ${status}`);
				return null;
			}

			// Still running, continue polling
		}

		console.warn('Deep Research timed out after max polls');
		return null;
	} catch (err) {
		console.error('Deep Research error:', err.message);
		return null;
	}
}

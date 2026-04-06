export function sanitizeTelegramHTML(text) {
	if (!text) return "";

	// 1. Strip truly illegal tags (keep valid Telegram HTML tags)
	// Valid: b, i, u, s, code, pre, a, tg-spoiler, blockquote
	let clean = text.replace(
		/<\/?(p|div|ul|ol|li|br|h[1-6]|span(?! class="tg-spoiler")|table|tr|td|th|thead|tbody|img|hr|section|article|nav|header|footer|main|aside|figure|figcaption)[^>]*>/gi,
		""
	);

	// 2. Convert common markdown that Gemini might produce
	clean = clean.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
	clean = clean.replace(/__(.*?)__/g, "<i>$1</i>");

	// 3. Stack-based tag balancer
	const tags = [];
	const tagRegex = /<\/?([a-z0-9-]+)(?:\s+[^>]*?)?>/gi;
	let match;

	while ((match = tagRegex.exec(clean)) !== null) {
		const fullTag = match[0];
		const tagName = match[1].toLowerCase();
		const isClosing = fullTag.startsWith('</');

		// Skip self-closing or void tags
		if (fullTag.endsWith('/>')) continue;

		if (isClosing) {
			if (tags.length > 0 && tags[tags.length - 1] === tagName) {
				tags.pop();
			} else {
				// Orphaned closing tag: remove it
				clean = clean.slice(0, match.index) + clean.slice(match.index + fullTag.length);
				tagRegex.lastIndex -= fullTag.length;
			}
		} else {
			tags.push(tagName);
		}
	}

	// 4. Close any remaining open tags (reverse order)
	while (tags.length > 0) {
		clean += `</${tags.pop()}>`;
	}

	// 5. Collapse excessive whitespace
	clean = clean.replace(/\n{3,}/g, "\n\n");

	return clean.trim();
}

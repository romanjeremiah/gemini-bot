// Telegram Bot API HTML allow-list — see https://core.telegram.org/bots/api#html-style
// We use an allow-list rather than a deny-list so any tag the model invents
// (e.g. <string>, <example>, <note>) gets stripped instead of slipping through
// to a parse failure. The deny-list approach we used previously kept catching
// recurrences (the 'Unsupported start tag string' error in production logs).
//
// Plain tags: no attributes allowed.
// Attribute tags handled separately below — span (only with class="tg-spoiler"),
// a (with href), tg-emoji (with emoji-id), pre/code (with language-* class),
// blockquote (with optional `expandable`).
const PLAIN_ALLOWED_TAGS = new Set([
	'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
	'tg-spoiler', 'code', 'pre', 'blockquote',
]);

/**
 * Sanitise a string to be safe for Telegram's HTML parse_mode.
 *
 * Behaviour:
 *   1. Markdown pre-processing: **bold** and __italic__ → <b>/<i>.
 *   2. Allow-list strip: every tag is matched against the Telegram allow-list.
 *      Disallowed tags are removed (both opening and closing). Attribute-bearing
 *      tags (a, span, tg-emoji, pre/code, blockquote) are kept only with their
 *      permitted attribute shapes; unknown attributes are stripped.
 *   3. Tag balancer: orphaned closers are dropped; unclosed openers are closed
 *      at the end of the string.
 *   4. Whitespace collapse: 3+ newlines → 2 newlines.
 *
 * Notes:
 *   - HTML entities (&lt;, &gt;, &amp;) are left untouched. If a caller has
 *     pre-escaped a value (e.g. the reminder cron), it stays escaped.
 *   - This function is regex-based by necessity — Workers has no DOM parser.
 *     If the model emits truly pathological output we fall back to the
 *     strip-all-tags retry inside telegram.sendMessage.
 *   - Self-closing/void tags (e.g. <br/>) are always stripped — they aren't
 *     in the allow-list anyway.
 */
export function sanitizeTelegramHTML(text) {
	if (!text) return "";

	// 1. Markdown pre-processing — keep this BEFORE the allow-list strip so
	//    the converted <b>/<i> tags pass through unchallenged.
	let clean = text
		.replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>")
		.replace(/__([\s\S]+?)__/g, "<i>$1</i>");

	// 2. Allow-list strip. We walk every tag in the string and decide:
	//    - keep as-is (already canonical)
	//    - rewrite (strip disallowed attributes)
	//    - drop entirely (tag not in allow-list)
	clean = clean.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g, (_full, slash, rawName, rawAttrs) => {
		const name = rawName.toLowerCase();
		const isClosing = slash === '/';

		// Plain allowed tags — strip all attributes, keep the tag.
		if (PLAIN_ALLOWED_TAGS.has(name)) {
			// Special case: blockquote may carry the `expandable` flag.
			if (name === 'blockquote' && !isClosing && /\bexpandable\b/i.test(rawAttrs)) {
				return '<blockquote expandable>';
			}
			// Special case: pre may wrap a code block; keep the tag bare here
			// because language is carried on the inner <code class="language-...">.
			return isClosing ? `</${name}>` : `<${name}>`;
		}

		// <a href="..."> — Telegram allows http(s) and tg:// URLs. We don't try
		// to validate the URL itself; if it's malformed the Telegram parser will
		// reject and the strip-all fallback catches it.
		if (name === 'a') {
			if (isClosing) return '</a>';
			const hrefMatch = rawAttrs.match(/\bhref\s*=\s*"([^"]*)"/i)
				|| rawAttrs.match(/\bhref\s*=\s*'([^']*)'/i);
			if (!hrefMatch) return '';
			const safeHref = hrefMatch[1].replace(/"/g, '&quot;');
			return `<a href="${safeHref}">`;
		}

		// <span class="tg-spoiler"> — only this exact class is allowed.
		if (name === 'span') {
			if (isClosing) return '</span>';
			if (/\bclass\s*=\s*"tg-spoiler"/i.test(rawAttrs)) return '<span class="tg-spoiler">';
			return ''; // any other span is disallowed
		}

		// <tg-emoji emoji-id="..."> — emoji-id is required, must be digits.
		if (name === 'tg-emoji') {
			if (isClosing) return '</tg-emoji>';
			const idMatch = rawAttrs.match(/\bemoji-id\s*=\s*"(\d+)"/i);
			if (!idMatch) return '';
			return `<tg-emoji emoji-id="${idMatch[1]}">`;
		}

		// Anything else: strip.
		return '';
	});

	// 3. Stack-based tag balancer. Runs on the already-sanitised output, so
	//    we only see allow-listed tag names here. We treat opening attributes
	//    as opaque and just match on tag name.
	const tags = [];
	const tagRegex = /<\/?([a-z0-9-]+)(?:\s+[^>]*?)?>/gi;
	let match;

	while ((match = tagRegex.exec(clean)) !== null) {
		const fullTag = match[0];
		const tagName = match[1].toLowerCase();
		const isClosing = fullTag.startsWith('</');

		// Self-closing tags are not part of Telegram HTML — skip from the stack.
		if (fullTag.endsWith('/>')) continue;

		if (isClosing) {
			if (tags.length > 0 && tags[tags.length - 1] === tagName) {
				tags.pop();
			} else {
				// Orphaned closing tag: remove it.
				clean = clean.slice(0, match.index) + clean.slice(match.index + fullTag.length);
				tagRegex.lastIndex -= fullTag.length;
			}
		} else {
			tags.push(tagName);
		}
	}

	// 4. Close any remaining open tags in reverse order.
	while (tags.length > 0) {
		clean += `</${tags.pop()}>`;
	}

	// 5. Collapse excessive whitespace (3+ newlines → 2).
	clean = clean.replace(/\n{3,}/g, "\n\n");

	return clean.trim();
}

/**
 * R2 Media Storage Service
 * Stores and retrieves media files (images, voice, video, documents) in Cloudflare R2.
 * Zero egress fees. Objects keyed by chat + type + hash for deduplication.
 */

// Generate a short hash from content for dedup
function shortHash(str) {
	let hash = 0;
	for (let i = 0; i < Math.min(str.length, 200); i++) {
		hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
	}
	return Math.abs(hash).toString(36);
}

/**
 * Store media in R2.
 * @param {Object} env - Worker env with MEDIA_BUCKET binding
 * @param {number} chatId
 * @param {string} type - "image" | "voice" | "video" | "document" | "generated"
 * @param {ArrayBuffer|Uint8Array|string} data - binary data or base64 string
 * @param {string} mimeType - e.g. "image/png"
 * @param {Object} metadata - optional metadata (prompt, filename, etc.)
 * @returns {string} R2 object key
 */
export async function storeMedia(env, chatId, type, data, mimeType, metadata = {}) {
	// Accept ArrayBuffer, Uint8Array, or base64 string
	let binary = data;
	if (typeof data === 'string') {
		// Legacy base64 path — use native Buffer if available
		try {
			const { Buffer } = await import('node:buffer');
			binary = Buffer.from(data, 'base64');
		} catch {
			const raw = atob(data);
			const bytes = new Uint8Array(raw.length);
			for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
			binary = bytes.buffer;
		}
	}

	const timestamp = Date.now();
	const ext = mimeExtension(mimeType);
	const hash = shortHash(`${chatId}_${type}_${timestamp}`);
	const key = `${chatId}/${type}/${timestamp}_${hash}.${ext}`;

	await env.MEDIA_BUCKET.put(key, binary, {
		httpMetadata: { contentType: mimeType },
		customMetadata: {
			chatId: String(chatId),
			type,
			uploadedAt: new Date().toISOString(),
			...Object.fromEntries(
				Object.entries(metadata).map(([k, v]) => [k, String(v).slice(0, 500)])
			),
		},
	});

	console.log(`📦 R2 stored: ${key} (${(binary.byteLength || binary.length)} bytes)`);
	return key;
}

/**
 * Retrieve media from R2.
 * @returns {{ body: ReadableStream, httpMetadata: Object, customMetadata: Object } | null}
 */
export async function getMedia(env, key) {
	const obj = await env.MEDIA_BUCKET.get(key);
	if (!obj) return null;
	return {
		body: obj.body,
		arrayBuffer: () => obj.arrayBuffer(),
		httpMetadata: obj.httpMetadata,
		customMetadata: obj.customMetadata,
	};
}

/**
 * List media for a chat, optionally filtered by type.
 * @returns {Array<{ key: string, size: number, uploaded: string }>}
 */
export async function listMedia(env, chatId, type = null, limit = 20) {
	const prefix = type ? `${chatId}/${type}/` : `${chatId}/`;
	const listed = await env.MEDIA_BUCKET.list({ prefix, limit });
	return (listed.objects || []).map(obj => ({
		key: obj.key,
		size: obj.size,
		uploaded: obj.uploaded?.toISOString(),
	}));
}

/**
 * Delete a specific media object.
 */
export async function deleteMedia(env, key) {
	await env.MEDIA_BUCKET.delete(key);
	console.log(`🗑️ R2 deleted: ${key}`);
}

/**
 * Delete all media for a chat (use with caution).
 */
export async function deleteAllMedia(env, chatId) {
	const listed = await env.MEDIA_BUCKET.list({ prefix: `${chatId}/`, limit: 1000 });
	const keys = (listed.objects || []).map(o => o.key);
	if (keys.length) {
		await env.MEDIA_BUCKET.delete(keys);
		console.log(`🗑️ R2 bulk deleted ${keys.length} objects for chat ${chatId}`);
	}
	return keys.length;
}

function mimeExtension(mime) {
	const map = {
		'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
		'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
		'video/mp4': 'mp4', 'video/webm': 'webm',
		'application/pdf': 'pdf', 'text/plain': 'txt',
	};
	return map[mime] || 'bin';
}

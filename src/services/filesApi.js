/**
 * Google Files API Service
 * Uploads large files (PDFs, videos, long audio) to Google's Files API
 * so they can be referenced by fileUri in Gemini requests.
 * This avoids the 20MB inline base64 limit.
 *
 * Files are temporary on Google's side (48h TTL) and auto-deleted.
 */

const FILES_API_BASE = 'https://generativelanguage.googleapis.com';

/**
 * Upload a file to Google's Files API via resumable upload.
 * @param {ArrayBuffer|Uint8Array} data - binary file data
 * @param {string} mimeType - e.g. "application/pdf", "video/mp4"
 * @param {string} displayName - human-readable name
 * @param {Object} env - Worker env with GEMINI_API_KEY
 * @returns {{ fileUri: string, mimeType: string, name: string }}
 */
export async function uploadToFilesAPI(data, mimeType, displayName, env) {
  const binary = data instanceof Uint8Array ? data : new Uint8Array(data);

  // Step 1: Initiate resumable upload
  const initRes = await fetch(
    `${FILES_API_BASE}/upload/v1beta/files?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(binary.byteLength),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { displayName } }),
    }
  );

  if (!initRes.ok) {
    const err = await initRes.text();
    throw new Error(`Files API init failed ${initRes.status}: ${err.slice(0, 200)}`);
  }

  const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
  if (!uploadUrl) throw new Error('No upload URL returned from Files API');

  // Step 2: Upload the actual bytes
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(binary.byteLength),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: binary,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Files API upload failed ${uploadRes.status}: ${err.slice(0, 200)}`);
  }

  const result = await uploadRes.json();
  const file = result.file;
  if (!file?.uri) throw new Error('Files API returned no file URI');

  console.log(`📁 Files API uploaded: ${file.name} (${file.sizeBytes} bytes, ${mimeType})`);

  // Step 3: Wait for processing (videos/audio need time)
  if (file.state === 'PROCESSING') {
    await waitForProcessing(file.name, env);
  }

  return { fileUri: file.uri, mimeType: file.mimeType || mimeType, name: file.name };
}

/**
 * Poll until file processing is complete (for videos/audio).
 */
async function waitForProcessing(fileName, env, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000)); // poll every 3s
    const res = await fetch(
      `${FILES_API_BASE}/v1beta/${fileName}?key=${env.GEMINI_API_KEY}`
    );
    if (!res.ok) continue;
    const data = await res.json();
    if (data.state === 'ACTIVE') {
      console.log(`📁 File processing complete: ${fileName}`);
      return;
    }
    if (data.state === 'FAILED') {
      throw new Error(`File processing failed: ${data.error?.message || 'unknown'}`);
    }
  }
  throw new Error(`File processing timed out after ${maxWaitMs / 1000}s`);
}

/**
 * Determine if a file should use Files API (large) or inline base64 (small).
 * Threshold: 15MB (leaving headroom under the 20MB inline limit).
 */
export const FILES_API_THRESHOLD = 15 * 1024 * 1024;

export function shouldUseFilesAPI(sizeBytes, mimeType) {
  if (sizeBytes > FILES_API_THRESHOLD) return true;
  // Always use Files API for video (even small ones process better)
  if (mimeType?.startsWith('video/')) return true;
  // Use for large PDFs
  if (mimeType === 'application/pdf' && sizeBytes > 5 * 1024 * 1024) return true;
  return false;
}

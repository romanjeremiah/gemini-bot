// AI Provider abstraction types.
// Single shape for both Gemini and Cloudflare Workers AI providers.
// The router picks one; the rest of the code talks to AIProvider directly.
//
// We use plain JSDoc rather than TypeScript because gemini-bot is JavaScript.
// JSDoc gives us editor hints without a build step.

/**
 * @typedef {Object} AIMessage
 * @property {'user'|'model'|'tool'|'system'} role
 * @property {string|Array<AIMessagePart>} content
 */

/**
 * @typedef {Object} AIMessagePart
 * @property {'text'|'inline_data'|'tool_use'|'tool_result'} type
 * @property {string} [text]
 * @property {{mime_type:string,data:string}} [inline_data]
 * @property {string} [name]
 * @property {Object} [args]
 * @property {string} [id]
 * @property {string} [toolCallId]
 * @property {string} [content]
 */

/**
 * @typedef {Object} AIToolCall
 * @property {string} name
 * @property {Object} args
 * @property {string} id
 */

/**
 * @typedef {Object} AIResponse
 * @property {string} text
 * @property {Array<AIToolCall>} [toolCalls]
 * @property {string} [finishReason]
 * @property {string} [blockReason]
 */

/**
 * @typedef {Object} AIStreamChunk
 * @property {'text'|'functionCall'|'finishReason'|'blockReason'|'groundingMetadata'} type
 * @property {string} [text]
 * @property {Array<Object>} [calls]
 * @property {string} [reason]
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} AIProviderConfig
 * @property {string} [systemInstruction]
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {Object} [cachedContent]
 */

/**
 * @typedef {Object} AITool
 * @property {Object} schema
 * @property {Function} execute
 */

/**
 * @typedef {Object} AIProvider
 * @property {'gemini'|'cloudflare'} name
 * @property {string} model
 */

export {};

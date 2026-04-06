import { reminderTool } from './reminder';
import { memoryTool } from './memory';
import { reactionTool } from './reaction';
import { voiceTool } from './voice';
import { pinTool } from './pin';

export const toolRegistry = {
	[reminderTool.definition.name]: reminderTool,
	[memoryTool.definition.name]: memoryTool,
	[reactionTool.definition.name]: reactionTool,
	[voiceTool.definition.name]: voiceTool,
	[pinTool.definition.name]: pinTool,
};

export const toolDefinitions = Object.values(toolRegistry).map(t => t.definition);

import { reminderTool } from './reminder';
import { memoryTool } from './memory';
import { reactionTool } from './reaction';
import { voiceTool } from './voice';
import { pinTool } from './pin';
import { imageTool } from './image';
import { pollTool } from './poll';
import { locationTool } from './location';
import { checklistTool } from './checklist';
import { draftTool } from './draft';
import { quoteTool } from './quote';
import { effectTool } from './effect';
import { saveTherapeuticNoteTool, getTherapeuticNotesTool } from './therapeutic';
import { logMoodEntryTool, getMoodHistoryTool } from './mood';
import { fetchTool } from './fetch';
import { scheduleTool } from './schedule';
import { githubReadTool } from './github';
import { githubTool } from './github';

export const toolRegistry = {
	[reminderTool.definition.name]: reminderTool,
	[fetchTool.definition.name]: fetchTool,
	[githubTool.definition.name]: githubTool,
	[memoryTool.definition.name]: memoryTool,
	[reactionTool.definition.name]: reactionTool,
	[voiceTool.definition.name]: voiceTool,
	[pinTool.definition.name]: pinTool,
	[imageTool.definition.name]: imageTool,
	[pollTool.definition.name]: pollTool,
	[locationTool.definition.name]: locationTool,
	[checklistTool.definition.name]: checklistTool,
	[draftTool.definition.name]: draftTool,
	[quoteTool.definition.name]: quoteTool,
	[effectTool.definition.name]: effectTool,
	[saveTherapeuticNoteTool.definition.name]: saveTherapeuticNoteTool,
	[getTherapeuticNotesTool.definition.name]: getTherapeuticNotesTool,
	[logMoodEntryTool.definition.name]: logMoodEntryTool,
	[getMoodHistoryTool.definition.name]: getMoodHistoryTool,
	[fetchTool.definition.name]: fetchTool,
	[scheduleTool.definition.name]: scheduleTool,
	[githubReadTool.definition.name]: githubReadTool,
};

export const toolDefinitions = Object.values(toolRegistry).map(t => t.definition);

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
import { fetchTool, tavilySearchTool } from './fetch';
import { scheduleTool } from './schedule';
import { githubReadTool, githubPatchTool, githubExploreTool } from './github';
import { cloudflareAdminTool } from './cloudflare';
import { timezoneTool } from './timezone';
import { searchResearchTool, startResearchTool } from './research';
import { episodeTool, updateEpisodeOutcomeTool } from './episode';

export const toolRegistry = {
	[reminderTool.definition.name]: reminderTool,
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
	[tavilySearchTool.definition.name]: tavilySearchTool,
	[cloudflareAdminTool.definition.name]: cloudflareAdminTool,
	[scheduleTool.definition.name]: scheduleTool,
	[githubReadTool.definition.name]: githubReadTool,
	[githubPatchTool.definition.name]: githubPatchTool,
	[githubExploreTool.definition.name]: githubExploreTool,
	[timezoneTool.definition.name]: timezoneTool,
	[searchResearchTool.definition.name]: searchResearchTool,
	[startResearchTool.definition.name]: startResearchTool,
	[episodeTool.definition.name]: episodeTool,
	[updateEpisodeOutcomeTool.definition.name]: updateEpisodeOutcomeTool,
};

export const toolDefinitions = Object.values(toolRegistry).map(t => t.definition);

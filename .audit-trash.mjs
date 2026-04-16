#!/usr/bin/env node
// Quick word-count audit of the system prompt composition
import { personas, MENTAL_HEALTH_DIRECTIVE, FORMATTING_RULES, SECOND_BRAIN_DIRECTIVE } from './src/config/personas.js';

function wc(s) { return s.trim().split(/\s+/).filter(Boolean).length; }
function chars(s) { return s.length; }

const personaInstruction = personas.xaridotis.instruction;

const sections = {
  'personas.xaridotis.instruction': personaInstruction,
  'MENTAL_HEALTH_DIRECTIVE': MENTAL_HEALTH_DIRECTIVE,
  'FORMATTING_RULES': FORMATTING_RULES,
  'SECOND_BRAIN_DIRECTIVE': SECOND_BRAIN_DIRECTIVE,
};

let totalWords = 0;
let totalChars = 0;
console.log('SECTION                                WORDS    CHARS');
console.log('-----------------------------------------------------');
for (const [name, text] of Object.entries(sections)) {
  const w = wc(text); const c = chars(text);
  totalWords += w; totalChars += c;
  console.log(`${name.padEnd(40)}${String(w).padStart(5)}    ${String(c).padStart(5)}`);
}
console.log('-----------------------------------------------------');
console.log(`${'STATIC TOTAL'.padEnd(40)}${String(totalWords).padStart(5)}    ${String(totalChars).padStart(5)}`);
console.log(`\n(rough token estimate: ~${Math.round(totalChars/4)} tokens for static prompt)`);
console.log(`\nDumb Zone threshold: 1,200 words`);
console.log(`Current: ${totalWords} words = ${totalWords > 1200 ? 'OVER' : 'under'} by ${Math.abs(totalWords - 1200)} words`);

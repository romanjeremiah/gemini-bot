// dump_one_tool.mjs — quick inspection of tool schema shape
import { toolDefinitions } from './src/tools/index.js';
console.log('Total tools:', toolDefinitions.length);
console.log('\nFirst 3 tool definitions:');
for (const t of toolDefinitions.slice(0, 3)) {
  console.log('\n---');
  console.log(JSON.stringify(t, null, 2));
}

import { sanitizeTelegramHTML } from './src/lib/formatter.js';

const cases = [
  ['Plain bold passes', '<b>Hello</b>', '<b>Hello</b>'],
  ['Markdown bold converts', '**Hello**', '<b>Hello</b>'],
  ['Disallowed string tag stripped', 'See <string>foo</string> here', 'See foo here'],
  ['Disallowed example tag stripped', 'Try <example>x</example>', 'Try x'],
  ['Disallowed div stripped', '<div>nope</div>', 'nope'],
  ['Allowed link with href kept', '<a href="https://x.com">link</a>', '<a href="https://x.com">link</a>'],
  ['Link without href stripped', '<a>orphan</a>', 'orphan'],
  ['Span with tg-spoiler class kept', '<span class="tg-spoiler">spoiler</span>', '<span class="tg-spoiler">spoiler</span>'],
  ['Span with other class stripped', '<span class="random">x</span>', 'x'],
  ['Blockquote expandable kept', '<blockquote expandable>note</blockquote>', '<blockquote expandable>note</blockquote>'],
  ['Plain blockquote kept', '<blockquote>q</blockquote>', '<blockquote>q</blockquote>'],
  ['Pre/code kept', '<pre><code>x = 1</code></pre>', '<pre><code>x = 1</code></pre>'],
  ['Bare code kept', '<code>let x</code>', '<code>let x</code>'],
  ['Disallowed attr on b stripped', '<b style="color:red">x</b>', '<b>x</b>'],
  ['Pre-escaped entities preserved', '&lt;b&gt;literal&lt;/b&gt;', '&lt;b&gt;literal&lt;/b&gt;'],
  ['Unclosed bold auto-closed', '<b>oops', '<b>oops</b>'],
  ['Orphan closer removed', 'foo</b>bar', 'foobar'],
  ['Real failing case', 'Result <string>foo</string> end', 'Result foo end'],
  ['HR stripped', 'a<hr/>b', 'ab'],
  ['Multi-newlines collapsed', 'a\n\n\n\nb', 'a\n\nb'],
  ['tg-emoji with id kept', '<tg-emoji emoji-id="123">x</tg-emoji>', '<tg-emoji emoji-id="123">x</tg-emoji>'],
  ['tg-emoji without id stripped', '<tg-emoji>x</tg-emoji>', 'x'],
  ['Strong/em allowed', '<strong>a</strong> <em>b</em>', '<strong>a</strong> <em>b</em>'],
];

let pass = 0, fail = 0;
for (const [name, input, expected] of cases) {
  const got = sanitizeTelegramHTML(input);
  if (got === expected) { pass++; }
  else { fail++; console.log('FAIL: ' + name); console.log('  in:  ' + JSON.stringify(input)); console.log('  exp: ' + JSON.stringify(expected)); console.log('  got: ' + JSON.stringify(got)); }
}
console.log('---');
console.log(pass + ' pass, ' + fail + ' fail');

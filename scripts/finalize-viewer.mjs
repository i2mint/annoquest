// The built viewer as one file (dist/viewer.html), safe for hosts that edit HTML by string.
//
// Hosts insert tags before the first `</head>` or `</body>` (analytics, icons, deploy stamps).
// The inlined script contains those strings (DOMPurify builds documents from them), so a host
// would insert into the script and break it. Inside scripts, `</` becomes `<\/`: the same string
// in JavaScript (in literals, templates and regular expressions alike), invisible to such edits.
import { readFileSync, writeFileSync } from 'node:fs';

const [from = 'dist/viewer/index.html', to = 'dist/viewer.html'] = process.argv.slice(2);
const html = readFileSync(from, 'utf8').replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (_m, open, body, close) => open + body.replace(/<\/(head|body|html)/gi, '<\\/$1') + close);
const count = (re) => (html.match(re) ?? []).length;
if (count(/<\/head>/gi) !== 1 || count(/<\/body>/gi) !== 1) throw new Error(`${to}: expected one </head> and one </body>`);
writeFileSync(to, html);

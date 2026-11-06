// Dependency-free bundler: concatenates src/*.mjs into the DSH client module format
// (window.__ModuleLoader__.load, same shape as upstream lib/client.js). No npm, no transpile.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
const root = fileURLToPath(new URL('.', import.meta.url));
// transport.mjs is the browser-only HTTP leaf; it lives in ui now (§WP-C 4: ui depends on no package, only HTTP).
// Modules share a factory scope; parse the actual result before publishing it.
const order = ['projection', 'authority', 'human-text', 'labels', 'transport', 'real-source', 'mock', 'model', 'store', 'scope', 'activity', 'styles',
  'ui/atoms', 'ui/commands', 'ui/palette', 'ui/situation', 'ui/lanes', 'ui/records', 'ui/detail', 'ui/page', 'ui/frames', 'ui', 'plugin'];
const pkg = JSON.parse(fs.readFileSync(root + 'package.json', 'utf8'));
let body = '';
for (const name of order) {
  let src = fs.readFileSync(new URL(`src/${name}.mjs`, new URL('.', import.meta.url)), 'utf8');
  src = src.replace(/^import[\s\S]*?from\s+'[^']+';\r?\n/gm, '');
  src = src.replace(/^export (?=(const|function|class|let|async)\b)/gm, '');
  // WP-3: the barrel re-exports the split modules; stripping the statement is what keeps it from being bundled.
  src = src.replace(/^export\s*\{[\s\S]*?\}\s*from\s*'[^']+';\r?\n/gm, '');
  if (/^\s*(import|export)\b/m.test(src)) throw Error(`unbundled module syntax left in ${name}.mjs`);
  body += `//#region src/${name}.mjs\n${src}\n//#endregion\n`;
}
const out = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
\t\tconst React = require("react");
\t\tconst ReactDOM = require("react-dom");
${body}
\t\texports.apply = apply;
\t\texports.inject = inject;
\t\treturn module.exports;
\t}
});
`;
new Script(out, { filename: 'lib/client.js' });
fs.mkdirSync(root + 'lib', { recursive: true });
fs.writeFileSync(root + 'lib/client.js', out);
console.log(`lib/client.js ${out.length} bytes from ${order.length} modules`);

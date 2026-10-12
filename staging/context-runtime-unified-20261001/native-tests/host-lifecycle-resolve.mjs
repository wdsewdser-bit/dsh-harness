import { registerHooks } from 'node:module';
const aliases = new Set(['cordis', 'cordis-plugin-loader', 'dsh-system-prompt', 'dsh-scope']);
registerHooks({ resolve(specifier, context, nextResolve) {
  const name = specifier.startsWith('@deepseek-ai/') ? specifier.slice(13) : '';
  if (aliases.has(name)) return { url: new URL('../app/node_modules/@deepseek-ai/' + name + '-v15/lib/index.js', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });

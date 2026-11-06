import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** P2: patch copies only. Old/foreign tool pipelines cannot claim final-hook coverage. */
export function installRoleToolBoundary(build) {
  const repo = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const target = path.resolve(build);
  if (!target.startsWith(path.join(repo, 'runs') + path.sep)) throw Error('PATCH_TARGET_UNSAFE');
  const lib = path.join(target, 'node_modules/@deepseek-ai/dsh-tools/lib');
  const patch = (file, pairs) => {
    let text = fs.readFileSync(file, 'utf8');
    for (const [before, after] of pairs) {
      if (text.includes(after)) continue;
      if (text.split(before).length !== 2) throw Error('PATCH_MISSING: role boundary anchor ' + before);
      text = text.replace(before, after);
    }
    fs.writeFileSync(file, text);
  };
  patch(path.join(lib, 'index.js'), [
    ['import { Service }', 'import { createRoleToolBoundary } from "./role-tool-boundary.js";\nimport { Service }'],
    ['var ToolsService = class extends Service {', 'var ToolsService = class extends Service {\n\troleToolBoundary = createRoleToolBoundary(this);'],
    ['\t\treturn this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, {', '\t\tthis.roleToolBoundary.track(definition);\n\t\treturn this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, {'],
    ['setExecutor(executor) {', 'setExecutor(executor) {\n\t\tthis.roleToolBoundary.trackExecutor(executor);'],
    ['return this.selectExecutor(input.agent).execute(input);', 'return this.roleToolBoundary.batch(input, () => this.selectExecutor(input.agent).execute(input));'],
  ]);
  patch(path.join(lib, 'pipeline.js'), [
    ['executionMode(exec) {', 'executionMode(exec) {\n\t\tthis.tools.roleToolBoundary.check(exec, this.get(exec.name, exec.agent, exec.toolSet));'],
    ['async prepare(input) {', 'async prepare(input) {\n\t\tthis.tools.roleToolBoundary.check(input, this.get(input.name, input.agent, input.toolSet));'],
    ['\t\t\tconst gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec,', '\t\t\tthis.tools.roleToolBoundary.check(exec, this.get(exec.name, exec.agent, exec.toolSet));\n\t\t\tconst gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec,'],
    ['const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));', 'const result = await this.tools.roleToolBoundary.run(exec, this.get(exec.name, exec.agent, exec.toolSet), () => this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec)));'],
  ]);
  // These are the trusted native registration sites, not a runtime name-to-permission lookup.
  for (const [pkg, names] of [['dsh-tool-fs', ['read', 'read_image', 'write', 'edit']], ['dsh-tool-fs-search', ['glob', 'grep']]]) {
    const file = path.join(target, 'node_modules/@deepseek-ai', pkg, 'lib/index.js');
    if (!fs.existsSync(file)) continue;
    let text = fs.readFileSync(file, 'utf8');
    for (const name of names) {
      const capabilities = ['write', 'edit'].includes(name) ? ['write-local'] : ['read-local'];
      const before = 'name: "' + name + '",';
      const after = before + '\n\t\troleNativeCapabilities: ' + JSON.stringify(capabilities) + ',';
      if (!text.includes(after)) {
        if (text.split(before).length !== 2) throw Error('PATCH_MISSING: native declaration ' + pkg + ':' + name);
        text = text.replace(before, after);
      }
    }
    // defineTool compiles the public definition, so bind its result at this trusted call site, not via custom schema fields.
    if (!text.includes('function defineRoleNativeTool(')) {
      text = text.replace('import { defineTool }', 'import { defineTool as upstreamDefineTool }');
      text += '\nfunction defineRoleNativeTool(ctx, options) { const {roleNativeCapabilities, ...rest} = options; const tool = upstreamDefineTool(rest); return ctx.tools.roleToolBoundary.declareNative(tool, roleNativeCapabilities); }\n';
      text = text.replaceAll('defineTool({', 'defineRoleNativeTool(ctx, {');
    }
    fs.writeFileSync(file, text);
  }
  fs.copyFileSync(path.join(repo, 'packages/adapter-dsh/role-tool-boundary.mjs'), path.join(lib, 'role-tool-boundary.js'));
}

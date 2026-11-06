import { pathToFileURL, fileURLToPath } from 'node:url';
export const name = 'instant-preempt-native-executor';
export const inject = ['tools'];
/** Native scheduler sees the step halt; invocations keep ONLY their real turn signal. */
export async function apply(ctx, config) {
  const base = config.base ?? fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
  const { NativeToolExecutor } = await import(pathToFileURL(base + 'dsh-tool-executor-native/lib/index.js'));
  const { ToolExecutionPipeline, executeToolBatch } = await import(pathToFileURL(base + 'dsh-tools/lib/pipeline.js'));
  // Use public exports only; no private NativeToolExecutor fields.
  const maxParallel = () => 10;
  const native = new NativeToolExecutor(ctx, maxParallel);
  const pipeline = new ToolExecutionPipeline(ctx);
  ctx.tools.setExecutor({
    describe: tools => native.describe(tools),
    execute(input) {
      const halt = input.agent?.preemptSignal;
      if (halt === undefined) return native.execute(input);
      const original = exec => ({ ...exec, signal: input.signal });
      const dispatch = {
        executionMode: exec => pipeline.executionMode(original(exec)),
        prepare: exec => pipeline.prepare(original(exec)),
        dispatch: exec => pipeline.dispatch(exec),
        complete: (exec, result) => pipeline.complete(exec, result),
      };
      return executeToolBatch({ ...input, signal: AbortSignal.any([input.signal, halt]) }, dispatch, maxParallel);
    },
  });
}

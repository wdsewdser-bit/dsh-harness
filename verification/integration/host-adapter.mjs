import { checkWire } from '../../packages/context/index.mjs';
import { DISPATCH_CONTRACT, classifyAccepted } from '../../packages/contracts/index.mjs';

/**
 * Install the one-attempt offline LLM transport used by the native host; 08 §7.3 and M1b design §1.4.1.
 *
 * The dispatch confirmation is the same contract as the upstream adapter: send-started immediately before the fetch,
 * committed after the awaited fetch returns a Response and before the body is parsed. It is never the generator's
 * first line - that line runs before the request exists. When the loaded module has no dispatchAttemptOf (an
 * unpatched build) the adapter reports nothing, and the path is adapter-unconfirmed instead of quietly fabricating
 * evidence.
 */
export function installAdapter(adapter, context, configuration) {
  context.llm.registerAdapter(['offline'], new class extends adapter.LlmAdapter {
    // This adapter publishes send-started and committed itself, so it declares the contract: only a declared adapter
    // may be summarised as failed(notSent) when it throws without a send-started.
    dispatchContract = DISPATCH_CONTRACT;

    providerInfo(id) {
      return { id, name: id };
    }

    async resolveModel(provider, id) {
      return {
        provider,
        id,
        name: id,
        context: { contextWindow: configuration.W },
        defaultMaxTokens: 4096,
      };
    }

    async prepareCall(provider, id) {
      return {
        model: { provider, id, name: id, contextWindow: configuration.W, inputModalities: ['text'] },
        stream(options) {
          return (async function* () {
            // No invisible retry: each fetch is one checked stream attempt.
            checkWire(options, configuration, 'adapter-wire');
            // The lookup comes from the module that minted the attempt: adapter is the module's own export surface,
            // so its WeakMap is the same table (a second dsh-llm copy would be patch-missing, never a silent no-op).
            const attempt = typeof adapter.dispatchAttemptOf === 'function' ? adapter.dispatchAttemptOf(options) : undefined;
            attempt?.phase('send-started', { transmission: 1, sendStartedAt: Date.now() });
            const response = await fetch('http://127.0.0.1:40271', {
              method: 'POST',
              body: JSON.stringify(options, (key, value) => key === 'signal' ? undefined : value),
            });
            attempt?.phase('committed', { transmission: 1, httpStatus: response.status, accepted: classifyAccepted(response.status) });
            if (!response.ok) {
              throw Error(await response.text());
            }
            yield* await response.json();
          })();
        },
      };
    }
  }());
}

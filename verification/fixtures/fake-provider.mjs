import http from 'node:http';
import assert from 'node:assert/strict';

/** Reject duplicate, orphaned or unmatched tool protocol entries; 08 §7.3. */
export function pairs(body) {
  const calls = new Set();
  const results = new Set();
  for (const message of body.messages) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool-call') {
        assert(!calls.has(block.id), 'duplicate call');
        calls.add(block.id);
      }
    }
    if (message.role === 'tool') {
      const id = message.toolCallId ?? message.source?.toolCallId;
      assert(calls.has(id) && !results.has(id), 'orphan result');
      results.add(id);
    }
  }
  assert.equal(calls.size, results.size, 'unmatched calls');
}

/** Serve deterministic offline requests with strict pairing checks; 08 §7.3. */
export async function provider(port, handle) {
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
      }
      const body = JSON.parse(raw);
      pairs(body);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(await handle(body)));
    } catch (error) {
      response.writeHead(400);
      response.end(String(error));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return () => new Promise(resolve => server.close(resolve));
}

/** Build deterministic reasoning, response and usage stream chunks; 08 §7.3. */
export function chunks(block, input) {
  const tool = block.type === 'tool-call';
  return [
    ...(tool ? [
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      {
        type: 'block-end',
        index: 1,
        block: { type: 'reasoning', text: 'offline synthetic reasoning' },
      },
    ] : []),
    { type: 'block-start', index: 0, blockType: block.type },
    { type: 'block-end', index: 0, block },
    { type: 'usage', usage: { inputTokens: input, outputTokens: 10, totalTokens: input + 10 } },
    { type: 'finish', reason: { kind: tool ? 'tool-calls' : 'stop' } },
  ];
}

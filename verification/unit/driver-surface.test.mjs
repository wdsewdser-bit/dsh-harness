import test from 'node:test';
import assert from 'node:assert/strict';
import { maskDirectorySegments, scanText } from './check-driver-surface.mjs';

// The guard's own word is spelled in pieces everywhere it would appear in *code* (comments are blanked before
// matching, strings are not), so this file never trips the scan it exercises. What is under test: the harness
// directory is scanned like any other directory, and only the directory segment of an import/export specifier is
// treated as a location.
const WORD = 'har' + 'ness';
const DIR = 'verification/' + WORD + '/';
const FORBIDDEN = 'MISSING_SERVER' + '_BINDING';
const ERROR_ID = WORD + '-only-error';

test('driver surface: a file inside the ' + WORD + ' directory is still scanned for the forbidden error code', () => {
  const hits = scanText(DIR + 'fake-provider.mjs', "export const refused = '" + FORBIDDEN + "';\n");
  assert.equal(hits.length, 1, 'a ' + WORD + '-directory file is not exempt from the scan');
  assert.equal(hits[0].id, ERROR_ID);
  assert.equal(hits[0].line, 1);
});

test('driver surface: the word is still caught inside the ' + WORD + ' directory when it is code, not a path', () => {
  const hits = scanText(DIR + 'host.mjs', 'const ' + WORD + ' = 1;\n');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'removed-driver');
  // A bare string that is not an import specifier is still a name, not a location.
  assert.equal(scanText(DIR + 'host.mjs', "const label = '" + WORD + "';\n").length, 1);
});

test('driver surface: only the directory segment of a specifier is masked, the rest is still scanned', () => {
  const clean = scanText(DIR + 'consumer.mjs', "import { provider } from './" + WORD + "/fake-provider.mjs';\n");
  assert.deepEqual(clean, [], 'the directory segment of an import is a location');
  const dirty = scanText(DIR + 'consumer.mjs', "import x from './" + WORD + "/" + FORBIDDEN + ".mjs';\n");
  assert.equal(dirty.length, 1, 'the rest of the same specifier is still checked');
  assert.equal(dirty[0].id, ERROR_ID);
});

test('driver surface: masking keeps every newline, so reported lines stay true', () => {
  const source = "import a from './" + WORD + "/x.mjs';\nimport b from './" + WORD + "/y.mjs';\nconst bad = '" + FORBIDDEN + "';\n";
  assert.equal(maskDirectorySegments(source).split('\n').length, source.split('\n').length);
  const hits = scanText(DIR + 'consumer.mjs', source);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

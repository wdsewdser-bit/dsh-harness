import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectedBuild } from '../../packages/adapter-dsh/build-target.mjs';

/**
 * The build roots of this patch release, read from build/builds.json — the one configuration the whole repository
 * shares. The release name is derived from this directory's own name, so a script can never claim a release the
 * directory does not name, and a missing entry fails closed instead of falling back to a literal path.
 */
export const REPO = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const RELEASE = path.basename(fileURLToPath(new URL('.', import.meta.url))).replace(/^upstream-/, '');
const fail = message => { throw Object.assign(Error('CONFIG_MISSING: ' + message), { code: 'CONFIG_MISSING' }); };
const config = JSON.parse(fs.readFileSync(path.join(REPO, 'build', 'builds.json'), 'utf8'));
const builds = config.builds?.[RELEASE];
if (!builds || typeof builds.c1 !== 'string' || typeof builds.c2 !== 'string') {
  fail('build/builds.json has no builds["' + RELEASE + '"] with c1 and c2');
}
const pristine = config.pristine?.[RELEASE];
if (typeof pristine !== 'string' || !pristine) fail('build/builds.json has no pristine["' + RELEASE + '"]');
/** The read-only @deepseek-ai root of the release and the install directory that contains it. */
export const PRISTINE = pristine;
export const PRISTINE_ROOT = pristine.replace(/[/\\]node_modules[/\\]@deepseek-ai[/\\]?$/, '');
export const C1 = builds.c1;
export const C2 = builds.c2;
/**
 * The prepared build the suites actually run (C1 + llm-dispatch + instant-preempt + execution-permit), selected by
 * build-target.mjs exactly as every composition root selects it. Probes that boot the real Team runtime must use
 * this one: since the dispatch contract became mandatory, a bare C2 copy cannot host the Team plugin.
 */
export const PREPARED = selectedBuild();

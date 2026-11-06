import { hash, fail } from './index.mjs';

/** Serialize recursively sorted JSON for durable identity; 08 §2.2, §4.10. */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('INVALID_JSON');
  return encoded;
}

/** Hash canonical command or snapshot content; 08 §2.2, §4.10. */
export const digest = value => hash(canonical(value));

/** Validate a typed dependency without free-text blocking tickets; 08 §4.6. */
export function validateDependency(value) {
  const fields = {
    Approval: ['planId', 'revision'], TaskAccepted: ['taskId', 'deliveryRevision'],
    ArtifactPublished: ['ref', 'hash'], MessageResponsibility: ['messageId', 'recipientGeneration'],
    Decision: ['issueId', 'proposalRevision'], ExternalEvidence: ['owner', 'deadline', 'ref'],
  };
  const keys = fields[value?.kind];
  if (!keys || Object.keys(value).some(key => !['kind', ...keys].includes(key)) ||
    keys.some(key => value[key] === undefined)) fail('INVALID_DEPENDENCY');
  return value;
}

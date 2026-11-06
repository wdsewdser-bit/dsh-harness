import { certificateBindingSchema } from '../../packages/projections/schema.mjs';
import assert from 'node:assert/strict';import {generateKeyPairSync,sign} from 'node:crypto';import {canonical,digest
  } from '../../packages/contracts/index.mjs';import {certificateBinding} from '../../packages/projections/certificate-binding.mjs';
export function testCertificateBinding(){const {privateKey,publicKey}=generateKeyPairSync('ed25519');const task={entityId:'task:certificate'},attempt={
    taskId:task.entityId};const rows=new Map([['attempt:certificate',attempt]]);const certificate={taskId:task.entityId,attemptId:'attempt:certificate',
    verifier:'member:verifier',contractRevision:1,candidate:'a'.repeat(40),tree:'b'.repeat(40)};const d={entityId:'delivery:certificate',revision:3,
    status:'verified',taskId:task.entityId,certificate,certificateHash:digest(certificate),signature:sign(null,Buffer.from(canonical(certificate)),privateKey)
    .toString('base64'),publicKey:publicKey.export({type:'spki',format:'pem'})};const b=certificateBinding(d,task,rows);for(
    const key of certificateBindingSchema
    .required)assert(Object.hasOwn(b,key));assert(!certificateBindingSchema.required.includes('attemptId'));assert.equal(b.attemptId,'attempt:certificate');
    assert.equal(b.verifier,certificate.verifier);assert.equal(b.certificateHash,d.certificateHash);assert.equal(certificateBinding({...d,certificate:null},
      task,
        rows),
    undefined);assert.equal(certificateBinding({...d,certificateHash:'bad'},task,rows),undefined);assert.equal(certificateBinding(d,task,new Map()),undefined);
  assert.equal(certificateBinding({...d,signature:'invalid'},task,rows),undefined);const legacy={...certificate};delete legacy.attemptId;const old={...d,
    certificate:legacy,certificateHash:digest(legacy),signature:sign(null,Buffer.from(canonical(legacy)),privateKey).toString('base64')};assert(!Object
    .hasOwn(certificateBinding(old,task,rows),'attemptId'));
  }

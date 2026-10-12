import test from 'node:test'
import assert from 'node:assert/strict'
import {familyAdmission,familyLimits,verifyFamily} from '../tools/team-family-natural-lab.mjs'

const request = sessionId => ({sessionId,provider:'opencodego',model:'deepseek-v4.1-flash',maxTokens:2048,messages:[]})
test('family bootstrap denies every sampling and a permit is exact-session scoped',() => {
  assert.throws(() => familyAdmission(false).admit(request('root')),/FAMILY_UNPERMITTED_SAMPLING/)
  const admission = familyAdmission(true)
  admission.permit('child','A')
  assert.throws(() => admission.admit(request('root')),/FAMILY_UNPERMITTED_SAMPLING/)
  assert.equal(admission.admit(request('child')),'A')
  admission.revoke()
  assert.throws(() => admission.admit(request('child')),/FAMILY_UNPERMITTED_SAMPLING/)
})
test('family route, output, payload and cumulative eight-request boundaries reject before sampling',() => {
  const admission = familyAdmission(true)
  admission.permit('root','B')
  assert.throws(() => admission.admit({...request('root'),provider:'foreign'}),/FAMILY_FOREIGN_ROUTE/)
  assert.throws(() => admission.admit({...request('root'),maxTokens:2049}),/FAMILY_OUTPUT_LIMIT/)
  assert.throws(() => admission.admit({...request('root'),messages:['x'.repeat(familyLimits.maxPayloadBytes)]}),/FAMILY_PAYLOAD_LIMIT/)
  assert.throws(() => admission.permit('child','A'),/FAMILY_CONCURRENT_TURN/)
  for(let index=0;index<8;index++) admission.admit(request('root'))
  assert.throws(() => admission.admit(request('root')),/FAMILY_REQUEST_LIMIT/)
})
test('family acceptance cannot be manufactured from absent native journals or missing descendants',() => {
  assert.equal(verifyFamily({},[],[],{members:{},rounds:[],identityTexts:{}}).accepted,false)
})

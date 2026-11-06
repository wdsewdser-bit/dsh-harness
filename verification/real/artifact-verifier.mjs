import fs from 'node:fs';import path from 'node:path';import {generateKeyPairSync,sign,createHash} from 'node:crypto';
const [root,file,contractJson]=process.argv.slice(2),contract=JSON.parse(contractJson);if(!path.resolve(file).startsWith(path.resolve(root)+path
    .sep))throw Error('VERIFIER_SCOPE');const raw=fs.readFileSync(file),artifact=JSON.parse(raw);if(artifact.value!==contract.expected
    ||artifact.actor!==contract
  .actor||artifact.cycle!==contract.cycle)throw Error('QUALITY_FAILED');const certificate={...contract,sha256:createHash('sha256').update(raw).digest('hex'),
  verifier:'member:verifier',readbackAt:Date.now()};const {privateKey,publicKey}=generateKeyPairSync('ed25519');const signature=sign(null,Buffer.from(JSON
    .stringify(certificate)),privateKey).toString('base64');console.log(JSON.stringify({certificate,signature,publicKey:publicKey.export({type:'spki',format:
    'pem'
              })
      }));

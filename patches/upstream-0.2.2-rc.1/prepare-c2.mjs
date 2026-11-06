import fs from 'node:fs';
import { C1, C2 } from './paths.mjs';
const source=C1, destination=C2;
if(fs.existsSync(destination))throw Error('BUILD_ALREADY_EXISTS');
fs.cpSync(source,destination,{recursive:true,dereference:true,errorOnExist:true,force:false});
console.log('copied C1 to C2');

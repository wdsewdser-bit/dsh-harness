import fs from 'node:fs';
const source='<path-to-dsh-c1-build-0.2.2>', destination='<path-to-dsh-c2-build-0.2.2>';
if(fs.existsSync(destination))throw Error('BUILD_ALREADY_EXISTS');
fs.cpSync(source,destination,{recursive:true,dereference:true,errorOnExist:true,force:false});
console.log('copied C1 to C2');

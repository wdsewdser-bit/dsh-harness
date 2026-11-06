import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const workspace=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
export function scopedRoot(value){
  if(!value||!path.isAbsolute(value))throw Error('ABSOLUTE_WORKSPACE_ROOT_REQUIRED');
  const root=path.resolve(value),base=fs.realpathSync(workspace).toLowerCase();
  if(!root.toLowerCase().startsWith(workspace.toLowerCase()+path.sep))throw Error('WRITE_SCOPE');
  let existing=root;while(!fs.existsSync(existing))existing=path.dirname(existing);
  const real=fs.realpathSync(existing).toLowerCase();
  if(real!==base&&!real.startsWith(base+path.sep))throw Error('SYMLINK_WRITE_SCOPE');
  return root;
}

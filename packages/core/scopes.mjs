// normalizeScope lives in contracts (the bottom of the dependency graph): core, the host guard and any later package
// read one implementation through the contracts entry instead of each reaching into a module.
export { normalizeScope } from '../contracts/index.mjs';

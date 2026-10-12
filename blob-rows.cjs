const fs = require("fs");
const cp = process.argv[2], outList = process.argv[3];
const s = fs.readFileSync(cp, "utf8");
const i = s.indexOf("evidence-794f87f7");
if (i < 0) { console.log("ROW-MISS"); process.exit(0); }
const seg = s.slice(i, i + 400000);
const m = seg.match(/"output":"((?:[^"\\]|\\.)*)"/);
if (!m) { console.log("OUTPUT-KEY-MISS"); process.exit(0); }
const v = JSON.parse('"' + m[1] + '"');
const lines = v.split("\n").filter(l => l.trim().length > 0);
console.log("lines=" + lines.length);
console.log("head=" + lines.slice(0,2).join(" ;; ").slice(0,220));
const ex = new Set(["tools/rig-batch/CONTRACT.md","target/debug/rig-batch.exe","target/debug/bot.exe"]);
const paths = lines.map(l => l.split("|")[0]).filter(p => !ex.has(p));
console.log("kept=" + paths.length + " excluded=" + (lines.length - paths.length));
fs.writeFileSync(outList, paths.join("\n") + "\n", "utf8");
console.log("wrote=" + outList);
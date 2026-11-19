// Minimal asar reader: list matching paths or extract one file to stdout.
// usage: node asar-read.mjs <asar> [--list <substr>] [--get <path-or-substr>]
import fs from "node:fs";

const [, , asarPath, mode, needle] = process.argv;
const fd = fs.openSync(asarPath, "r");
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonLen);
fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
const header = JSON.parse(jsonBuf.toString("utf8"));
const contentBase = 8 + headerSize;

const files = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, p);
    else files.push({ path: p, size: entry.size, offset: Number(entry.offset), unpacked: entry.unpacked });
  }
})(header, "");

if (mode === "--list") {
  for (const f of files.filter((f) => f.path.includes(needle))) console.log(`${f.size}\t${f.path}`);
} else if (mode === "--get") {
  const f = files.find((x) => x.path === needle) || files.find((x) => x.path.includes(needle));
  if (!f) { console.error("not found"); process.exit(1); }
  const buf = Buffer.alloc(f.size);
  fs.readSync(fd, buf, 0, f.size, contentBase + f.offset);
  process.stdout.write(buf);
}

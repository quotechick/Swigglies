// Copies three.js from node_modules into web/vendor so the browser loads it from the site itself (no CDN).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const three = path.join(root, 'node_modules', 'three');
if (!fs.existsSync(three)) { console.error('three.js is not installed: run npm install first'); process.exit(1); }
const out = path.join(root, 'web', 'vendor');
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(three, 'build', 'three.module.js'), path.join(out, 'three.module.js'));
const controls = fs.readFileSync(path.join(three, 'examples', 'jsm', 'controls', 'OrbitControls.js'), 'utf8').replaceAll("from 'three'", "from './three.module.js'");
if (!controls.includes("from './three.module.js'")) throw new Error('could not rewrite the OrbitControls import');
fs.writeFileSync(path.join(out, 'OrbitControls.js'), controls);
console.log(`web/vendor ready (three ${JSON.parse(fs.readFileSync(path.join(three, 'package.json'), 'utf8')).version})`);

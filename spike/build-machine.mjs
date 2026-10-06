// Builds the Rust PC (machine/) to dist/machine.wasm: cargo, the wasm32-unknown-unknown target.
//
//   node build-machine.mjs
//
// Needs Rust (rustup target add wasm32-unknown-unknown).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
execFileSync('cargo', ['rustc', '--release', '--target', 'wasm32-unknown-unknown', '--lib', '--crate-type', 'cdylib'], { cwd: path.join(here, 'machine'), stdio: 'inherit' });
fs.mkdirSync(path.join(here, 'dist'), { recursive: true });
const from = path.join(here, 'machine', 'target', 'wasm32-unknown-unknown', 'release', 'f1gp_machine.wasm');
fs.copyFileSync(from, path.join(here, 'dist', 'machine.wasm'));
console.log(`dist/machine.wasm: ${fs.statSync(from).size} bytes`);

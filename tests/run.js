#!/usr/bin/env node
// Runs every *.test.js here, or the ones named: `node tests/run.js scratch navigate`.
// --invert flips every assertion; a sound suite then fails every check.
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const INVERT = args.includes('--invert');
const only = args.filter((a) => !a.startsWith('--'));

let pass = 0;
let fail = 0;
const failures = [];
let current = '';

function check(name, cond, detail = '') {
  const ok = INVERT ? !cond : !!cond;
  if (ok) pass++; else { fail++; failures.push(`${current}: ${name}`); }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  — ${detail}` : ''}`);
}

(async () => {
  const suites = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => !only.length || only.some((o) => f.startsWith(o)))
    .sort();
  for (const file of suites) {
    current = file.replace('.test.js', '');
    console.log(`\n# ${current}`);
    try {
      await require(path.join(__dirname, file))(check);
    } catch (err) {
      fail++;
      failures.push(`${current}: crashed — ${err.message}`);
      console.log(`  ERROR ${err.message}`);
    }
  }
  console.log(`\n${INVERT ? 'Inverted run' : 'Run'}: ${pass} pass, ${fail} fail`);
  if (INVERT) {
    // Every check must fail when inverted; one that still passes cannot catch anything.
    process.exit(pass === 0 ? 0 : 1);
  }
  if (failures.length) console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(fail ? 1 : 0);
})();

/**
 * A very small test harness: suites of named checks, a summary, an exit code.
 *
 *   suite('tokenizer', () => {
 *       test('splits operators', () => eq(tokenize('a+b'), ['a', '+', 'b']));
 *   });
 */

import { deepStrictEqual } from 'node:assert';

const results = { passed: 0, failed: [] };
let current = '';

export function suite(name, body) {
    current = name;
    body();
}

export function test(name, body) {
    try {
        body();
        results.passed++;
    } catch (error) {
        results.failed.push({ name: `${current}: ${name}`, message: error.message });
    }
}

/** Deep equality with a readable message. */
export function eq(actual, expected, label = '') {
    try {
        deepStrictEqual(actual, expected);
    } catch {
        const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
        throw new Error(`${label ? label + ': ' : ''}expected ${show(expected)}\n      got      ${show(actual)}`);
    }
}

/** Expect `body` to throw, optionally with a message matching `pattern`. */
export function throws(body, pattern) {
    try {
        body();
    } catch (error) {
        if (pattern && !pattern.test(error.message)) throw new Error(`threw "${error.message}", expected ${pattern}`);
        return;
    }
    throw new Error('expected an error');
}

/** Print the summary; returns true when everything passed. */
export function report() {
    for (const f of results.failed) console.log(`  FAIL ${f.name}\n      ${f.message}`);
    console.log(`\n${results.passed} passed, ${results.failed.length} failed`);
    return results.failed.length === 0;
}

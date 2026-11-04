import test from 'node:test';
import assert from 'node:assert/strict';
import {workbenchPage} from '../src/workbench.ts';

// Browsers compile `pattern` with the `v` flag; an unescaped `-` in a class is a syntax error there and silently disables validation.
test('every workbench input pattern is a valid v-flag regular expression', () => {
  const patterns = [...workbenchPage.matchAll(/pattern="([^"]*)"/g)].map(m => m[1]!);
  assert.ok(patterns.length > 0);
  for (const pattern of patterns) assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, 'v'), pattern);
  assert.ok(new RegExp(`^(?:${patterns[0]})$`, 'v').test('mission:abc-1_2'));
});

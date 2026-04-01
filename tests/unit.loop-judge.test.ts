import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePlan } from '../src/lib/plan.ts';

test('loop_judge normalizes to while node with ai gate', () => {
  const plan = normalizePlan({
    setup: 'test',
    repos: { main: '.' },
    flow: [
      {
        type: 'loop_judge',
        id: 'quality_loop',
        max_iterations: 3,
        pass_threshold: 8,
        rubric: {
          criteria: [
            { id: 'correctness', label: 'Correctness', weight: 0.4 },
            { id: 'coverage', label: 'Coverage', weight: 0.3 },
            { id: 'clarity', label: 'Clarity', weight: 0.3 },
          ],
        },
        judge: { persona: 'You are a strict QA judge.' },
        body: [
          { type: 'task', id: 'improve', prompt: 'Improve the work based on feedback.' },
        ],
      },
    ],
  });

  assert.equal(plan.workflow.length, 1);
  const node = plan.workflow[0];
  assert.equal(node.type, 'while');
  if (node.type !== 'while') return;
  assert.equal(node.id, 'quality_loop');
  assert.equal(node.maxIterations, 3);
  assert.equal(node.until.type, 'ai');
  if (node.until.type === 'ai') {
    assert.equal(node.until.id, 'quality_loop_judge');
    assert.equal(node.until.scoreThreshold, 8);
    assert.match(node.until.prompt, /Rubric-Based Judging/);
    assert.match(node.until.prompt, /Pass threshold: 8/);
    assert.match(node.until.prompt, /correctness/);
  }
});

test('loop_judge validates threshold and rubric', () => {
  assert.throws(
    () =>
      normalizePlan({
        repos: { main: '.' },
        flow: [
          { type: 'loop_judge', id: 'x', pass_threshold: -1, rubric: { criteria: [{ id: 'a', label: 'A', weight: 1 }] }, body: [{ type: 'task', id: 't', prompt: 'x' }] },
        ],
      }),
    /pass_threshold must be a number between 0 and 10/,
  );

  assert.throws(
    () =>
      normalizePlan({
        repos: { main: '.' },
        flow: [
          { type: 'loop_judge', id: 'x', pass_threshold: 5, rubric: { criteria: [] }, body: [{ type: 'task', id: 't', prompt: 'x' }] },
        ],
      }),
    /rubric\.criteria must be a non-empty array/,
  );

  assert.throws(
    () =>
      normalizePlan({
        repos: { main: '.' },
        flow: [
          { type: 'loop_judge', id: 'x', pass_threshold: 5, rubric: { criteria: [{ id: 'a', label: 'A', weight: 0 }, { id: 'b', label: 'B', weight: 0 }] }, body: [{ type: 'task', id: 't', prompt: 'x' }] },
        ],
      }),
    /rubric\.criteria weights must sum to > 0/,
  );
});


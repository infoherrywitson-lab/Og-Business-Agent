import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, createPlan } from '../src/planner.js';

test('buildPlan creates task plan and approval gates', () => {
  const plan = buildPlan('Build a website, SEO and social marketing for Fusion Kids', 'Fusion Kids');
  assert.equal(plan.projectName, 'Fusion Kids');
  assert.ok(plan.tasks.length >= 7);
  assert.ok(plan.tasks.some((t) => t.role === 'seo'));
  assert.ok(plan.tasks.filter((t) => t.requiresApproval).length >= 1);
  assert.equal(plan.safety.adSpend, 'approval_required');
});

test('buildPlan handles Roman Urdu brief', () => {
  const plan = buildPlan('Mujhy meri brand k liye website bana do');
  assert.equal(plan.languageDetected, 'Roman Urdu/Hindi likely');
  assert.ok(plan.deliverables.some((d) => d.toLowerCase().includes('website')));
});

test('buildPlan detects Urdu script', () => {
  const plan = buildPlan('میرے برانڈ کے لیے ویب سائٹ بنائیں');
  assert.equal(plan.languageDetected, 'Urdu/Arabic script likely');
});

test('buildPlan gates every irreversible action category', () => {
  const plan = buildPlan('Run ads and post to social for my shop');
  for (const key of ['externalPublishing', 'adSpend', 'purchases', 'bulkOutreach', 'deployment']) {
    assert.equal(plan.safety[key], 'approval_required');
  }
  assert.ok(plan.tasks.every((t) => t.status === 'queued'));
  assert.ok(plan.tasks.some((t) => t.priority === 'high'));
});

test('buildPlan never returns empty deliverables', () => {
  const plan = buildPlan('do literally anything');
  assert.ok(plan.deliverables.length >= 1);
});

test('createPlan falls back to rules when no AI key is configured', async () => {
  const plan = await createPlan('Build a landing page', 'NoKey', {
    apiKey: null,
    baseUrl: 'https://example.invalid/v1',
    model: 'gpt-4o-mini',
    timeoutMs: 500,
  });
  assert.equal(plan.planningMode, 'rules-based fallback');
  assert.ok(String(plan.aiNote).includes('AI_API_KEY'));
  assert.ok(plan.tasks.length >= 7);
});

test('createPlan falls back when the provider is unreachable', async () => {
  const plan = await createPlan('Build a landing page', 'BadProvider', {
    apiKey: 'sk-test-not-a-real-key',
    baseUrl: 'http://127.0.0.1:1/v1', // nothing listens here
    model: 'gpt-4o-mini',
    timeoutMs: 1500,
  });
  assert.equal(plan.planningMode, 'rules-based fallback');
  assert.ok(String(plan.aiNote).includes('AI planning unavailable'));
  assert.ok(plan.tasks.length >= 7);
});

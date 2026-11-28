// Public routing identities must survive credential-value collisions at the API boundary.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runAc, mkTmp, startSidecar, sseOpen } from './lib/harness.mjs';
import { apply } from '../dsh-plugin/index.js';
import { redactLlmResponse } from '../src/llm.mjs';
import { redactor } from '../src/util.mjs';

const provider = 'magpie-responses';
const model = `fixture-model/${randomUUID()}`;
const effort = 'reasoning-high';
const secret = randomUUID();

await runAc('llm-redaction', async () => {
  const tmp = mkTmp('dsh-team-llm-redaction');
  let sidecar;
  let passed = false;
  const cleanups = [];
  try {
    for (const value of ['magpie', model, effort, secret]) redactor.addSecret(value);
    const rawRoute = {
      provider, model, name: secret, enabled: true,
      efforts: [{ id: effort, name: secret, extra: { id: model, token: secret } }],
      defaultEffort: effort, allowedEfforts: [effort],
      extra: { provider, model, id: effort, apiKey: secret },
    };
    const cleanRoute = redactLlmResponse(rawRoute, 'route');
    assert.equal(cleanRoute.model, model);
    assert(!JSON.stringify(cleanRoute.extra).includes(provider), 'extension fields are not identities');
    assert(!JSON.stringify(cleanRoute.efforts[0].extra).includes(model));
    assert(!JSON.stringify(cleanRoute).includes(secret));
    assert.equal(rawRoute.name, secret, 'redaction must not mutate the catalog');
    const nullableRoute = { ...rawRoute, efforts: null, defaultEffort: null, allowedEfforts: null };
    assert.equal(redactLlmResponse(nullableRoute, 'route').provider, provider);
    assert.equal(redactLlmResponse({ items: [] }, 'models').items.length, 0);
    const malformed = [
      ['unknown', rawRoute],
      ['route', { ...rawRoute, error: { message: secret } }],
      ['route', { ...rawRoute, efforts: [{ id: { token: secret }, name: secret }] }],
      ['route', { ...rawRoute, defaultEffort: { id: secret } }],
      ['route', { ...rawRoute, allowedEfforts: [secret, 42] }],
      ['route', { ...rawRoute, enabled: 'yes' }],
      ['models', { items: [rawRoute, { provider, model }] }],
      ['catalog', { source: 'other', providers: [{ id: provider, name: secret, models: [rawRoute] }] }],
      ['catalog', { source: 'dsh-llm', providers: [{ id: 'other', name: secret, models: [rawRoute] }] }],
      ['provider', { id: provider, name: { token: secret } }],
    ];
    for (const [shape, body] of malformed) {
      assert.deepEqual(redactLlmResponse(body, shape), redactor.obj(body), `${shape}: invalid shape must fail closed`);
    }
    sidecar = await startSidecar({
      dataDir: tmp.dataDir, ws: tmp.ws,
      env: { GATEWAY_API_KEY: 'magpie', MODEL_TEST_SECRET: model, EFFORT_TEST_SECRET: effort, DSH_TEST_SECRET: secret },
    });
    const api = sidecar.api;
    const metadata = {
      providers: [{ id: provider, name: `Gateway ${secret}`, error: `Error ${secret}` }],
      models: [{
        provider, model, name: `Model ${secret}`, description: `Description ${secret}`,
        efforts: [{ id: effort, name: `Effort ${secret}`, description: `Effort description ${secret}` }, { id: 'low', name: 'Low' }],
        defaultEffort: effort,
      }],
    };
    await api.post('/api/llm/catalog', metadata);

    const catalog = await api.get('/api/llm/catalog');
    assert.equal(catalog.providers[0].id, provider, 'public provider ID must not be scrubbed');
    assert.equal(catalog.providers[0].models[0].provider, provider);
    assert.equal(catalog.providers[0].models[0].model, model, 'model ID must remain usable');
    assert.equal(catalog.providers[0].models[0].efforts[0].id, effort);
    assert.equal(catalog.providers[0].models[0].defaultEffort, effort);
    assert(!JSON.stringify(catalog).includes(secret), 'catalog labels and diagnostics must still redact credentials');
    assert.match(catalog.providers[0].error, /<redacted>/);
    assert.match(catalog.providers[0].models[0].efforts[0].description, /<redacted>/);

    const patched = await api.patch('/api/llm/routes', { provider, model, note: `Note ${secret}`, allowedEfforts: [effort] });
    assert.equal(patched.provider, provider);
    assert.equal(patched.model, model);
    assert.deepEqual(patched.allowedEfforts, [effort]);
    assert.equal(patched.defaultEffort, effort);
    assert(!JSON.stringify(patched).includes(secret), 'route PATCH response must redact notes');
    const providerPatch = await api.patch('/api/llm/providers', { provider, note: `Provider note ${secret}` });
    assert.equal(providerPatch.id, provider);
    assert(!JSON.stringify(providerPatch).includes(secret), 'provider PATCH response must redact notes');

    for (const suffix of ['', '?all=1']) {
      const listed = await api.get(`/api/llm/models${suffix}`);
      assert.equal(listed.items[0].provider, provider);
      assert.equal(listed.items[0].model, model);
      assert.deepEqual(listed.items[0].allowedEfforts, [effort]);
      assert(!JSON.stringify(listed).includes(secret), 'model lists must redact free text');
    }
    await assert.rejects(
      api.patch('/api/llm/routes', { provider, model, allowedEfforts: [secret] }),
      (err) => err.status === 400 && !JSON.stringify(err.body).includes(secret) && JSON.stringify(err.body).includes('<redacted>'),
      'LLM endpoint errors must retain normal secret redaction',
    );

    const registry = new Map();
    const spawned = [];
    const ctx = {
      tools: { register(tool) { registry.set(tool.name, tool); return () => registry.delete(tool.name); }, get: (name) => registry.get(name) },
      get(name) {
        if (name === 'subagents') return {
          list: () => ['spawn', 'fork'],
          async startActivation(spec) {
            spawned.push(spec);
            return { childId: spec.childId, result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} };
          },
        };
        if (name === 'llm') return {
          listProviders: () => metadata.providers,
          listModels: async () => metadata.models.map((m) => ({ ...m, id: m.model })),
          resolveModelInfo: async () => ({ reasoning: { efforts: metadata.models[0].efforts, defaultEffort: effort } }),
        };
        return undefined;
      },
      effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return cleanup; },
      on() { return () => {}; },
    };
    apply(ctx, { baseUrl: sidecar.url, autoStart: false, reportToolCalls: false, reportChanges: false, reportLlmCalls: false, reportContext: false, reportWorkspaces: false, agentAutoDispatch: false, boardEnabled: false });
    const exec = { agent: { id: 'public-route-lead', options: { provider, model, reasoningEffort: effort } } };
    const team = (await registry.get('dsh_team_create').execute({ name: 'route-redaction', workspace: tmp.ws }, exec)).team;
    const models = await registry.get('dsh_team_models').execute({}, exec);
    assert.equal(models.models[0].provider, provider, 'tool discovery must return the real provider');
    assert.equal(models.models[0].model, model);
    assert.deepEqual(models.models[0].efforts, [effort]);
    await registry.get('dsh_team_spawn').execute({ teamId: team.id, name: 'probe', prompt: 'Read-only diagnostic.', agentProvider: provider, model, reasoningEffort: effort }, exec);
    assert.equal(spawned.length, 1, 'valid route must reach the actual activation boundary');
    assert.equal(spawned[0].agentOptions.provider, provider);
    assert.equal(spawned[0].agentOptions.model, model);
    assert.equal(spawned[0].agentOptions.reasoningEffort, effort);

    // Same-named fields outside the typed catalog must not become a redaction bypass.
    const member = await api.post(`/api/teams/${team.id}/members`, { name: 'recipient' });
    const stream = sseOpen(sidecar.url, sidecar.token, { team: team.id, lastEventId: 1 });
    cleanups.push(() => stream.close());
    await stream.waitFor((frame) => frame.event === 'member.status');
    const message = await api.post('/api/messages', {
      teamId: team.id, from: 'lead', to: member.id, kind: 'note',
      payload: { provider, model, token: secret, nested: { id: provider, apiKey: secret } },
    });
    const text = JSON.stringify(message);
    assert(!text.includes(secret));
    assert(!text.includes(provider), 'arbitrary payload provider/id fields must still be redacted');
    assert(!text.includes(model));
    assert(text.includes('<redacted>'));
    await api.post(`/api/messages/${message.message.id}/ack`, { state: 'delivered' });
    await stream.waitFor((frame) => frame.event === 'message.delivered');
    const channels = {
      sse: JSON.stringify(stream.frames),
      history: (await api.raw(`/api/events/history?team=${team.id}`)).text,
      audit: (await api.raw(`/api/audit?team=${team.id}`)).text,
      report: (await api.raw(`/api/report?team=${team.id}`)).text,
      stdout: sidecar.stdout.join('\n'),
      stderr: sidecar.stderr.join('\n'),
    };
    for (const [channel, raw] of Object.entries(channels)) {
      assert(!raw.includes(secret), `${channel} must not leak the test credential`);
      assert(!raw.includes(model), `${channel} must not exempt model IDs`);
      assert(!raw.includes(provider), `${channel} must not exempt provider IDs`);
    }
    passed = true;
    return 'typed catalog identities survive collisions; discovery and dispatch work; free text, errors and messages remain redacted';
  } catch (err) {
    console.error(`[llm-redaction] retained temporary directory: ${tmp.root}`);
    throw err;
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* finish remaining cleanup */ } }
    if (sidecar) await sidecar.close();
    if (passed) tmp.cleanup();
  }
});
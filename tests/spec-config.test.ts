import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultSpecificationDirectory, defaultSpecificationLabel, defaultSpecificationStore, defaultIterationField, specificationAgents, validateSpecificationsConfig } from '../src/spec-config.ts';
import { configurationFingerprint, fingerprintForRun } from '../src/run-recovery.ts';

const agents = { planner: {provider:'p', model:'a'}, implementer: {provider:'p', model:'b'}, reviewer: {provider:'p', model:'c'} };

test('specification configuration defaults and valid stores', async () => {
  for (const value of [undefined, {}, {store:'local'}, {store:'github', github:{label:'spec', repository:'owner/name', project:{owner:'org', number:7, iterationField:'Sprint'}}}]) assert.doesNotThrow(() => validateSpecificationsConfig(value));
  assert.equal(defaultSpecificationStore, 'local');
  assert.equal(defaultSpecificationDirectory, '.factory/specs');
  assert.equal(defaultSpecificationLabel, 'factory-spec');
  assert.equal(defaultIterationField, 'Iteration');
  const example = JSON.parse(await readFile('factory.config.example.json', 'utf8'));
  assert.equal(example.specifications.store, 'local');
  validateSpecificationsConfig(example.specifications);
});

test('invalid configuration identifies the offending key', () => {
  const cases: Array<[unknown, string]> = [
    [null, 'specifications'], [{store:'devops'}, 'specifications.store'],
    [{local:[]}, 'specifications.local'], [{local:{directory:''}}, 'specifications.local.directory'],
    ...['/absolute', 'C:\\absolute', 'C:relative', '../specs', 'specs/../other', 'specs\\..\\other'].map(directory => [{local:{directory}}, 'specifications.local.directory'] as [unknown, string]),
    [{github:null}, 'specifications.github'], [{store:'github'}, 'specifications.github.project'],
    [{github:{label:'  '}}, 'specifications.github.label'], [{github:{repository:'not a repo'}}, 'specifications.github.repository'],
    ...[0, 1.5, '7'].map(number => [{github:{project:{owner:'org', number}}}, 'specifications.github.project.number'] as [unknown, string]),
    [{github:{project:{owner:'', number:1}}}, 'specifications.github.project.owner'],
    [{github:{project:{owner:'org', number:1, iterationField:''}}}, 'specifications.github.project.iterationField'],
  ];
  for (const [value, key] of cases) assert.throws(() => validateSpecificationsConfig(value), (error: Error) => error.message.includes(key), JSON.stringify(value));
  assert.doesNotThrow(() => validateSpecificationsConfig({local:{directory:'specs/..hidden'}}));
});

test('specification agents use explicit models or the documented fallback chain', () => {
  const planReviewer = {provider:'p', model:'plan-review'};
  const custom = {provider:'p', model:'custom'};
  assert.deepEqual(specificationAgents(agents), {impactAnalyst:agents.planner, specReviewer:agents.reviewer});
  assert.deepEqual(specificationAgents({...agents, planReviewer}), {impactAnalyst:agents.planner, specReviewer:planReviewer});
  assert.deepEqual(specificationAgents({...agents, planReviewer, impactAnalyst:custom, specReviewer:custom}), {impactAnalyst:custom, specReviewer:custom});
});

test('fingerprints retain recorded current and timeout-sensitive hashes', () => {
  const base = {agents, execution:{timeoutMs:123, maxAttempts:3}};
  const expanded = {...base, specifications:{store:'github'}, agents:{...agents, impactAnalyst:{provider:'p',model:'x'}, specReviewer:{provider:'p',model:'y'}}};
  const current = '910a5d7c3864229de7e30267e178ae397fc3651a42b7bf20045a9c71fd7ee2b3';
  const legacy = 'b135697b8fbd2265efb2b32057066b077f19b53796434808562e99e1359079ca';
  assert.equal(configurationFingerprint(base), current);
  assert.equal(configurationFingerprint(expanded), current);
  assert.equal(fingerprintForRun(expanded, legacy), legacy);
  assert.equal(fingerprintForRun(expanded, current), current);
  assert.notEqual(configurationFingerprint({...expanded, agents:{...expanded.agents, implementer:{provider:'p',model:'changed'}}}), current);
});

test('CLI config parsing validates specification and optional agent settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spec-config-'));
  try {
    const path = join(dir, 'config.json');
    for (const [extra, key] of [[{specifications:{store:'github'}}, 'specifications.github.project'], [{agents:{...agents, impactAnalyst:{provider:'',model:'m'}}}, 'agents.impactAnalyst'], [{agents:{...agents, specReviewer:null}}, 'agents.specReviewer']] as const) {
      await writeFile(path, JSON.stringify({agents, ...extra}));
      const result = spawnSync(process.execPath, ['--experimental-strip-types', 'src/factory-cli.ts', 'plan', '--repo', dir, '--objective', 'missing', '--output', 'unused', '--config', path], {encoding:'utf8'});
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(key.replaceAll('.', '\\.')));
    }
  } finally { await rm(dir, {recursive:true, force:true}); }
});

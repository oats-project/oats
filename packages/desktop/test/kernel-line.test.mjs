// The Desktop's kernel line (F2b): the floor is 0.26.0, and a 0.69 Desktop's tested bound is 0.69 (#1879). Its
// floor is the first kernel the Desktop's feature gates let through: 0.26.0 is
// the first to advertise packages-no-approval beside workspace-v2. A 0.25
// kernel is refused by the locator, so it meets the "Compatible `oats` CLI
// required" card once instead of an "update OATS" state at every read. The
// gates stay the REAL gate: a kernel inside the band without the feature words
// is still refused by every workspace and deployment read.
//
// `fixtures/kernel-line/v0.25.9-version.json` is the standard output, byte for
// byte, of `oats version --json` run from an export of the tag `v0.25.9` (`git
// archive v0.25.9 bin lib package.json packages/record`, with the `yaml` and
// `croner` versions that tag pins). The tag is a pins-only release, so its CLI
// prints version 0.25.8; it lists workspace-v2 and not packages-no-approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acceptProbe, acceptRangeText } from '../../client/cli-locator.mjs';
// The Desktop these edges are judged for: a 0.69 one, the minor that moved from a ceiling to a tested bound (#1879).
const TESTED = '0.69.17';
import { workspaceGate, WORKSPACE_FEATURES } from '../../client/workspace-cli.mjs';
import { deploymentReadGate, DEPLOYMENT_FEATURES } from '../../client/deployment-contract.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';

const released = JSON.parse(readFileSync(new URL('./fixtures/workspace-v2/f2/version.json', import.meta.url), 'utf8'));
const tagged = JSON.parse(readFileSync(new URL('./fixtures/kernel-line/v0.25.9-version.json', import.meta.url), 'utf8'));
const probe = (version, features) => ({ ...released, version, features });
const accepted = p => ({ ...p, ok: true, bin: '/fixture/bin/oats' });
const GATE = 'packages-no-approval';

test('0.25.8 without packages-no-approval is refused by the locator', () => {
  assert.equal(tagged.version, '0.25.8'); assert.equal(tagged.features.includes(GATE), false, 'the released probe, as the tag prints it');
  const without = probe('0.25.8', released.features.filter(f => f !== GATE));
  for (const p of [tagged, without, probe('0.25.9', without.features)]) {
    const refused = acceptProbe(p, TESTED);
    assert.equal(refused.ok, false, p.version);
    assert.equal(refused.reason, `version ${p.version} outside ${acceptRangeText(TESTED)}`, p.version);
  }
});

test('0.26.0 with workspace-v2 and packages-no-approval is accepted by the locator and let through by every gate', () => {
  // The two words the workspace gate and the deployment reads ask for, both in the probe 0.26.0 writes.
  assert.deepEqual([...WORKSPACE_FEATURES].sort(), ['packages-no-approval', 'workspace-v2']);
  const first = probe('0.26.0', released.features);
  for (const name of DEPLOYMENT_FEATURES) assert.ok(first.features.includes(name), name);
  assert.equal(acceptProbe(first, TESTED).ok, true);
  const cli = accepted(first);
  assert.equal(workspaceGate(cli, DESKTOP_TERMS), null);
  for (const action of ['status', 'workspace-status']) assert.equal(deploymentReadGate(cli, action), null, action);
});

test('a kernel inside the band without the feature words is still refused by every gate', () => {
  for (const missing of ['workspace-v2', GATE]) {
    const lacking = accepted(probe('0.26.0', released.features.filter(f => f !== missing)));
    assert.equal(acceptProbe(lacking, TESTED).ok, true, `${missing}: inside the version band`);
    assert.equal(workspaceGate(lacking, DESKTOP_TERMS).reason.code, 'E_WORKSPACE_FEATURE', missing);
    assert.match(workspaceGate(lacking, DESKTOP_TERMS).reason.message, /Update OATS/, missing);
    for (const action of ['status', 'workspace-status']) {
      const refused = deploymentReadGate(lacking, action);
      assert.equal(refused.reason.code, 'E_DEPLOYMENT_FEATURE', `${missing} ${action}`); assert.equal(refused.reason.feature, missing, `${missing} ${action}`);
    }
  }
});

test('the version band alone never decides: 0.26.x without the feature is refused too; below 0.26.0 is not a kernel at all', () => {
  const noFeature = accepted(probe('0.26.3', released.features.filter(f => f !== 'packages-no-approval')));
  assert.equal(acceptProbe(noFeature, TESTED).ok, true);
  assert.equal(workspaceGate(noFeature, DESKTOP_TERMS).reason.code, 'E_WORKSPACE_FEATURE');
  assert.equal(acceptProbe(probe('0.25.9', [...released.features, 'packages-no-approval']), TESTED).ok, false);
  assert.equal(acceptProbe(probe('0.27.4', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.27 (the harness rename) is inside the band');
  assert.equal(acceptProbe(probe('0.28.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.28 (package souls, triggers) is inside the band');
  assert.equal(acceptProbe(probe('0.29.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.29 (automations, desktop facts) is inside the band');
  assert.equal(acceptProbe(probe('0.30.0', [...released.features, 'packages-no-approval', 'team-model-2']), TESTED).ok, true, '0.30 (team model v2) is inside the band');
  assert.equal(acceptProbe(probe('0.31.0', [...released.features, 'packages-no-approval', 'team-model-2']), TESTED).ok, true, '0.31 (Herdr removed, routed reads and plans) is inside the band');
  assert.equal(acceptProbe(probe('0.32.0', [...released.features, 'packages-no-approval', 'team-model-2']), TESTED).ok, true, '0.32 is inside the band');
  assert.equal(acceptProbe(probe('0.33.0', [...released.features, 'packages-no-approval', 'team-model-2']), TESTED).ok, true, '0.33 (spawn preview --max-age) is inside the band');
  assert.equal(acceptProbe(probe('0.34.0', [...released.features, 'packages-no-approval', 'team-model-2']), TESTED).ok, true, '0.34 (capabilities show) is inside the band');
  assert.equal(acceptProbe(probe('0.35.0', [...released.features, 'packages-no-approval', 'team-model-2']), TESTED).ok, true, '0.35 (capture --file) is inside the band');
  assert.equal(acceptProbe(probe('0.36.0', [...released.features, 'packages-no-approval', 'team-model-2']), TESTED).ok, true, '0.36 (workspace identity) is inside the band');
  assert.equal(acceptProbe(probe('0.37.0', [...released.features, 'packages-no-approval', 'team-model-2']), TESTED).ok, true, '0.37 (launch preview) is inside the band');
  assert.equal(acceptProbe(probe('0.38.0', [...released.features, 'packages-no-approval', 'team-model-3']), TESTED).ok, true, '0.38 (team model 3) is inside the band');
  assert.equal(acceptProbe(probe('0.39.0', [...released.features, 'packages-no-approval', 'team-model-3']), TESTED).ok, true, '0.39 (server connect, capability route) is inside the band');
  assert.equal(acceptProbe(probe('0.40.0', [...released.features, 'packages-no-approval', 'team-model-3']), TESTED).ok, true, '0.40 (needs input) is inside the band');
  assert.equal(acceptProbe(probe('0.41.0', [...released.features, 'packages-no-approval', 'team-model-3']), TESTED).ok, true, '0.41 (retirement deletes no branch) is inside the band');
  assert.equal(acceptProbe(probe('0.42.0', [...released.features, 'packages-no-approval', 'team-model-3']), TESTED).ok, true, '0.42 (one recovery per retire) is inside the band');
  assert.equal(acceptProbe(probe('0.43.0', [...released.features, 'packages-no-approval', 'team-model-3', 'automation-descriptions']), TESTED).ok, true, '0.43 (automation descriptions) is inside the band');
  assert.equal(acceptProbe(probe('0.44.0', [...released.features, 'packages-no-approval', 'team-model-3', 'automation-descriptions']), TESTED).ok, true, '0.44 (launch-prompt answers) is inside the band');
  assert.equal(acceptProbe(probe('0.45.0', [...released.features, 'packages-no-approval', 'team-model-3', 'automation-descriptions', 'souls-capabilities']), TESTED).ok, true, '0.45 (souls-capabilities) is inside the band');
  assert.equal(acceptProbe(probe('0.46.0', [...released.features, 'packages-no-approval', 'team-model-3', 'automation-descriptions', 'souls-capabilities', 'soul-composed-instructions']), TESTED).ok, true, '0.46 (soul-composed-instructions) is inside the band');
  assert.equal(acceptProbe(probe('0.48.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.48 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.49.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.49 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.50.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.50 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.51.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.51 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.52.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.52 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.53.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.53 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.54.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.54 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.55.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.55 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.56.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.56 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.57.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.57 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.58.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.58 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.59.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.59 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.60.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.60 is inside the band; feature gates remain authoritative');
  assert.equal(acceptProbe(probe('0.69.0', [...released.features, 'packages-no-approval']), TESTED).ok, true, '0.69 is inside the band; feature gates remain authoritative');
  // Past the 0.69 Desktop's minor: accepted above its tested bound (#1879), no longer refused.
  assert.deepEqual(acceptProbe(probe('0.70.0', [...released.features, 'packages-no-approval']), TESTED), { ok: true, aboveTested: true, testedThrough: '0.69' });
});

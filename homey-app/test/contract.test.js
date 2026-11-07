'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MODE, climateToHomey, command, compareTemperature,
} = require('../lib/contract');

const root = path.join(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const flow = readJson('drivers/indoor-unit/driver.flow.compose.json');
const card = (kind, id) => flow[kind].find((c) => c.id === id);
const argValues = (kind, id, name) => card(kind, id).args.find((a) => a.name === name).values.map((v) => v.id);
const capValues = (cap) => readJson(`.homeycompose/capabilities/${cap}.json`).values.map((v) => v.id);

test('compareTemperature: equal, above and below with half-degree steps', () => {
  assert.equal(compareTemperature(24, 'equal', 24), true);
  assert.equal(compareTemperature(24.5, 'equal', 24), false);
  assert.equal(compareTemperature(24, 'above', 24), false);
  assert.equal(compareTemperature(24.5, 'above', 24), true);
  assert.equal(compareTemperature(23.5, 'below', 24), true);
  assert.equal(compareTemperature(24, 'below', 24), false);
  assert.equal(compareTemperature(null, 'equal', 24), false);
});

test('climateToHomey: off reports no mode, the device shows it as off', () => {
  const c = climateToHomey({
    mode: MODE.off, targetTemperature: 24, currentTemperature: 20, fanMode: 2, swingMode: 0, preset: 0,
  });
  assert.equal(c.on, false);
  assert.equal(c.mode, null);
  assert.equal(c.fan, 'auto');
  assert.equal(c.swing, 'off');
});

test('command.mode: off and every mode the Flow cards offer map to an ESPHome mode', () => {
  for (const id of argValues('actions', 'set_mode', 'mode')) assert.equal(typeof command.mode(id).mode, 'number', id);
  assert.deepEqual(command.mode('off'), { mode: 0 });
});

test('command.preset: Good Sleep is the Sleep preset, there is no WindFree Sleep value', () => {
  const entity = { presets: [0, 6], customPresets: ['WindFree'] };
  assert.deepEqual(command.preset('sleep', entity), { preset: 6 });
  assert.deepEqual(command.preset('windfree', entity), { customPreset: 'WindFree' });
  assert.equal(command.preset('windfree_sleep', entity), null);
});

test('Flow dropdowns only offer values the capabilities know', () => {
  const pairs = [
    ['conditions', 'mode_is', 'mode', 'samsung_hvac_mode'],
    ['actions', 'set_mode', 'mode', 'samsung_hvac_mode'],
    ['conditions', 'fan_speed_is', 'fan', 'samsung_fan_speed'],
    ['actions', 'set_fan_speed', 'fan', 'samsung_fan_speed'],
    ['conditions', 'swing_is', 'swing', 'samsung_swing'],
    ['actions', 'set_swing', 'swing', 'samsung_swing'],
    ['conditions', 'preset_is', 'preset', 'samsung_preset'],
    ['actions', 'set_preset', 'preset', 'samsung_preset'],
  ];
  for (const [kind, id, arg, cap] of pairs) {
    const known = capValues(cap);
    for (const v of argValues(kind, id, arg)) assert.ok(known.includes(v), `${id}: ${v} not in ${cap}`);
  }
  assert.ok(argValues('conditions', 'mode_is', 'mode').includes('off'));
  assert.ok(argValues('actions', 'set_mode', 'mode').includes('off'));
});

test('every trigger token value has a label in en, nl and fr', () => {
  for (const lang of ['en', 'nl', 'fr']) {
    const t = readJson(`locales/${lang}.json`).flow;
    for (const [group, cap] of [['fan', 'samsung_fan_speed'], ['swing', 'samsung_swing'], ['preset', 'samsung_preset']]) {
      for (const id of capValues(cap)) assert.ok(t[group][id], `${lang}: flow.${group}.${id}`);
    }
    for (const id of capValues('samsung_hvac_mode').filter((m) => m !== 'off')) assert.ok(t.mode[id], `${lang}: flow.mode.${id}`);
  }
});

test('every Flow card text exists in en, nl and fr', () => {
  for (const kind of ['triggers', 'conditions', 'actions']) {
    for (const c of flow[kind]) {
      for (const field of ['title', 'titleFormatted', 'hint']) {
        if (!c[field]) continue;
        for (const lang of ['en', 'nl', 'fr']) assert.ok(c[field][lang], `${c.id}.${field}.${lang}`);
      }
    }
  }
});

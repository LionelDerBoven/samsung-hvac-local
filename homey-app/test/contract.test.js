'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MODE, climateToHomey, command, compareTemperature, climateSettings,
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
    ['actions', 'set_climate', 'mode', 'samsung_hvac_mode'],
    ['actions', 'set_climate', 'fan', 'samsung_fan_speed'],
    ['actions', 'set_climate', 'swing', 'samsung_swing'],
    ['actions', 'set_climate', 'preset', 'samsung_preset'],
  ];
  for (const [kind, id, arg, cap] of pairs) {
    const known = capValues(cap);
    for (const v of argValues(kind, id, arg).filter((x) => !(id === 'set_climate' && x === 'keep'))) {
      assert.ok(known.includes(v), `${id}: ${v} not in ${cap}`);
    }
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
      for (const a of c.args || []) {
        for (const lang of ['en', 'nl', 'fr']) {
          if (a.title) assert.ok(a.title[lang], `${c.id}.${a.name}.title.${lang}`);
          if (a.placeholder) assert.ok(a.placeholder[lang], `${c.id}.${a.name}.placeholder.${lang}`);
          for (const v of a.values || []) assert.ok(v.label[lang], `${c.id}.${a.name}.${v.id}.${lang}`);
        }
      }
    }
  }
});

const TRAITS = {
  modes: ['cool', 'heat', 'dry', 'fan', 'auto'], min: 16, max: 30, step: 1,
};

test('climateSettings: Off sends only the mode', () => {
  const r = climateSettings({
    mode: 'off', temperature: 21, fan: 'high', swing: 'both', preset: 'quiet',
  }, TRAITS);
  assert.deepEqual(r, { values: { samsung_hvac_mode: 'off' }, clamped: false });
});

test('climateSettings: keep, undefined and an empty temperature leave settings unchanged', () => {
  assert.deepEqual(climateSettings({
    mode: 'heat', temperature: undefined, fan: 'keep', swing: undefined, preset: 'keep',
  }, TRAITS).values, { samsung_hvac_mode: 'heat' });
  assert.deepEqual(climateSettings({ mode: 'cool', temperature: null }, TRAITS).values, { samsung_hvac_mode: 'cool' });
  assert.deepEqual(climateSettings({ mode: 'cool', temperature: '' }, TRAITS).values, { samsung_hvac_mode: 'cool' });
});

test('climateSettings: every value set', () => {
  assert.deepEqual(climateSettings({
    mode: 'heat', temperature: 21, fan: 'auto', swing: 'vertical', preset: 'none',
  }, TRAITS), {
    values: {
      samsung_hvac_mode: 'heat', target_temperature: 21, samsung_fan_speed: 'auto', samsung_swing: 'vertical', samsung_preset: 'none',
    },
    clamped: false,
  });
});

test('climateSettings: rounds to the step and clamps to the range', () => {
  const at = (temperature, traits = TRAITS) => climateSettings({ mode: 'cool', temperature }, traits);
  assert.deepEqual(at(21.4), { values: { samsung_hvac_mode: 'cool', target_temperature: 21 }, clamped: false });
  assert.equal(at(21.5).values.target_temperature, 22);
  assert.deepEqual(at(35), { values: { samsung_hvac_mode: 'cool', target_temperature: 30 }, clamped: true });
  assert.deepEqual(at(10), { values: { samsung_hvac_mode: 'cool', target_temperature: 16 }, clamped: true });
  const half = { ...TRAITS, step: 0.5 };
  assert.equal(at(21.3, half).values.target_temperature, 21.5);
  assert.equal(at(21.2, half).values.target_temperature, 21);
  assert.deepEqual(at(30.2, half), { values: { samsung_hvac_mode: 'cool', target_temperature: 30 }, clamped: false });
  assert.deepEqual(at(30.4, half), { values: { samsung_hvac_mode: 'cool', target_temperature: 30 }, clamped: true });
  assert.equal(at('22.5', half).values.target_temperature, 22.5);
});

test('climateSettings: Fan and Dry leave out the temperature', () => {
  for (const mode of ['fan', 'dry']) {
    assert.deepEqual(climateSettings({ mode, temperature: 21, fan: 'low' }, TRAITS).values, {
      samsung_hvac_mode: mode, samsung_fan_speed: 'low',
    }, mode);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const origLoad = Module._load;
Module._load = function stubHomey(request, parent, isMain) {
  if (request === 'homey') return { Device: class FakeDevice {} };
  return origLoad.call(this, request, parent, isMain);
};
const IndoorUnitDevice = require('../drivers/indoor-unit/device');

Module._load = origLoad;

const CLIMATE_ENTITY = {
  key: 1,
  modes: [0, 1, 2, 3, 4, 5],
  fanModes: [2, 3, 4, 5],
  customFanModes: ['Turbo'],
  swingModes: [0, 1, 2, 3],
  presets: [0, 4, 5, 6],
  customPresets: ['WindFree'],
};

function makeDevice(initialPreset) {
  const sent = [];
  const timers = new Map();
  let nextId = 1;
  const dev = Object.create(IndoorUnitDevice.prototype);
  dev.unit = { roles: { climate: CLIMATE_ENTITY } };
  dev.traits = {
    modes: ['cool', 'heat', 'dry', 'fan', 'auto'], min: 16, max: 30, step: 1,
  };
  dev.reported = initialPreset !== undefined ? { climate: { preset: initialPreset } } : {};
  dev.lastMode = 'heat';
  dev.fanFollowUpTimer = null;
  dev.homey = {
    __: (k) => k,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
  dev.bridge = {
    climateCommand: (entity, fields) => sent.push({ entity, fields: { ...fields } }),
    removeListener: () => {},
  };
  dev.homey.app = { releaseBridge: () => {} };
  dev.getStore = () => ({ mac: 'aa:bb:cc:dd:ee:ff' });
  dev.hasCapability = () => true;
  dev.getCapabilityValue = (cap) => (cap === 'samsung_preset' ? (initialPreset || null) : null);
  dev.error = () => {};
  return { dev, sent, timers };
}

test('leaving Quiet to none + Auto defers fan speed to a follow-up packet', async () => {
  const { dev, sent, timers } = makeDevice('quiet');
  await dev.onClimateChange({
    samsung_hvac_mode: 'heat',
    target_temperature: 30,
    samsung_fan_speed: 'auto',
    samsung_swing: 'horizontal',
    samsung_preset: 'none',
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fields.preset, 0);
  assert.equal(sent[0].fields.targetTemperature, 30);
  assert.equal('fanMode' in sent[0].fields, false);
  assert.equal('customFanMode' in sent[0].fields, false);
  assert.equal(timers.size, 1);

  const [{ fn, ms }] = [...timers.values()];
  assert.equal(ms, 500);
  fn();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].fields, { fanMode: 2 });
  assert.equal(dev.fanFollowUpTimer, null);
});

test('staying on preset none sends fan speed immediately in one command', async () => {
  const { dev, sent, timers } = makeDevice('none');
  await dev.onClimateChange({
    samsung_hvac_mode: 'heat',
    target_temperature: 22,
    samsung_fan_speed: 'auto',
    samsung_swing: 'horizontal',
    samsung_preset: 'none',
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fields.fanMode, 2);
  assert.equal(sent[0].fields.preset, 0);
  assert.equal(timers.size, 0);
});

test('a newer command cancels any pending fan follow-up', async () => {
  const { dev, sent, timers } = makeDevice('quiet');
  await dev.onClimateChange({
    samsung_hvac_mode: 'heat',
    target_temperature: 30,
    samsung_fan_speed: 'auto',
    samsung_preset: 'none',
  });
  assert.equal(timers.size, 1);

  await dev.onClimateChange({ samsung_hvac_mode: 'off' });
  assert.equal(timers.size, 0);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].fields, { mode: 0 });
});

test('detach clears any pending fan follow-up timer', async () => {
  const { dev, timers } = makeDevice('windfree');
  await dev.onClimateChange({
    samsung_hvac_mode: 'cool',
    target_temperature: 22,
    samsung_fan_speed: 'high',
    samsung_preset: 'none',
  });
  assert.equal(timers.size, 1);

  dev.detach();
  assert.equal(timers.size, 0);
  assert.equal(dev.fanFollowUpTimer, null);
});

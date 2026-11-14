'use strict';

const Homey = require('homey');
const { Connection } = require('../../lib/esphome/connection');
const {
  groupUnits, isBridge, normaliseMac, compareTemperature,
} = require('../../lib/contract');

class IndoorUnitDriver extends Homey.Driver {

  async onInit() {
    const { flow } = this.homey;
    this.modeChanged = flow.getDeviceTriggerCard('mode_changed');
    this.presetChanged = flow.getDeviceTriggerCard('preset_changed');
    this.fanChanged = flow.getDeviceTriggerCard('fan_speed_changed');
    this.swingChanged = flow.getDeviceTriggerCard('swing_changed');
    this.switchCards = {};
    for (const kind of ['filter_alarm', 'auto_clean']) {
      for (const state of ['on', 'off']) this.switchCards[`${kind}_${state}`] = flow.getDeviceTriggerCard(`${kind}_${state}`);
    }

    // Actions run the device's own capability listeners, so Flows behave like the device view.
    const setter = (card, cap, arg) => flow.getActionCard(card)
      .registerRunListener((args) => {
        if (!args.device.hasCapability(cap)) throw new Error(this.homey.__('device.not_supported'));
        return args.device.triggerCapabilityListener(cap, args[arg]);
      });
    setter('set_mode', 'samsung_hvac_mode', 'mode');
    setter('set_fan_speed', 'samsung_fan_speed', 'fan');
    setter('set_swing', 'samsung_swing', 'swing');
    setter('set_preset', 'samsung_preset', 'preset');
    // Everything at once: one climate command. A value other than "keep" needs its capability.
    const optionalCaps = { fan: 'samsung_fan_speed', swing: 'samsung_swing', preset: 'samsung_preset' };
    flow.getActionCard('set_climate').registerRunListener((args) => {
      if (args.mode !== 'off') {
        for (const [arg, cap] of Object.entries(optionalCaps)) {
          if (args[arg] && args[arg] !== 'keep' && !args.device.hasCapability(cap)) throw new Error(this.homey.__('device.not_supported'));
        }
      }
      return args.device.setClimate(args);
    });
    flow.getActionCard('set_auto_clean').registerRunListener(({ device, state }) => {
      if (!device.hasCapability('samsung_auto_clean')) throw new Error(this.homey.__('device.not_supported'));
      return device.triggerCapabilityListener('samsung_auto_clean', state === 'on');
    });
    flow.getActionCard('reset_filter').registerRunListener(({ device }) => device.resetFilter());

    flow.getConditionCard('mode_is').registerRunListener(({ device, mode }) => (
      device.getCapabilityValue('samsung_hvac_mode') === mode));

    // Conditions on a capability the unit may lack: an error instead of a silent "false".
    const is = (card, cap, test) => flow.getConditionCard(card).registerRunListener((args) => {
      if (!args.device.hasCapability(cap)) throw new Error(this.homey.__('device.not_supported'));
      return test(args.device.getCapabilityValue(cap), args);
    });
    is('preset_is', 'samsung_preset', (value, { preset }) => value === preset);
    is('fan_speed_is', 'samsung_fan_speed', (value, { fan }) => value === fan);
    is('swing_is', 'samsung_swing', (value, { swing }) => value === swing);
    is('target_temperature_is', 'target_temperature', (value, { comparison, temperature }) => (
      compareTemperature(value, comparison, temperature)));
    is('filter_needs_cleaning', 'alarm_generic.filter', (value) => value === true);
    is('auto_clean_is', 'samsung_auto_clean', (value) => value === true);
  }

  triggerModeChanged(device, mode) {
    this.modeChanged.trigger(device, { mode: this.homey.__(`flow.mode.${mode}`) }).catch(this.error);
  }

  triggerPresetChanged(device, preset) {
    this.presetChanged.trigger(device, { preset: this.homey.__(`flow.preset.${preset}`) }).catch(this.error);
  }

  triggerFanChanged(device, fan) {
    this.fanChanged.trigger(device, { fan_speed: this.homey.__(`flow.fan.${fan}`) }).catch(this.error);
  }

  triggerSwingChanged(device, swing) {
    this.swingChanged.trigger(device, { swing: this.homey.__(`flow.swing.${swing}`) }).catch(this.error);
  }

  /** kind: filter_alarm | auto_clean */
  triggerSwitch(device, kind, on) {
    const card = this.switchCards[`${kind}_${on ? 'on' : 'off'}`];
    if (card) card.trigger(device).catch(this.error);
  }

  /**
   * Pairing: pick a bridge found on the network or enter its address (select / manual), enter the
   * API encryption key (key), then choose the indoor units (list_devices).
   */
  async onPair(session) {
    const pending = {
      host: '', port: 6053, key: '', units: [], mac: '', bridgeName: '',
    };

    session.setHandler('discover', async () => this.homey.app.discoveredBridges());

    session.setHandler('set_host', async ({ host, port } = {}) => {
      const address = String(host || '').trim();
      if (!address) throw new Error(this.homey.__('pair.errors.no_host'));
      pending.host = address;
      pending.port = Number(port) || 6053;
      this.log('pair: host set');
      return true;
    });

    session.setHandler('connect', async ({ key } = {}) => {
      pending.key = String(key || '').trim();
      const conn = new Connection({
        host: pending.host, port: pending.port, key: pending.key, clientInfo: `Homey ${this.homey.manifest.id} (pairing)`,
      });
      try {
        const info = await conn.connect();
        if (!isBridge(info)) throw Object.assign(new Error(), { code: 'not_bridge' });
        const units = groupUnits(info, conn.entities);
        if (!units.indoor.length) throw Object.assign(new Error(), { code: 'no_units' });
        pending.mac = normaliseMac(info.mac);
        pending.bridgeName = info.friendlyName || info.name;
        pending.units = units.indoor.map((u) => ({ deviceId: u.deviceId, name: u.name }));
        this.log(`pair: connected, ${pending.units.length} indoor unit(s)`);
        return true;
      } catch (err) {
        this.log(`pair: connect failed (${err.code || err.message})`);
        throw new Error(this.describeError(err));
      } finally {
        conn.close();
      }
    });

    session.setHandler('list_devices', async () => {
      this.log(`pair: list_devices (${pending.units.length} unit(s))`);
      const paired = new Set(this.getDevices().map((d) => d.getData().id));
      return pending.units
        .map((u) => ({
          name: u.name || pending.bridgeName,
          data: { id: `${pending.mac}-${u.deviceId}` },
          store: {
            mac: pending.mac, host: pending.host, port: pending.port, key: pending.key, deviceId: u.deviceId,
          },
        }))
        .filter((d) => !paired.has(d.data.id));
    });
  }

  describeError(err) {
    const code = err && err.code;
    const known = ['timeout', 'refused', 'bad_key', 'no_encryption', 'not_bridge', 'no_units'];
    return this.homey.__(`pair.errors.${known.includes(code) ? code : 'generic'}`, { message: (err && err.message) || '' });
  }

}

module.exports = IndoorUnitDriver;

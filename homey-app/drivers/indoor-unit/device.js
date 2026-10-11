'use strict';

const Homey = require('homey');
const {
  climateTraits, climateToHomey, command,
} = require('../../lib/contract');

// Capabilities that are sent to the AC as one climate command (bundled, see onClimateChange).
const CLIMATE_CAPS = ['onoff', 'target_temperature', 'samsung_hvac_mode', 'samsung_fan_speed', 'samsung_swing', 'samsung_preset'];
const ENERGY_CAPS = ['measure_power', 'meter_power', 'measure_temperature.outdoor'];
const WINDFREE_MODES = ['cool', 'dry'];

class IndoorUnitDevice extends Homey.Device {

  async onInit() {
    this.unit = null;
    this.roleByKey = new Map(); // entity key → role, for this unit only (~15 entries)
    this.lastMode = this.getStoreValue('lastMode') || 'cool';
    this.onBridgeState = (key, value) => this.onState(key, value);
    this.onBridgeStatus = (online, err) => this.onStatus(online, err);

    this.registerMultipleCapabilityListener(CLIMATE_CAPS, (values) => this.onClimateChange(values), 300);

    const store = this.getStore();
    this.bridge = this.homey.app.getBridge(store);
    this.bridge.on('state', this.onBridgeState);
    this.bridge.on('status', this.onBridgeStatus);
    if (this.bridge.online) this.onStatus(true).catch(this.error);
    else this.setUnavailable(this.homey.__('device.connecting')).catch(this.error);
  }

  // ---------- bridge events ----------

  async onStatus(online, err) {
    if (!online) {
      this.unit = null;
      const reason = err && err.code === 'bad_key' ? 'device.bad_key' : 'device.offline';
      await this.setUnavailable(this.homey.__(reason)).catch(this.error);
      return;
    }
    const unit = this.bridge.indoorUnit(this.getStore().deviceId);
    if (!unit) {
      await this.setUnavailable(this.homey.__('device.unit_missing')).catch(this.error);
      return;
    }
    this.unit = unit;
    this.roleByKey.clear();
    for (const [role, e] of Object.entries(unit.roles)) this.roleByKey.set(e.key, role);
    // Single split: the outdoor unit's energy and temperature belong to this device.
    const outdoor = this.bridge.isSingleSplit ? this.bridge.outdoorUnit : null;
    this.outdoor = outdoor;
    if (outdoor) for (const [role, e] of Object.entries(outdoor.roles)) this.roleByKey.set(e.key, role);
    const bridgeRoles = this.bridge.units.bridge.roles;
    if (bridgeRoles.bus_active) this.roleByKey.set(bridgeRoles.bus_active.key, 'bus_active');

    await this.syncCapabilities();
    await this.setAvailable().catch(this.error);
    // Replay what the bridge already knows (states arrive before devices may have set up).
    for (const key of this.roleByKey.keys()) {
      if (this.bridge.states.has(key)) await this.onState(key, this.bridge.states.get(key));
    }
  }

  async syncCapabilities() {
    const { roles } = this.unit;
    const want = new Set(['onoff', 'target_temperature', 'measure_temperature', 'samsung_hvac_mode']);
    if (roles.room_humidity) want.add('measure_humidity');
    if (this.outdoor) {
      if (this.outdoor.roles.outdoor_temperature) want.add('measure_temperature.outdoor');
      if (this.outdoor.roles.power) want.add('measure_power');
      if (this.outdoor.roles.energy) want.add('meter_power');
    }
    this.traits = climateTraits(roles.climate);
    if (this.traits.fans.length) want.add('samsung_fan_speed');
    if (this.traits.swings.length > 1) want.add('samsung_swing');
    if (this.traits.presets.length > 1) want.add('samsung_preset');

    const optional = ['measure_humidity', 'samsung_fan_speed', 'samsung_swing', 'samsung_preset', ...ENERGY_CAPS];
    for (const cap of optional) {
      if (want.has(cap) && !this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
      if (!want.has(cap) && this.hasCapability(cap)) await this.removeCapability(cap).catch(this.error);
    }
    const { min, max, step } = this.traits;
    const opts = this.getCapabilityOptions('target_temperature') || {};
    if (opts.min !== min || opts.max !== max || opts.step !== step) {
      await this.setCapabilityOptions('target_temperature', { min, max, step }).catch(this.error);
    }
  }

  async onState(key, value) {
    const role = this.roleByKey.get(key);
    if (!role) return;
    switch (role) {
      case 'climate': {
        const c = climateToHomey(value);
        await this.update('onoff', c.on);
        if (c.mode) {
          await this.update('samsung_hvac_mode', c.mode);
          if (c.mode !== this.lastMode) {
            this.lastMode = c.mode;
            this.setStoreValue('lastMode', c.mode).catch(this.error);
          }
        }
        if (c.target !== null) await this.update('target_temperature', c.target);
        if (c.current !== null) await this.update('measure_temperature', c.current);
        if (c.fan) await this.update('samsung_fan_speed', c.fan);
        if (c.swing) await this.update('samsung_swing', c.swing);
        if (c.preset) await this.update('samsung_preset', c.preset);
        break;
      }
      case 'room_temperature':
        // The climate entity carries the same value; use the sensor only as a fallback.
        if (this.getCapabilityValue('measure_temperature') === null && value !== null) await this.update('measure_temperature', value);
        break;
      case 'room_humidity':
        await this.update('measure_humidity', value);
        break;
      case 'outdoor_temperature':
        await this.update('measure_temperature.outdoor', value);
        break;
      case 'power':
        await this.update('measure_power', value);
        break;
      case 'energy':
        // Cumulative counter of the AC itself; never write 0/null over a real reading.
        if (value) await this.update('meter_power', value);
        break;
      case 'bus_active':
        if (value === false) await this.setWarning(this.homey.__('device.standby')).catch(this.error);
        else await this.unsetWarning().catch(this.error);
        break;
      default:
    }
  }

  async update(cap, value) {
    if (!this.hasCapability(cap)) return;
    const v = typeof value === 'number' ? Math.round(value * 100) / 100 : value;
    if (this.getCapabilityValue(cap) === v) return;
    await this.setCapabilityValue(cap, v).catch(this.error);
  }

  // ---------- commands ----------

  async onClimateChange(values) {
    if (!this.unit || !this.unit.roles.climate) throw new Error(this.homey.__('device.offline'));
    const entity = this.unit.roles.climate;
    const fields = {};
    let mode = values.samsung_hvac_mode;
    if (values.onoff === false) {
      fields.mode = 0;
    } else if (mode || values.onoff === true) {
      mode = mode || this.lastMode;
      if (this.traits && !this.traits.modes.includes(mode)) mode = this.traits.modes[0];
      Object.assign(fields, command.mode(mode));
    }
    if (values.target_temperature !== undefined) fields.targetTemperature = values.target_temperature;
    for (const [cap, kind] of [['samsung_fan_speed', 'fan'], ['samsung_swing', 'swing'], ['samsung_preset', 'preset']]) {
      if (values[cap] === undefined) continue;
      const f = command[kind](values[cap], entity);
      if (!f) throw new Error(this.homey.__('device.not_supported'));
      Object.assign(fields, f);
    }
    if (values.samsung_preset === 'windfree') {
      const effective = mode || (this.getCapabilityValue('onoff') ? this.getCapabilityValue('samsung_hvac_mode') : null);
      if (!WINDFREE_MODES.includes(effective)) throw new Error(this.homey.__('device.windfree_mode'));
    }
    try {
      this.bridge.climateCommand(entity, fields);
    } catch (err) {
      throw new Error(this.homey.__('device.offline'));
    }
  }

  // ---------- lifecycle ----------

  detach() {
    if (!this.bridge) return;
    this.bridge.removeListener('state', this.onBridgeState);
    this.bridge.removeListener('status', this.onBridgeStatus);
    this.homey.app.releaseBridge(this.getStore().mac);
    this.bridge = null;
  }

  async onUninit() {
    this.detach();
  }

  async onDeleted() {
    this.detach();
  }

}

module.exports = IndoorUnitDevice;

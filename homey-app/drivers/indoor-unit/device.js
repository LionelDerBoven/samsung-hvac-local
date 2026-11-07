'use strict';

const Homey = require('homey');
const {
  climateTraits, climateToHomey, command,
} = require('../../lib/contract');

// Capabilities that are sent to the AC as one climate command (bundled, see onClimateChange).
const CLIMATE_CAPS = ['onoff', 'target_temperature', 'samsung_hvac_mode', 'samsung_fan_speed', 'samsung_swing', 'samsung_preset'];
// Order of the pickers. Homey's app opens the picker tab on the last one, so the mode comes last.
const PICKERS = ['samsung_fan_speed', 'samsung_swing', 'samsung_preset', 'samsung_hvac_mode'];
// Bump when capability options in the manifest change: affected capabilities are re-added once.
const CAPS_REVISION = 3;
const REVISED_CAPS = ['button.filter_reset']; // rev 3: filter reset back to a maintenance action
// Capabilities that depend on what the bridge offers (added or removed in syncCapabilities).
const OPTIONAL = [
  'measure_humidity', 'measure_temperature.outdoor', 'measure_power', 'meter_power',
  'samsung_fan_speed', 'samsung_swing', 'samsung_preset', 'samsung_target_temperature',
  'samsung_filter_usage', 'alarm_generic.filter', 'button.filter_reset', 'onoff.auto_clean',
  'alarm_generic', 'samsung_error_code', 'measure_temperature.eva_in', 'measure_temperature.eva_out',
  'button.restart',
];
const WINDFREE_MODES = ['cool', 'dry'];

class IndoorUnitDevice extends Homey.Device {

  async onInit() {
    this.unit = null;
    this.outdoor = null;
    this.roleByKey = new Map(); // entity key → role, for this unit only (~20 entries)
    this.lastMode = this.getStoreValue('lastMode') || 'cool';
    this.onBridgeState = (key, value) => this.onState(key, value).catch(this.error);
    this.onBridgeStatus = (online, err) => this.onStatus(online, err).catch(this.error);
    this.onBridgeContract = (mismatch) => this.showContract(mismatch).catch(this.error);

    if (this.getClass() !== 'airconditioning') await this.setClass('airconditioning').catch(this.error);

    this.registerMultipleCapabilityListener(CLIMATE_CAPS, (values) => this.onClimateChange(values), 300);
    this.registerCapabilityListener('onoff.auto_clean', (value) => this.sendSwitch('auto_clean', value));
    this.registerCapabilityListener('button.filter_reset', () => this.resetFilter());
    this.registerCapabilityListener('button.restart', () => this.restartBridge());

    const store = this.getStore();
    this.bridge = this.homey.app.getBridge(store);
    this.bridge.on('state', this.onBridgeState);
    this.bridge.on('status', this.onBridgeStatus);
    this.bridge.on('contract', this.onBridgeContract);
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
    if (!this.bridge) return; // deleted or uninitialised while an event was in flight
    const unit = this.bridge.indoorUnit(this.getStore().deviceId);
    if (!unit) {
      await this.setUnavailable(this.homey.__('device.unit_missing')).catch(this.error);
      return;
    }
    this.unit = unit;
    this.roleByKey.clear();
    for (const [role, e] of Object.entries(unit.roles)) this.roleByKey.set(e.key, role);
    // Single split: the outdoor unit (energy, outdoor temperature, error code) belongs to this device.
    this.outdoor = this.bridge.isSingleSplit ? this.bridge.outdoorUnit : null;
    if (this.outdoor) for (const [role, e] of Object.entries(this.outdoor.roles)) this.roleByKey.set(e.key, role);
    this.bridgeRoles = this.bridge.units.bridge.roles;
    if (this.bridgeRoles.bus_active) this.roleByKey.set(this.bridgeRoles.bus_active.key, 'bus_active');

    await this.syncCapabilities();
    if (!this.bridge) return;
    await this.setAvailable().catch(this.error);
    await this.showContract(this.bridge.contractMismatch());
    // Replay what the bridge already knows (states arrive before devices may have set up).
    for (const key of this.roleByKey.keys()) {
      if (!this.bridge) return;
      if (this.bridge.states.has(key)) await this.onState(key, this.bridge.states.get(key));
    }
  }

  async syncCapabilities() {
    const { roles } = this.unit;
    const out = this.outdoor ? this.outdoor.roles : {};
    this.traits = climateTraits(roles.climate);
    const want = new Set();
    const wantIf = (cond, cap) => cond && want.add(cap);
    wantIf(roles.room_humidity, 'measure_humidity');
    wantIf(out.outdoor_temperature, 'measure_temperature.outdoor');
    wantIf(out.power, 'measure_power');
    wantIf(out.energy, 'meter_power');
    wantIf(out.error_code, 'alarm_generic');
    wantIf(out.error_code, 'samsung_error_code');
    wantIf(this.traits.fans.length, 'samsung_fan_speed');
    wantIf(this.traits.swings.length > 1, 'samsung_swing');
    wantIf(this.traits.presets.length > 1, 'samsung_preset');
    wantIf(roles.filter_usage, 'samsung_filter_usage');
    wantIf(roles.filter_alarm, 'alarm_generic.filter');
    wantIf(roles.filter_reset, 'button.filter_reset');
    wantIf(roles.auto_clean, 'onoff.auto_clean');
    wantIf(roles.eva_in, 'measure_temperature.eva_in');
    wantIf(roles.eva_out, 'measure_temperature.eva_out');
    wantIf(this.bridgeRoles.restart, 'button.restart');
    want.add('samsung_target_temperature');

    for (const cap of OPTIONAL) {
      if (want.has(cap) && !this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
      if (!want.has(cap) && this.hasCapability(cap)) await this.removeCapability(cap).catch(this.error);
    }
    await this.orderPickers();
    if ((this.getStoreValue('capsRevision') || 1) < CAPS_REVISION) {
      for (const cap of REVISED_CAPS) {
        if (!this.hasCapability(cap)) continue;
        await this.removeCapability(cap).catch(this.error);
        await this.addCapability(cap).catch(this.error);
      }
      await this.setStoreValue('capsRevision', CAPS_REVISION).catch(this.error);
    }

    await this.applyTemperatureStep();
  }

  /** Temperature range and step as configured on the bridge (target_step: 1 or 0.5 °C). */
  async applyTemperatureStep() {
    if (!this.traits) return;
    const { min, max, step } = this.traits;
    const decimals = step < 1 ? 1 : 0;
    const opts = this.getCapabilityOptions('target_temperature') || {};
    if (opts.min !== min || opts.max !== max || opts.step !== step || opts.decimals !== decimals) {
      await this.setCapabilityOptions('target_temperature', {
        min, max, step, decimals,
      }).catch(this.error);
    }
  }

  /** Homey keeps capabilities in the order they were added; re-add pickers when that order is off. */
  async orderPickers() {
    const present = this.getCapabilities().filter((c) => PICKERS.includes(c));
    const wanted = PICKERS.filter((c) => present.includes(c));
    if (present.join() === wanted.join()) return;
    for (const cap of present) await this.removeCapability(cap).catch(this.error);
    for (const cap of wanted) await this.addCapability(cap).catch(this.error);
  }

  async onState(key, value) {
    const role = this.roleByKey.get(key);
    if (!role) return;
    // "Unknown" (e.g. right after a bridge restart, until the AC reports again): keep the last value.
    if (value === null && role !== 'climate') return;
    switch (role) {
      case 'climate': await this.onClimate(value); break;
      case 'room_temperature':
        // The climate entity carries the same value; use the sensor only as a fallback.
        if (this.getCapabilityValue('measure_temperature') === null && value !== null) await this.update('measure_temperature', value);
        break;
      case 'room_humidity': await this.update('measure_humidity', value); break;
      case 'outdoor_temperature': await this.update('measure_temperature.outdoor', value); break;
      case 'power': await this.update('measure_power', value); break;
      case 'energy':
        // Cumulative counter of the AC itself; never write 0/null over a real reading.
        if (value) await this.update('meter_power', value);
        break;
      case 'error_code':
        if (value === null) break;
        await this.update('samsung_error_code', value);
        await this.update('alarm_generic', value > 0);
        break;
      case 'filter_usage': await this.update('samsung_filter_usage', value); break;
      case 'filter_alarm': if (value !== null) await this.update('alarm_generic.filter', value); break;
      case 'auto_clean': await this.update('onoff.auto_clean', value); break;
      case 'eva_in': await this.update('measure_temperature.eva_in', value); break;
      case 'eva_out': await this.update('measure_temperature.eva_out', value); break;
      case 'bus_active':
        if (value === false) await this.setWarning(this.homey.__('device.standby')).catch(this.error);
        else await this.unsetWarning().catch(this.error);
        break;
      default:
    }
  }

  async onClimate(value) {
    const c = climateToHomey(value);
    const wasMode = this.getCapabilityValue('samsung_hvac_mode');
    const wasPreset = this.getCapabilityValue('samsung_preset');
    await this.update('onoff', c.on);
    await this.update('samsung_hvac_mode', c.mode || 'off');
    if (c.mode && c.mode !== this.lastMode) {
      this.lastMode = c.mode;
      this.setStoreValue('lastMode', c.mode).catch(this.error);
    }
    if (c.target !== null) {
      await this.update('target_temperature', c.target);
      await this.update('samsung_target_temperature', c.target); // selectable as status indicator
    }
    if (c.current !== null) await this.update('measure_temperature', c.current);
    if (c.fan) await this.update('samsung_fan_speed', c.fan);
    if (c.swing) await this.update('samsung_swing', c.swing);
    if (c.preset) await this.update('samsung_preset', c.preset);
    // Flow triggers: only real changes of a running AC, not the replay at startup.
    if (this.ready && c.mode && wasMode && wasMode !== 'off' && c.mode !== wasMode) {
      this.driver.triggerModeChanged(this, c.mode);
    }
    if (this.ready && c.preset && wasPreset !== null && c.preset !== wasPreset) {
      this.driver.triggerPresetChanged(this, c.preset);
    }
    this.ready = true;
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
    if (values.onoff === false || mode === 'off') {
      fields.mode = 0;
      mode = undefined;
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
    this.guard(() => this.bridge.climateCommand(entity, fields));
  }

  async sendSwitch(role, value) {
    const entity = this.unit && this.unit.roles[role];
    if (!entity) throw new Error(this.homey.__('device.offline'));
    this.guard(() => this.bridge.switchCommand(entity, value));
  }

  async resetFilter() {
    const entity = this.unit && this.unit.roles.filter_reset;
    if (!entity) throw new Error(this.homey.__('device.not_supported'));
    this.guard(() => this.bridge.press(entity));
  }

  async restartBridge() {
    const entity = this.bridgeRoles && this.bridgeRoles.restart;
    if (!entity) throw new Error(this.homey.__('device.not_supported'));
    this.guard(() => this.bridge.press(entity));
  }

  guard(fn) {
    try {
      fn();
    } catch (err) {
      this.error('command failed:', err.message);
      throw new Error(this.homey.__('device.offline'));
    }
  }

  /** Warns on the device when the bridge firmware speaks another contract major than this app. */
  async showContract(mismatch) {
    if (mismatch) {
      this.contractWarning = true;
      await this.setWarning(this.homey.__('device.firmware_mismatch')).catch(this.error);
    } else if (this.contractWarning) { // only clear our own warning, not the standby one
      this.contractWarning = false;
      await this.unsetWarning().catch(this.error);
    }
  }

  // ---------- lifecycle ----------

  detach() {
    if (!this.bridge) return;
    this.bridge.removeListener('state', this.onBridgeState);
    this.bridge.removeListener('status', this.onBridgeStatus);
    this.bridge.removeListener('contract', this.onBridgeContract);
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

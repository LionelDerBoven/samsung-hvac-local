'use strict';

// The bridge contract (see CONTRACT.md in the repository root): how entities of a
// Samsung HVAC Local bridge map to roles, and how climate values map to Homey values.

const PROJECT_NAME = 'ldbtechnology.samsung_hvac_local';
const CONTRACT_MAJOR = '1';

/** domain + entity name → role, per unit kind. */
const INDOOR_ROLES = {
  'climate/Climate': 'climate',
  'sensor/Room temperature': 'room_temperature',
  'sensor/Room humidity': 'room_humidity',
  'sensor/EVA in temperature': 'eva_in',
  'sensor/EVA out temperature': 'eva_out',
  'sensor/Filter usage': 'filter_usage',
  'sensor/Filter hours': 'filter_hours',
  'sensor/Filter capacity': 'filter_capacity',
  'binary_sensor/Filter alarm': 'filter_alarm',
  'button/Filter reset': 'filter_reset',
  'switch/Auto clean': 'auto_clean',
};
const OUTDOOR_ROLES = {
  'sensor/Outdoor temperature': 'outdoor_temperature',
  'sensor/Power': 'power',
  'sensor/Energy': 'energy',
  'sensor/Error code': 'error_code',
};
const BRIDGE_ROLES = {
  'text_sensor/Contract': 'contract',
  'binary_sensor/Bus active': 'bus_active',
  'button/Restart': 'restart',
};

// ESPHome enums (api.proto) ↔ Homey capability values.
const MODE = {
  off: 0, heat_cool: 1, cool: 2, heat: 3, fan: 4, dry: 5, auto: 6,
};
const SWING = {
  off: 0, both: 1, vertical: 2, horizontal: 3,
};
const FAN = {
  auto: [2], low: [3], medium: [6, 4], high: [5], // Samsung reports MIDDLE (6)
};
const FAN_CUSTOM = { turbo: 'Turbo' };
const PRESET = { none: 0, eco: 5, sleep: 6 };
const PRESET_CUSTOM = {
  quiet: 'Quiet', fast: 'Fast', longreach: 'LongReach', windfree: 'WindFree',
};

const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
const MODE_BY_ENUM = invert(MODE);
const SWING_BY_ENUM = invert(SWING);
const PRESET_BY_ENUM = invert(PRESET);
const PRESET_BY_CUSTOM = invert(PRESET_CUSTOM);
const FAN_BY_CUSTOM = invert(FAN_CUSTOM);
function fanByEnum(n) {
  for (const [id, list] of Object.entries(FAN)) if (list.includes(n)) return id;
  return null;
}

/**
 * Groups the entity list of a bridge into units.
 * @returns {{ indoor: object[], outdoor: object|null, bridge: object }}
 *   each unit: { deviceId, name, roles: { role: entity } }
 */
function groupUnits(deviceInfo, entities) {
  const names = new Map(deviceInfo.devices.map((d) => [d.id, d.name]));
  const byDevice = new Map();
  const bridge = { deviceId: 0, name: deviceInfo.friendlyName || deviceInfo.name, roles: {} };
  for (const e of entities) {
    const id = `${e.domain}/${e.name}`;
    if (e.deviceId === 0) {
      if (BRIDGE_ROLES[id]) bridge.roles[BRIDGE_ROLES[id]] = e;
      continue;
    }
    if (!byDevice.has(e.deviceId)) byDevice.set(e.deviceId, { deviceId: e.deviceId, name: names.get(e.deviceId) || '', entities: [] });
    byDevice.get(e.deviceId).entities.push({ id, e });
  }
  const indoor = [];
  let outdoor = null;
  for (const unit of byDevice.values()) {
    const isIndoor = unit.entities.some((x) => x.id === 'climate/Climate');
    const map = isIndoor ? INDOOR_ROLES : OUTDOOR_ROLES;
    const roles = {};
    for (const { id, e } of unit.entities) if (map[id]) roles[map[id]] = e;
    const result = { deviceId: unit.deviceId, name: unit.name, roles };
    if (isIndoor) indoor.push(result);
    else if (roles.outdoor_temperature && !outdoor) outdoor = result;
  }
  return { indoor, outdoor, bridge };
}

/** What a climate entity supports, as Homey values. */
function climateTraits(entity) {
  const modes = entity.modes.map((m) => MODE_BY_ENUM[m]).filter((m) => m && m !== 'off');
  const fans = [...new Set(entity.fanModes.map(fanByEnum).filter(Boolean))];
  for (const c of entity.customFanModes) if (FAN_BY_CUSTOM[c]) fans.push(FAN_BY_CUSTOM[c]);
  const swings = entity.swingModes.map((s) => SWING_BY_ENUM[s]).filter(Boolean);
  const presets = entity.presets.map((p) => PRESET_BY_ENUM[p]).filter(Boolean);
  for (const c of entity.customPresets) if (PRESET_BY_CUSTOM[c]) presets.push(PRESET_BY_CUSTOM[c]);
  return {
    modes,
    fans,
    swings,
    presets,
    min: entity.minTemp || 16,
    max: entity.maxTemp || 30,
    step: entity.tempStep || 1,
  };
}

/** Climate state (proto) → Homey values. */
function climateToHomey(s) {
  return {
    on: s.mode !== MODE.off,
    mode: s.mode !== MODE.off ? MODE_BY_ENUM[s.mode] || null : null,
    target: Number.isFinite(s.targetTemperature) ? s.targetTemperature : null,
    current: Number.isFinite(s.currentTemperature) && s.currentTemperature !== 0 ? s.currentTemperature : null,
    fan: s.customFanMode ? FAN_BY_CUSTOM[s.customFanMode] || null : fanByEnum(s.fanMode),
    swing: SWING_BY_ENUM[s.swingMode] || null,
    preset: s.customPreset ? PRESET_BY_CUSTOM[s.customPreset] || null : PRESET_BY_ENUM[s.preset] || null,
  };
}

/** Homey value → fields of a climate command (see Connection.climateCommand). */
const command = {
  mode: (v) => ({ mode: MODE[v] }),
  fan: (v, entity) => {
    if (FAN_CUSTOM[v]) return { customFanMode: FAN_CUSTOM[v] };
    const supported = (FAN[v] || []).find((n) => !entity || entity.fanModes.includes(n));
    return supported === undefined ? null : { fanMode: supported };
  },
  swing: (v, entity) => {
    if (!(v in SWING) || (entity && v !== 'off' && !entity.swingModes.includes(SWING[v]))) return null;
    return { swingMode: SWING[v] };
  },
  preset: (v, entity) => {
    if (PRESET_CUSTOM[v]) {
      return entity && !entity.customPresets.includes(PRESET_CUSTOM[v]) ? null : { customPreset: PRESET_CUSTOM[v] };
    }
    if (!(v in PRESET) || (entity && v !== 'none' && !entity.presets.includes(PRESET[v]))) return null;
    return { preset: PRESET[v] };
  },
};

// Half a step of the finest target step (0.5 °C): values within this are equal.
const TEMPERATURE_EPSILON = 0.25;

/** Target temperature against a Flow argument: comparison is equal | above | below. */
function compareTemperature(value, comparison, temperature) {
  if (!Number.isFinite(value) || !Number.isFinite(temperature)) return false;
  const diff = value - temperature;
  if (comparison === 'above') return diff >= TEMPERATURE_EPSILON;
  if (comparison === 'below') return diff <= -TEMPERATURE_EPSILON;
  return Math.abs(diff) < TEMPERATURE_EPSILON;
}

// Modes in which the AC has no target temperature: the set_climate card leaves it out.
const NO_TARGET_MODES = ['fan', 'dry'];
const KEEP = 'keep';

/**
 * set_climate Flow card arguments → capability values for one climate command.
 * Off sends only the mode; "keep", an undefined dropdown or an empty temperature leaves that setting as it is.
 * The temperature is rounded to the unit's step and kept within its range.
 * @returns {{ values: object, clamped: boolean }}
 */
function climateSettings(args, traits = {}) {
  const values = { samsung_hvac_mode: args.mode };
  if (args.mode === 'off') return { values, clamped: false };
  let clamped = false;
  const raw = args.temperature;
  const temperature = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (Number.isFinite(temperature) && !NO_TARGET_MODES.includes(args.mode)) {
    const { min = 16, max = 30, step = 1 } = traits;
    const rounded = Math.round(temperature / step) * step;
    const value = Math.min(max, Math.max(min, rounded));
    clamped = value !== rounded;
    values.target_temperature = Math.round(value * 100) / 100;
  }
  for (const [arg, cap] of [['fan', 'samsung_fan_speed'], ['swing', 'samsung_swing'], ['preset', 'samsung_preset']]) {
    if (args[arg] !== undefined && args[arg] !== null && args[arg] !== KEEP) values[cap] = args[arg];
  }
  return { values, clamped };
}

function isBridge(deviceInfo) {
  return deviceInfo && deviceInfo.projectName === PROJECT_NAME;
}

/** MAC address as lower-case hex without separators: the key of a bridge. */
function normaliseMac(mac) {
  return String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
}

module.exports = {
  normaliseMac,
  PROJECT_NAME,
  CONTRACT_MAJOR,
  MODE,
  groupUnits,
  climateTraits,
  climateToHomey,
  command,
  isBridge,
  compareTemperature,
  climateSettings,
};

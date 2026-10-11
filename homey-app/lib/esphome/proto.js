'use strict';

// Minimal protobuf reader/writer for the handful of ESPHome native API messages this app uses.
// Field numbers follow ESPHome's api.proto (checked against ESPHome 2026.9).

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

/** Message type ids (api.proto `option (id)`). */
const MSG = {
  HELLO_REQUEST: 1,
  HELLO_RESPONSE: 2,
  DISCONNECT_REQUEST: 5,
  DISCONNECT_RESPONSE: 6,
  PING_REQUEST: 7,
  PING_RESPONSE: 8,
  DEVICE_INFO_REQUEST: 9,
  DEVICE_INFO_RESPONSE: 10,
  LIST_ENTITIES_REQUEST: 11,
  LIST_BINARY_SENSOR: 12,
  LIST_SENSOR: 16,
  LIST_SWITCH: 17,
  LIST_TEXT_SENSOR: 18,
  LIST_DONE: 19,
  SUBSCRIBE_STATES_REQUEST: 20,
  BINARY_SENSOR_STATE: 21,
  SENSOR_STATE: 25,
  SWITCH_STATE: 26,
  TEXT_SENSOR_STATE: 27,
  SWITCH_COMMAND: 33,
  GET_TIME_REQUEST: 36,
  GET_TIME_RESPONSE: 37,
  LIST_CLIMATE: 46,
  CLIMATE_STATE: 47,
  CLIMATE_COMMAND: 48,
  LIST_BUTTON: 61,
  BUTTON_COMMAND: 62,
};

// ---------- reading ----------

function readVarint(buf, pos) {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    if (pos >= buf.length) throw new Error('Truncated varint');
    const b = buf[pos++];
    result += (b & 0x7f) * mul;
    if (!(b & 0x80)) return [result, pos];
    mul *= 128;
  }
  throw new Error('Varint too long');
}

/**
 * Parses a message into { fieldNumber: [values] }. Varints become numbers, fixed32 and
 * length-delimited fields become Buffers (views on the input, so copy what you keep).
 */
function decode(buf) {
  const fields = {};
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    let value;
    if (wire === WIRE_VARINT) {
      [value, pos] = readVarint(buf, pos);
    } else if (wire === WIRE_FIXED32) {
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else if (wire === WIRE_FIXED64) {
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === WIRE_LEN) {
      let len;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else {
      throw new Error(`Unsupported wire type ${wire}`);
    }
    if (pos > buf.length) throw new Error('Truncated field');
    (fields[field] || (fields[field] = [])).push(value);
  }
  return fields;
}

const first = (f, n) => (f[n] ? f[n][f[n].length - 1] : undefined);
const str = (f, n) => {
  const v = first(f, n); return v ? v.toString('utf8') : '';
};
const num = (f, n) => {
  const v = first(f, n); return typeof v === 'number' ? v : 0;
};
const bool = (f, n) => num(f, n) !== 0;
const u32 = (f, n) => {
  const v = first(f, n); return v ? v.readUInt32LE(0) : 0;
};
const float = (f, n) => {
  const v = first(f, n); return v ? v.readFloatLE(0) : 0;
};
const strs = (f, n) => (f[n] || []).map((b) => b.toString('utf8'));
/** Repeated enum: packed (one Buffer of varints) or unpacked (several numbers). */
function enums(f, n) {
  const out = [];
  for (const v of f[n] || []) {
    if (typeof v === 'number') {
      out.push(v);
    } else {
      let pos = 0;
      while (pos < v.length) {
        let x;
        [x, pos] = readVarint(v, pos);
        out.push(x);
      }
    }
  }
  return out;
}

// ---------- writing ----------

function varint(n) {
  const out = [];
  let v = n >>> 0 === n ? n : Number(n);
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

/** Tiny builder: new Writer().u32(1, key).bool(2, true).string(3, 'x').toBuffer() */
class Writer {

  constructor() {
    this.parts = [];
  }

  tag(field, wire) {
    this.parts.push(Buffer.from(varint(field * 8 + wire)));
    return this;
  }

  varint(field, value) {
    if (!value) return this; // proto3: defaults are not sent
    this.tag(field, WIRE_VARINT);
    this.parts.push(Buffer.from(varint(value)));
    return this;
  }

  bool(field, value) {
    return this.varint(field, value ? 1 : 0);
  }

  fixed32(field, value) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(value >>> 0, 0);
    this.tag(field, WIRE_FIXED32);
    this.parts.push(b);
    return this;
  }

  float(field, value) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(value, 0);
    this.tag(field, WIRE_FIXED32);
    this.parts.push(b);
    return this;
  }

  string(field, value) {
    if (!value) return this;
    const b = Buffer.from(String(value), 'utf8');
    this.tag(field, WIRE_LEN);
    this.parts.push(Buffer.from(varint(b.length)), b);
    return this;
  }

  toBuffer() {
    return Buffer.concat(this.parts);
  }

}

// ---------- message mappers (keep only the fields the app uses) ----------

function parseHelloResponse(buf) {
  const f = decode(buf);
  return {
    major: num(f, 1), minor: num(f, 2), serverInfo: str(f, 3), name: str(f, 4),
  };
}

function parseDeviceInfo(buf) {
  const f = decode(buf);
  return {
    name: str(f, 2),
    mac: str(f, 3),
    esphomeVersion: str(f, 4),
    projectName: str(f, 8),
    projectVersion: str(f, 9),
    friendlyName: str(f, 13),
    devices: (f[20] || []).map((b) => {
      const d = decode(b);
      return { id: num(d, 1), name: str(d, 2) };
    }),
  };
}

/** List-entities responses share object_id=1, key=2, name=3; device_id differs per type. */
const DEVICE_ID_FIELD = {
  [MSG.LIST_BINARY_SENSOR]: 10,
  [MSG.LIST_SENSOR]: 14,
  [MSG.LIST_SWITCH]: 10,
  [MSG.LIST_TEXT_SENSOR]: 9,
  [MSG.LIST_CLIMATE]: 26,
  [MSG.LIST_BUTTON]: 9,
};
const DOMAIN = {
  [MSG.LIST_BINARY_SENSOR]: 'binary_sensor',
  [MSG.LIST_SENSOR]: 'sensor',
  [MSG.LIST_SWITCH]: 'switch',
  [MSG.LIST_TEXT_SENSOR]: 'text_sensor',
  [MSG.LIST_CLIMATE]: 'climate',
  [MSG.LIST_BUTTON]: 'button',
};

function parseListEntity(type, buf) {
  const f = decode(buf);
  const entity = {
    domain: DOMAIN[type],
    objectId: str(f, 1),
    key: u32(f, 2),
    name: str(f, 3),
    deviceId: num(f, DEVICE_ID_FIELD[type]),
  };
  if (type === MSG.LIST_SENSOR) {
    entity.unit = str(f, 6);
    entity.decimals = num(f, 7);
  } else if (type === MSG.LIST_CLIMATE) {
    entity.modes = enums(f, 7);
    entity.minTemp = float(f, 8);
    entity.maxTemp = float(f, 9);
    entity.tempStep = float(f, 10);
    entity.fanModes = enums(f, 13);
    entity.swingModes = enums(f, 14);
    entity.customFanModes = strs(f, 15);
    entity.presets = enums(f, 16);
    entity.customPresets = strs(f, 17);
  }
  return entity;
}

/** State responses: key is field 1 everywhere. Returns { key, value } in a uniform shape. */
function parseState(type, buf) {
  const f = decode(buf);
  const key = u32(f, 1);
  switch (type) {
    case MSG.SENSOR_STATE:
      return { key, value: bool(f, 3) ? null : float(f, 2) };
    case MSG.BINARY_SENSOR_STATE:
      return { key, value: bool(f, 3) ? null : bool(f, 2) };
    case MSG.SWITCH_STATE:
      return { key, value: bool(f, 2) };
    case MSG.TEXT_SENSOR_STATE:
      return { key, value: bool(f, 3) ? null : str(f, 2) };
    case MSG.CLIMATE_STATE:
      return {
        key,
        value: {
          mode: num(f, 2),
          currentTemperature: float(f, 3),
          targetTemperature: float(f, 4),
          fanMode: num(f, 9),
          swingMode: num(f, 10),
          customFanMode: str(f, 11),
          preset: num(f, 12), // proto3: NONE (0) is not sent
          customPreset: str(f, 13),
        },
      };
    default:
      return null;
  }
}

module.exports = {
  MSG, Writer, decode, parseHelloResponse, parseDeviceInfo, parseListEntity, parseState,
};

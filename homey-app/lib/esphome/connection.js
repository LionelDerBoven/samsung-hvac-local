/* eslint-disable max-classes-per-file */

'use strict';

/* eslint-disable homey-app/global-timers -- no Homey instance here; every timer is cleared in cleanup()/fail() */

// One encrypted connection to an ESPHome node (native API over TCP, Noise encryption).
// Covers what this app needs: device info, entity list, state updates and a few commands.
// Reconnecting is the caller's job (see lib/bridge.js); a Connection is single-use.

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { NoiseHandshake } = require('./noise');
const {
  MSG, Writer, parseHelloResponse, parseDeviceInfo, parseListEntity, parseState,
} = require('./proto');

const API_VERSION = { major: 1, minor: 14 };
const STEP_TIMEOUT_MS = 10000; // each handshake/request step
const PING_INTERVAL_MS = 20000;
const IDLE_TIMEOUT_MS = 60000; // no bytes for this long = dead link
const MAX_FRAME = 65535 + 3; // a Noise frame length is 16-bit
const MAX_BUFFER = 4 * MAX_FRAME; // receive buffer cap; more means a broken peer

const LIST_TYPES = new Set([
  MSG.LIST_BINARY_SENSOR, MSG.LIST_SENSOR, MSG.LIST_SWITCH, MSG.LIST_TEXT_SENSOR, MSG.LIST_CLIMATE, MSG.LIST_BUTTON,
]);
const STATE_TYPES = new Set([
  MSG.SENSOR_STATE, MSG.BINARY_SENSOR_STATE, MSG.SWITCH_STATE, MSG.TEXT_SENSOR_STATE, MSG.CLIMATE_STATE,
]);

class ConnectionError extends Error {

  constructor(message, code) {
    super(message);
    this.code = code; // 'timeout' | 'refused' | 'bad_key' | 'no_encryption' | 'closed' | 'protocol'
  }

}

class Connection extends EventEmitter {

  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port=6053]
   * @param {string} opts.key  base64 API encryption key
   * @param {string} [opts.clientInfo]
   */
  constructor({
    host, port = 6053, key, clientInfo = 'Homey',
  }) {
    super();
    this.host = host;
    this.port = port;
    this.psk = Buffer.from(String(key || '').trim(), 'base64');
    this.clientInfo = clientInfo;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.phase = 'idle'; // idle | hello | handshake | open | closed
    this.waiter = null; // { types:Set, resolve, reject, timer } for request/response steps
    this.entities = [];
    this.deviceInfo = null;
    this.lastRx = 0;
    this.pingTimer = null;
  }

  /** Connects, runs the handshake, reads device info and entities, and subscribes to states. */
  async connect() {
    if (this.psk.length !== 32) throw new ConnectionError('Invalid encryption key', 'bad_key');
    await this.openSocket();
    await this.handshake();
    const hello = parseHelloResponse(await this.request(MSG.HELLO_REQUEST, new Writer()
      .string(1, this.clientInfo).varint(2, API_VERSION.major).varint(3, API_VERSION.minor)
      .toBuffer(), [MSG.HELLO_RESPONSE]));
    this.apiVersion = hello;
    this.deviceInfo = parseDeviceInfo(await this.request(MSG.DEVICE_INFO_REQUEST, Buffer.alloc(0), [MSG.DEVICE_INFO_RESPONSE]));
    this.entities = await this.listEntities();
    this.send(MSG.SUBSCRIBE_STATES_REQUEST, Buffer.alloc(0));
    this.pingTimer = setInterval(() => this.keepAlive(), PING_INTERVAL_MS);
    return this.deviceInfo;
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setNoDelay(true);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ConnectionError(`No answer from ${this.host}`, 'timeout'));
      }, STEP_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timer);
        this.lastRx = Date.now();
        resolve();
      });
      socket.on('error', (err) => {
        clearTimeout(timer);
        const code = err.code === 'ECONNREFUSED' ? 'refused' : 'closed';
        const error = new ConnectionError(err.message, code);
        if (this.phase === 'idle') reject(error);
        else this.fail(error);
      });
      socket.on('close', () => this.fail(new ConnectionError('Connection closed', 'closed')));
      socket.on('data', (chunk) => this.onData(chunk));
    });
  }

  // ---------- handshake ----------

  async handshake() {
    this.phase = 'handshake';
    const hs = new NoiseHandshake(this.psk);
    this.writeFrame(Buffer.alloc(0)); // client hello
    const serverHello = await this.nextFrame();
    if (serverHello[0] !== 0x01) throw new ConnectionError('Unsupported encryption protocol', 'protocol');
    this.writeFrame(Buffer.concat([Buffer.from([0]), hs.writeMessage()]));
    const reply = await this.nextFrame();
    if (reply.length === 0 || reply[0] !== 0) {
      throw new ConnectionError('The device rejected the encryption key', 'bad_key');
    }
    try {
      hs.readMessage(reply.subarray(1));
    } catch (err) {
      throw new ConnectionError('The encryption key does not match', 'bad_key');
    }
    ({ send: this.tx, receive: this.rx } = hs.split());
    this.psk = null;
    this.phase = 'open';
  }

  /** Waits for the next raw handshake frame. */
  nextFrame() {
    return this.wait(new Set(['frame']));
  }

  // ---------- framing ----------

  writeFrame(payload) {
    const header = Buffer.from([0x01, payload.length >> 8, payload.length & 0xff]);
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(type, payload) {
    if (this.phase !== 'open' || !this.socket) return;
    const plain = Buffer.alloc(4 + payload.length);
    plain.writeUInt16BE(type, 0);
    plain.writeUInt16BE(payload.length, 2);
    payload.copy(plain, 4);
    this.writeFrame(this.tx.encrypt(plain));
  }

  onData(chunk) {
    this.lastRx = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > MAX_BUFFER) {
      this.fail(new ConnectionError('Receive buffer overflow', 'protocol'));
      return;
    }
    while (this.buffer.length >= 3) {
      if (this.buffer[0] !== 0x01) {
        const code = this.buffer[0] === 0x00 ? 'no_encryption' : 'protocol';
        this.fail(new ConnectionError('The device does not use API encryption', code));
        return;
      }
      const len = this.buffer.readUInt16BE(1);
      if (this.buffer.length < 3 + len) return;
      const frame = Buffer.from(this.buffer.subarray(3, 3 + len)); // copy: the buffer is reused
      this.buffer = this.buffer.subarray(3 + len);
      try {
        this.onFrame(frame);
      } catch (err) {
        this.fail(err instanceof ConnectionError ? err : new ConnectionError(err.message, 'protocol'));
        return;
      }
    }
  }

  onFrame(frame) {
    if (this.phase === 'handshake') {
      this.settle('frame', frame);
      return;
    }
    if (this.phase !== 'open') return;
    const plain = this.rx.decrypt(frame);
    if (plain.length < 4) throw new ConnectionError('Short message', 'protocol');
    const type = plain.readUInt16BE(0);
    const len = plain.readUInt16BE(2);
    this.onMessage(type, plain.subarray(4, 4 + len));
  }

  onMessage(type, payload) {
    if (STATE_TYPES.has(type)) {
      const state = parseState(type, payload);
      if (state) this.emit('state', state);
      return;
    }
    switch (type) {
      case MSG.PING_REQUEST:
        this.send(MSG.PING_RESPONSE, Buffer.alloc(0));
        return;
      case MSG.GET_TIME_REQUEST:
        this.send(MSG.GET_TIME_RESPONSE, new Writer().fixed32(1, Math.floor(Date.now() / 1000)).toBuffer());
        return;
      case MSG.DISCONNECT_REQUEST:
        this.send(MSG.DISCONNECT_RESPONSE, Buffer.alloc(0));
        this.fail(new ConnectionError('The device closed the connection', 'closed'));
        return;
      default:
        this.settle(type, payload);
    }
  }

  // ---------- request / response ----------

  wait(types) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new ConnectionError(`No answer from ${this.host}`, 'timeout'));
      }, STEP_TIMEOUT_MS);
      this.waiter = {
        types, resolve, reject, timer,
      };
    });
  }

  settle(type, payload) {
    const w = this.waiter;
    if (!w || !w.types.has(type)) return; // unrequested message (e.g. log, late reply): ignore
    if (w.collect) {
      w.collect(type, payload);
      return;
    }
    clearTimeout(w.timer);
    this.waiter = null;
    w.resolve(payload);
  }

  request(type, payload, replyTypes) {
    const p = this.wait(new Set(replyTypes));
    this.send(type, payload);
    return p;
  }

  async listEntities() {
    const entities = [];
    const types = new Set([...LIST_TYPES, MSG.LIST_DONE]);
    const p = this.wait(types);
    this.waiter.collect = (type, payload) => {
      if (type !== MSG.LIST_DONE) {
        if (entities.length < 500) entities.push(parseListEntity(type, payload)); // cap: a bridge has ~25
        return;
      }
      const w = this.waiter;
      clearTimeout(w.timer);
      this.waiter = null;
      w.resolve();
    };
    this.send(MSG.LIST_ENTITIES_REQUEST, Buffer.alloc(0));
    await p;
    return entities;
  }

  keepAlive() {
    if (Date.now() - this.lastRx > IDLE_TIMEOUT_MS) {
      this.fail(new ConnectionError('Connection timed out', 'timeout'));
      return;
    }
    this.send(MSG.PING_REQUEST, Buffer.alloc(0));
  }

  // ---------- commands ----------

  /**
   * @param {number} key
   * @param {number} deviceId
   * @param {object} c  any of: mode, targetTemperature, fanMode, customFanMode, swingMode, preset, customPreset
   */
  climateCommand(key, deviceId, c) {
    const w = new Writer().fixed32(1, key);
    if (c.mode !== undefined) w.bool(2, true).varint(3, c.mode);
    if (c.targetTemperature !== undefined) w.bool(4, true).float(5, c.targetTemperature);
    if (c.fanMode !== undefined) w.bool(12, true).varint(13, c.fanMode);
    if (c.swingMode !== undefined) w.bool(14, true).varint(15, c.swingMode);
    if (c.customFanMode !== undefined) w.bool(16, true).string(17, c.customFanMode);
    if (c.preset !== undefined) w.bool(18, true).varint(19, c.preset);
    if (c.customPreset !== undefined) w.bool(20, true).string(21, c.customPreset);
    w.varint(24, deviceId);
    this.send(MSG.CLIMATE_COMMAND, w.toBuffer());
  }

  switchCommand(key, deviceId, state) {
    this.send(MSG.SWITCH_COMMAND, new Writer().fixed32(1, key).bool(2, state).varint(3, deviceId)
      .toBuffer());
  }

  buttonPress(key, deviceId) {
    this.send(MSG.BUTTON_COMMAND, new Writer().fixed32(1, key).varint(2, deviceId).toBuffer());
  }

  get isOpen() {
    return this.phase === 'open';
  }

  // ---------- teardown ----------

  fail(err) {
    if (this.phase === 'closed') return;
    const wasOpen = this.phase === 'open';
    this.phase = 'closed';
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(err);
      this.waiter = null;
    }
    this.cleanup();
    if (wasOpen) this.emit('close', err);
  }

  close() {
    if (this.phase === 'open') {
      try {
        this.send(MSG.DISCONNECT_REQUEST, Buffer.alloc(0));
      } catch (_) { /* closing anyway */ }
    }
    this.fail(new ConnectionError('Closed by the app', 'closed'));
  }

  cleanup() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.socket) {
      this.socket.removeAllListeners('data');
      this.socket.on('error', () => {}); // late errors after teardown
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
    this.buffer = Buffer.alloc(0);
    this.tx = null;
    this.rx = null;
  }

}

module.exports = { Connection, ConnectionError };

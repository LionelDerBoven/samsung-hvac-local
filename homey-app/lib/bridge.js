'use strict';

// One shared, self-healing connection per bridge (ESPHome node). Every Homey device of that
// bridge listens to it, so a multi-split with N indoor units still uses a single TCP socket.

const { EventEmitter } = require('node:events');
const { Connection } = require('./esphome/connection');
const { groupUnits, isBridge, CONTRACT_MAJOR } = require('./contract');

const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 5 * 60 * 1000;

class Bridge extends EventEmitter {

  /**
   * @param {object} opts { host, port, key, homey }
   */
  constructor({
    host, port, key, homey,
  }) {
    super();
    this.setMaxListeners(50); // one listener set per device; a bridge has a handful of units
    this.host = host;
    this.port = port || 6053;
    this.key = key;
    this.homey = homey;
    this.conn = null;
    this.units = null; // { indoor, outdoor, bridge } from contract.groupUnits
    this.states = new Map(); // entity key → last value; bounded by the bridge's entity list (~25)
    this.online = false;
    this.lastError = null;
    this.users = 0;
    this.retryMs = RETRY_MIN_MS;
    this.retryTimer = null;
    this.stopped = false;
  }

  retain() {
    this.users++;
    if (this.users === 1) {
      this.stopped = false;
      this.start().catch(() => {}); // start() handles its own errors
    }
  }

  /** @returns {boolean} true when nobody uses the bridge any more (it is then stopped). */
  release() {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0) return false;
    this.stop();
    return true;
  }

  async start() {
    if (this.stopped || this.conn) return;
    const conn = new Connection({
      host: this.host, port: this.port, key: this.key, clientInfo: `Homey ${this.homey.manifest.id}`,
    });
    this.conn = conn;
    try {
      const info = await conn.connect();
      if (this.stopped || this.conn !== conn) {
        conn.close();
        return;
      }
      if (!isBridge(info)) throw Object.assign(new Error('Not a Samsung HVAC Local bridge'), { code: 'not_bridge' });
      this.info = { mac: info.mac, name: info.friendlyName || info.name, version: info.projectVersion };
      this.units = groupUnits(info, conn.entities);
      conn.on('state', (s) => this.onState(s));
      conn.once('close', (err) => this.onClose(conn, err));
      this.retryMs = RETRY_MIN_MS;
      this.setOnline(true, null);
    } catch (err) {
      conn.removeAllListeners();
      conn.close();
      if (this.conn !== conn) return; // replaced by setHost()/reconnect(): that attempt reports instead
      this.conn = null;
      this.setOnline(false, err);
      this.scheduleRetry();
    }
  }

  onState({ key, value }) {
    this.states.set(key, value);
    this.emit('state', key, value);
    const contract = this.units && this.units.bridge.roles.contract;
    if (contract && key === contract.key && value && !String(value).startsWith(CONTRACT_MAJOR)) {
      this.emit('contract-mismatch', value);
    }
  }

  onClose(conn, err) {
    if (this.conn !== conn) return;
    conn.removeAllListeners();
    this.conn = null;
    this.setOnline(false, err);
    this.scheduleRetry();
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = this.homey.setTimeout(() => {
      this.retryTimer = null;
      this.start().catch(() => {});
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  setOnline(online, err) {
    this.lastError = err || null;
    if (this.online === online && online) return;
    this.online = online;
    this.emit('status', online, err);
  }

  /** New address (e.g. from mDNS after a DHCP change): reconnect there. */
  setHost(host) {
    if (!host || host === this.host) return;
    this.host = host;
    this.reconnect();
  }

  reconnect() {
    if (this.retryTimer) this.homey.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryMs = RETRY_MIN_MS;
    const { conn } = this;
    this.conn = null;
    if (conn) {
      conn.removeAllListeners();
      conn.close();
    }
    this.start().catch(() => {});
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) this.homey.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.conn) {
      this.conn.removeAllListeners();
      this.conn.close();
      this.conn = null;
    }
    this.states.clear();
    this.online = false;
  }

  // ---------- helpers for devices ----------

  indoorUnit(deviceId) {
    return this.units ? this.units.indoor.find((u) => u.deviceId === deviceId) || null : null;
  }

  get outdoorUnit() {
    return this.units ? this.units.outdoor : null;
  }

  get isSingleSplit() {
    return !!this.units && this.units.indoor.length === 1;
  }

  value(entity) {
    return entity ? this.states.get(entity.key) : undefined;
  }

  climateCommand(entity, fields) {
    if (!this.conn || !this.conn.isOpen) throw Object.assign(new Error('offline'), { code: 'offline' });
    this.conn.climateCommand(entity.key, entity.deviceId, fields);
  }

  switchCommand(entity, state) {
    if (!this.conn || !this.conn.isOpen) throw Object.assign(new Error('offline'), { code: 'offline' });
    this.conn.switchCommand(entity.key, entity.deviceId, state);
  }

  press(entity) {
    if (!this.conn || !this.conn.isOpen) throw Object.assign(new Error('offline'), { code: 'offline' });
    this.conn.buttonPress(entity.key, entity.deviceId);
  }

}

module.exports = { Bridge };

'use strict';

const Homey = require('homey');
const { Connection } = require('../../lib/esphome/connection');
const { groupUnits, isBridge } = require('../../lib/contract');

const normaliseMac = (mac) => String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();

class IndoorUnitDriver extends Homey.Driver {

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
        return true;
      } catch (err) {
        throw new Error(this.describeError(err));
      } finally {
        conn.close();
      }
    });

    session.setHandler('list_devices', async () => {
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

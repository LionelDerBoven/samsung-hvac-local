'use strict';

const Homey = require('homey');
const { Bridge } = require('./lib/bridge');
const { PROJECT_NAME } = require('./lib/contract');

function normaliseMac(mac) {
  return String(mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
}

/**
 * Keeps one shared Bridge per ESPHome node (keyed by MAC address) and follows address
 * changes announced over mDNS.
 */
class SamsungHvacLocalApp extends Homey.App {

  async onInit() {
    this.bridges = new Map(); // mac → Bridge; one entry per paired bridge
    this.discovery = this.homey.discovery.getStrategy('esphome');
    this.discovery.on('result', (r) => this.onDiscoveryResult(r));
    this.discovery.on('addressChanged', (r) => this.onDiscoveryResult(r));
  }

  /** Bridges announced on the network that follow the contract: [{ name, host, port, mac }]. */
  discoveredBridges() {
    const results = Object.values(this.discovery.getDiscoveryResults());
    const bridges = results.filter((r) => r.txt && r.txt.project_name === PROJECT_NAME);
    this.log(`Discovery: ${results.length} ESPHome node(s), ${bridges.length} HVAC Local bridge(s)`);
    return bridges
      .map((r) => ({
        name: r.txt.friendly_name || r.name || r.host,
        host: r.address,
        port: r.port || 6053,
        mac: normaliseMac(r.txt.mac),
      }));
  }

  onDiscoveryResult(r) {
    if (!r || !r.txt || r.txt.project_name !== PROJECT_NAME || !r.address) return;
    const id = normaliseMac(r.txt.mac);
    const bridge = this.bridges.get(id);
    if (bridge && r.address !== bridge.host) {
      this.log('Bridge moved to a new address, reconnecting');
      bridge.setHost(r.address);
      this.rememberHost(id, r.address);
    }
  }

  /** Current address of a bridge as announced over mDNS, or null. */
  announcedHost(id) {
    const found = Object.values(this.discovery.getDiscoveryResults())
      .find((r) => r.txt && r.txt.project_name === PROJECT_NAME && normaliseMac(r.txt.mac) === id);
    return (found && found.address) || null;
  }

  /** Stores a new bridge address on its devices, so it survives a restart. */
  rememberHost(id, host) {
    for (const device of this.homey.drivers.getDriver('indoor-unit').getDevices()) {
      if (normaliseMac(device.getStoreValue('mac')) === id && device.getStoreValue('host') !== host) {
        device.setStoreValue('host', host).catch(this.error);
      }
    }
  }

  /** Returns the shared Bridge for a device's store and retains it. */
  getBridge({
    mac, host, port, key,
  }) {
    const id = normaliseMac(mac);
    // mDNS wins over the stored address: the bridge may have moved while Homey was off.
    const address = this.announcedHost(id) || host;
    if (address !== host) this.rememberHost(id, address);
    let bridge = this.bridges.get(id);
    if (!bridge) {
      bridge = new Bridge({
        host: address, port, key, homey: this.homey,
      });
      this.bridges.set(id, bridge);
    } else if (address !== bridge.host) {
      bridge.setHost(address);
    }
    bridge.retain();
    return bridge;
  }

  releaseBridge(mac) {
    const id = normaliseMac(mac);
    const bridge = this.bridges.get(id);
    if (bridge && bridge.release()) this.bridges.delete(id);
  }

  async onUninit() {
    for (const bridge of this.bridges.values()) bridge.stop();
    this.bridges.clear();
  }

}

SamsungHvacLocalApp.normaliseMac = normaliseMac;
module.exports = SamsungHvacLocalApp;

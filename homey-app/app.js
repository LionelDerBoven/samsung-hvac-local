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
    return Object.values(this.discovery.getDiscoveryResults())
      .filter((r) => r.txt && r.txt.project_name === PROJECT_NAME)
      .map((r) => ({
        name: r.txt.friendly_name || r.name || r.host,
        host: r.address,
        port: r.port || 6053,
        mac: normaliseMac(r.txt.mac),
      }));
  }

  onDiscoveryResult(r) {
    if (!r || !r.txt || r.txt.project_name !== PROJECT_NAME) return;
    const bridge = this.bridges.get(normaliseMac(r.txt.mac));
    if (bridge && r.address && r.address !== bridge.host) {
      this.log('Bridge moved to a new address, reconnecting');
      bridge.setHost(r.address);
    }
  }

  /** Returns the shared Bridge for a device's store and retains it. */
  getBridge({
    mac, host, port, key,
  }) {
    const id = normaliseMac(mac);
    let bridge = this.bridges.get(id);
    if (!bridge) {
      bridge = new Bridge({
        host, port, key, homey: this.homey,
      });
      this.bridges.set(id, bridge);
    } else if (host && host !== bridge.host) {
      bridge.setHost(host);
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

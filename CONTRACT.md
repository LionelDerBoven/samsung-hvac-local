# Bridge contract (v1)

The contract is the fixed agreement between a **bridge** (an ESPHome node built from the
`esphome/` packages) and a **client** (the Samsung HVAC Local Homey app, or anything else
that speaks the ESPHome native API). A client that follows this document works with every
bridge that follows it, whatever board, unit names or language the owner chose.

## 1. Recognising a bridge

| Where | Value |
|-------|-------|
| `DeviceInfo.project_name` | `ldbtechnology.samsung_hvac_local` |
| `DeviceInfo.project_version` | bridge version (SemVer) |
| text sensor `Contract` (main device) | contract version, `"1"` |

Discovery: mDNS service `_esphomelib._tcp`; the TXT record `project_name` carries the same
value, so a client can filter before connecting.

A client must refuse (or offer manual mapping for) a contract major version it does not know.

## 2. Grouping: units are sub-devices

Every Samsung unit is an ESPHome **sub-device** (`DeviceInfo.devices`). Each entity carries the
`device_id` of the unit it belongs to. Bridge-level entities use `device_id` 0 (the main device).

| Unit kind | How to recognise it |
|-----------|---------------------|
| Indoor unit | the sub-device has a `climate` entity named `Climate` |
| Outdoor unit | the sub-device has a `sensor` named `Outdoor temperature` |

Sub-device names are chosen by the owner (e.g. "Living", "Outdoor unit") and are only used as
display names. A bridge has one outdoor unit and one or more indoor units (multi-split).

## 3. Entities

Clients match on **domain + entity name** inside a sub-device (equivalently domain +
`object_id`). Names are English and fixed; owners rename entities in their home-automation
system, not in the bridge. Every entity is optional: a client hides what is missing.

### Indoor unit

| Domain | Name (`object_id`) | Unit | Meaning |
|--------|--------------------|------|---------|
| climate | `Climate` (`climate`) | °C | Power, mode, target and current temperature, fan mode, swing, preset. Supported values are in the entity traits. |
| sensor | `Room temperature` (`room_temperature`) | °C | Room temperature at the indoor unit |
| sensor | `Room humidity` (`room_humidity`) | % | Relative humidity |
| sensor | `EVA in temperature` (`eva_in_temperature`) | °C | Evaporator inlet (diagnostic) |
| sensor | `EVA out temperature` (`eva_out_temperature`) | °C | Evaporator outlet (diagnostic) |
| sensor | `Filter usage` (`filter_usage`) | % | Filter usage, 100 % = clean the filter |
| sensor | `Filter hours` (`filter_hours`) | h | Hours since the last filter reset (NASA 0x4222) |
| sensor | `Filter capacity` (`filter_capacity`) | h | Hours until a cleaning is due (NASA 0x42E5) |
| binary_sensor | `Filter alarm` (`filter_alarm`) | | On = the unit asks for a filter cleaning (NASA 0x4027) |
| button | `Filter reset` (`filter_reset`) | | Resets the filter counter (NASA 0x4025) |
| switch | `Auto clean` (`auto_clean`) | | Automatic cleaning after cooling |

**Climate values**:
- Modes: `OFF`, `COOL`, `HEAT`, `DRY`, `FAN_ONLY`, `AUTO`.
- Fan modes: `AUTO`, `LOW`, `MIDDLE`, `HIGH`, plus the custom fan mode `Turbo`.
- Swing: `OFF`, `VERTICAL`, `HORIZONTAL`, `BOTH`.
- Presets: `NONE`, `ECO`, `SLEEP`, plus the custom presets `Quiet`, `Fast`, `LongReach`, `WindFree`.

Each bridge only advertises what the owner enabled, through the `cap_*` substitutions.

Behaviour of the unit itself, so clients can explain it:
- WindFree only works in COOL or DRY.
- Quiet and Fast depend on the mode.

### Outdoor unit

| Domain | Name (`object_id`) | Unit | Meaning |
|--------|--------------------|------|---------|
| sensor | `Outdoor temperature` (`outdoor_temperature`) | °C | Outside air temperature |
| sensor | `Power` (`power`) | W | Instantaneous power of the outdoor unit |
| sensor | `Energy` (`energy`) | kWh | **Cumulative** energy of the outdoor unit, counted by the AC itself (survives bridge restarts). Matches the Samsung app's value. |
| sensor | `Error code` (`error_code`) | | 0 = no error, otherwise the Samsung error code |

Power and energy cover the outdoor unit. On a multi-split they are the total for all indoor
units, so clients should show them on the outdoor unit, not divide them over indoor units.

### Bridge (main device, `device_id` 0)

| Domain | Name | Meaning |
|--------|------|---------|
| text_sensor | `Contract` | Contract version (`"1"`) |
| binary_sensor | `Bus active` | AC data seen in the last 5 minutes. **Off is normal in deep standby**: the AC stops talking on the bus some time after it is switched off. |
| sensor | `WiFi signal`, `Uptime` | Diagnostics |
| text_sensor | `IP address`, `MAC address` | Diagnostics |
| button | `Restart` | Restarts the bridge (the AC keeps running) |

## 4. Versioning

- Adding an entity or a value: **minor** change, the contract stays `1`.
- Renaming or removing an entity, or changing a unit or the meaning of a value: **major** change.
  The contract becomes `2`, and clients must handle both during a transition.

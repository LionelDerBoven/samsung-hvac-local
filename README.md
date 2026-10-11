# Samsung HVAC Local

**Local control of Samsung air conditioners over the F1/F2 bus: an ESPHome bridge plus a Homey app.**

No cloud and no Samsung account in the loop. A small ESP32 board on the indoor unit's
F1/F2 bus speaks Samsung's NASA protocol. Home Assistant and Homey control it through the
encrypted ESPHome API. The Samsung app (SmartThings) keeps working next to it.

> Unofficial community project, not affiliated with or endorsed by Samsung.

## What you get

| Part | What it does |
|------|--------------|
| `esphome/`: bridge packages | Climate control: power, all modes, target temperature, fan incl. Turbo, swing, WindFree/Quiet/Fast/LongReach/Eco/Sleep. Room, outdoor and evaporator temperatures, humidity, outdoor power and cumulative energy, filter usage and reset, error code. Optional offline web UI (English, Dutch, French; light/dark theme) with a live log. |
| `homey-app/`: Homey app *(beta)* | One Homey device per indoor unit with all of the above, energy in Homey Energy, flow cards. |
| [`CONTRACT.md`](CONTRACT.md) | The fixed bridge ↔ client agreement (entity names, grouping, versions). |

## Usage

1. **Hardware**: an ESP32 with an RS485 transceiver, e.g. M5Stack ATOM Lite + ATOMIC RS485 Base.
   - Connect **F1 → A** and **F2 → B** on the indoor unit's terminal block.
   - Power the board from 6/12–24 V DC.
   - ⚠️ The terminal block also carries mains voltage (L/N). Switch off the breaker before working on it.
2. **Firmware**: copy [`esphome/example.yaml`](esphome/example.yaml) and
   [`esphome/secrets.yaml.example`](esphome/secrets.yaml.example). Set the unit addresses and names,
   then flash it with ESPHome (USB the first time, over the air after that).
3. **Find the addresses**: indoor units are usually `20.00.00`, `20.00.01`, … and the outdoor unit
   is `10.00.00`. The bridge logs list every address it discovers.
4. **Connect**: add the bridge in Home Assistant (ESPHome integration) or in Homey (Samsung HVAC Local app).

| Your setup | Packages |
|------------|----------|
| Single split | bridge + board + 1× `units/indoor.yaml` + `units/outdoor.yaml` |
| Multi-split | bridge + board + 1× `units/indoor.yaml` **per indoor unit** + `units/outdoor.yaml` |
| Model without a feature (e.g. no WindFree) | set `cap_windfree: "false"` (see the `cap_*` substitutions) |
| Half-degree target temperature | set `target_step: "0.5"` (the AC accepts it; the Samsung app and remote show whole degrees) |

## Limits

- **NASA protocol only** (Samsung units from roughly 2017 onwards). Older non-NASA units are
  supported by the underlying component, but this project does not test or package them yet.
  Open an issue if you need it.
- **Deep standby**: some time after the AC is switched off, it stops talking on the bus. The
  bridge then shows no fresh data (`Bus active` off, status LED orange) until the AC wakes up.
- **Energy** is measured by the outdoor unit, so it does not include the indoor unit's fan.
  On a multi-split it is the total for all indoor units.
- **No beep or display-light control**: these settings are not exposed on the F1/F2 bus.

## Development

```bash
# validate / build with the pinned ESPHome container
podman run --rm -v "$PWD":/config ghcr.io/esphome/esphome:2026.9.1 config esphome/example.yaml
```

- `esphome/samsung-hvac-bridge.yaml`: core (bus component, contract, diagnostics)
- `esphome/units/`: indoor and outdoor unit packages; `esphome/boards/`: hardware packages
- `esphome/extras/web/app.js`: the optional web UI

Built on [esphome_samsung_hvac_bus](https://github.com/omerfaruk-aran/esphome_samsung_hvac_bus).

## Credits

Built by LDB Technology, with [Claude](https://claude.com/claude-code) (Anthropic) as co-author.

## License

[GPL-3.0-or-later](LICENSE)

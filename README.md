# homebridge-xiaomi-powerstrip-km81

Homebridge plugin for controlling **Xiaomi Power Strip / Smart Plug** devices through HomeKit.  
This plugin automatically detects whether the device uses the modern **MIoT protocol** or the legacy **miIO protocol**, 
and adjusts communication accordingly.

## ✨ Features

- Control Xiaomi Power Strip / Plug as a **single unified switch** in HomeKit
- Auto-detects between MIoT (`get_properties`/`set_properties`) and legacy miIO (`get_prop` / `set_power`)
- Polling interval configurable (default 15s, min 3s)
- Optimistic updates (avoid "switch bouncing back" when toggling)
- Debug logging option to troubleshoot unsupported methods
- Optional **device model hint** to improve detection (e.g., `zimi.powerstrip.v2`, `chuangmi.plug.v3`)

## 🔧 Installation

```bash
npm install -g homebridge-xiaomi-powerstrip-km81
```

or install through Homebridge UI by searching for `homebridge-xiaomi-powerstrip-km81`.

## ⚙️ Configuration

Example `config.json`:

```json
{
  "platforms": [
    {
      "platform": "XiaomiPowerStripPlatform",
      "deviceCfgs": [
        {
          "name": "Living Room Power",
          "ip": "192.168.1.55",
          "token": "YOUR32CHARTOKENHEXHERE",
          "serialNumber": "123456789",
          "pollingInterval": 15000,
          "model": "zimi.powerstrip.v2",
          "protocolMode": "auto",
          "debug": false
        }
      ]
    }
  ]
}
```

### Config Options

| Key             | Type    | Default   | Description |
|-----------------|---------|-----------|-------------|
| `name`          | string  | `"Xiaomi Power Strip"` | Accessory name shown in HomeKit |
| `ip`            | string  | required  | Device IP address |
| `token`         | string  | required  | 32-char HEX token (extract via `miio` or other tools) |
| `serialNumber`  | string  | optional  | Serial number shown in Home app |
| `pollingInterval` | int   | 15000     | Polling interval in ms (min 3000) |
| `model`         | string  | optional  | Device model hint (e.g., `chuangmi.plug.v3`) |
| `protocolMode`  | enum    | `auto`    | `auto`, `miot`, or `legacy` |
| `debug`         | boolean | false     | Enable debug logging |

## 🛠 Troubleshooting

- If HomeKit toggles but state resets to off → set `protocolMode` to `legacy` and enable `debug`.  
  Check logs to see which property key (`power`, `relay_status`, etc.) reports the correct state.
- Provide `model` if detection fails.

## 📌 Notes

- This plugin is optimized for **single-switch Xiaomi Power Strips / Plugs**.  
- Multi-outlet devices (6 sockets, etc.) are treated as **one unified switch**, not per-outlet control.  
- LED control / temperature sensors are not exposed in this simplified version.

## 📜 License

MIT © Km81

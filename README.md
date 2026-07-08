<div align="center">

# CANvas Studios

**A browser-based CAN database editor and live trace tool — no installs, no drivers, no fees.**

Edit DBC files, replay logs, and read live CAN traffic — all from a single HTML page. Everything runs client-side in your browser, and every feature works offline once the page has loaded.

**[Live app →](https://sxurxbhgit.github.io/CANvas-Studios/)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Stack](https://img.shields.io/badge/stack-vanilla_HTML_%2B_JS-yellow)
![Runs](https://img.shields.io/badge/runs-anywhere-brightgreen)

</div>

---

## What it does

CANvas Studios started as a web replacement for Vector CANdb++, and grew into a full engineering-workbench for CAN work:

### 🗄 Database editor
- Full DBC parser and editor (messages, signals, nodes, comments, value tables, multiplexing, attributes)
- Bit-matrix layout view with correct Intel/Motorola endianness and LSB/MSB indicators
- Live validation engine (bit overlaps, DLC overflow, duplicate IDs, malformed lines, and more)
- Attribute engine with the five standard Vector attributes pre-seeded (`GenMsgCycleTime`, `GenMsgSendType`, `GenSigSendType`, `GenSigStartValue`, `GenSigInactiveValue`)
- Load 15–20 DBC files at once — the trace tool decodes across all of them, active database wins on ID collisions

### 📐 MATLAB export
- Generates Ecotron-style `.m` files, byte-for-byte compatible with the golden format (multiplexing, cycle times, independent container all handled)

### 📡 Live trace tool (CANKing-style)
- Fixed-position and scrolling modes
- Live signal decoding — click any known frame to expand its decoded signals with physical values, units, raw values, and enum text
- Multi-DBC decoding across all loaded files
- Transmit panel with cyclic TX driven by `GenMsgCycleTime` and `GenSigStartValue`

**Four live sources — pick what your hardware supports:**

| Source | How | Works on |
|---|---|---|
| **Kvaser Leaf Light v2** | Python-can WebSocket bridge (`kvaser_bridge.py`) | Windows / Linux |
| **Serial** (host device) | Web Serial API — direct browser access | Chrome / Edge, all OS incl. macOS |
| **WiFi device** | WebSocket to an ESP32 (or similar) | Any OS, any browser |
| **Replay** | `.asc`, `.trc`, candump `.log`, or Kvaser Memorator `.csv` | Any OS, any browser |

### 📈 Signal plotter
- Multi-signal time-series plotting from any messages across any loaded DBCs
- Common-Y or per-signal normalized modes, rolling time windows (5 s → all)
- Feeds from live or replay identically
- Kvaser CSV logs display their "Logging started at" timestamp

---

## Try it in 30 seconds

1. Open **[the live app](https://sxurxbhgit.github.io/CANvas-Studios/)**
2. Click **Open DBC** and load any `.dbc` file
3. Switch to the **📡 Trace** view → Source: *Replay — Log file* → pick a `.asc`, `.log`, `.trc`, or Kvaser `.csv` and press **Play**
4. Click any decoded row to expand its signals
5. Hit **📈 Plotter** to graph signals as they stream

---

## For live CAN with your own hardware

### ESP32 over WiFi (easiest — any OS)
Flash the included [`esp32_can_wifi_bridge.ino`](esp32_can_wifi_bridge.ino) sketch to any ESP32 with a CAN transceiver (SN65HVD230 recommended). Connect to the AP it broadcasts, then in the trace tool point WiFi to `ws://192.168.4.1:81`. Text and JSON output formats both supported.

### Serial (USB adapter, Arduino, Bluetooth SPP)
Any host device that emits CAN frames as delimited text lines. Set the field order in the UI — `id` and `data` are required, everything else optional. Works with Web Serial in Chrome / Edge.

### Kvaser Leaf Light v2
```bash
pip install python-can canlib websockets
python kvaser_bridge.py
```
Then Connect in the trace tool. See `kvaser_bridge.py` for options.

---

## Project structure

```
index.html            The whole app
candb_plotter.js      Signal plotter
candb_serial.js       Web Serial live source
candb_wifi.js         WebSocket live source (WiFi devices)
kvaser_bridge.py      Optional: Kvaser Leaf Light v2 bridge
esp32_can_wifi_bridge.ino    Optional: ESP32 firmware
```

No build step. No dependencies. Drop the files on any static host, or open `index.html` directly.

---

## Contributing

Issues and pull requests welcome — especially bug reports with a sample DBC or log file attached.

## License

[MIT](LICENSE) — use it, fork it, ship it in your product. Attribution appreciated but not required.

#!/usr/bin/env python3
"""
kvaser_bridge.py — Kvaser Leaf Light v2 <-> WebSocket bridge for CANvas Studios

    *** WINDOWS ONLY ***

This bridge talks to the Kvaser Leaf Light v2 through python-can's "kvaser"
interface, which drives canlib32.dll from the Kvaser CANlib SDK. That SDK
only ships Windows drivers, so this script cannot run on macOS or Linux.
If you're not on Windows, use one of the other trace-tool sources instead:

    Source                          OS support
    -------------------------------  ---------------------------------
    Kvaser Leaf Light v2 (this file) Windows ONLY
    Serial (host device)             Chrome/Edge, any OS incl. macOS
                                      (needs Web Serial API support)
    WiFi device (WebSocket)          Any OS, any browser
    Replay (log file)                Any OS, any browser

Setup (Windows):
    1. Install the Kvaser CANlib SDK / drivers so the Leaf Light v2 shows up
       as a CAN channel:  https://www.kvaser.com/downloads/
    2. pip install python-can websockets
    3. python kvaser_bridge.py
    4. In the trace tool: Source -> "Live — Kvaser via WebSocket (Windows only)",
       set the WebSocket URL to ws://localhost:8765 (default), then Connect.

Options:
    python kvaser_bridge.py --host localhost --port 8765

Wire protocol (must match index.html's trToggleConnect / ws.onmessage):
    Client -> bridge, sent once right after the socket opens:
        {"cmd": "config", "bitrate": 500000, "channel": 0, "silent": false}
    Client -> bridge, to transmit a frame:
        {"cmd": "tx", "id": 291, "ext": false, "dlc": 8, "data": [1,2,3,4,5,6,7,8]}

    Bridge -> client, once the channel is open:
        {"type": "status", "channel": 0, "bitrate": 500000, "silent": false}
    Bridge -> client, for every frame seen on the bus (rx) or sent (tx):
        {"type": "frame", "t": 12.345, "id": 291, "ext": false, "dlc": 8,
         "data": [1,2,3,4,5,6,7,8], "dir": "rx"}
    Bridge -> client, on any failure:
        {"type": "error", "message": "..."}

Only one trace-tool connection is served at a time (a Leaf Light v2 is a
single physical channel) — a second simultaneous client is rejected with an
error message.
"""

import argparse
import asyncio
import json
import platform
import sys
import threading

if platform.system() != "Windows":
    print(
        "kvaser_bridge.py requires the Kvaser CANlib SDK, which only ships Windows\n"
        "drivers (canlib32.dll). You're running on {}.\n\n"
        "Use the WiFi or Serial live source instead — both work on any OS.\n"
        "See README.md for the full source / OS compatibility table.".format(platform.system())
    )
    sys.exit(0)

try:
    import can
except ImportError:
    sys.exit("Missing dependency. Run: pip install python-can websockets")

try:
    import websockets
except ImportError:
    sys.exit("Missing dependency. Run: pip install python-can websockets")

try:
    from can.interfaces.kvaser.canlib import Driver
except ImportError:
    Driver = None  # driver_mode (silent/normal) just won't be set


class KvaserBridge:
    def __init__(self):
        self.bus = None
        self.rx_thread = None
        self.rx_stop = threading.Event()
        self.loop = None
        self.websocket = None
        self.serving = threading.Lock()

    def open_bus(self, channel, bitrate, silent):
        kwargs = dict(interface="kvaser", channel=channel, bitrate=bitrate,
                      receive_own_messages=False)
        if Driver is not None:
            kwargs["driver_mode"] = Driver.SILENT if silent else Driver.NORMAL
        try:
            return can.Bus(**kwargs)
        except TypeError:
            # Older/newer python-can builds may not accept driver_mode/receive_own_messages
            kwargs.pop("driver_mode", None)
            kwargs.pop("receive_own_messages", None)
            return can.Bus(**kwargs)

    def start_rx_pump(self, loop, websocket):
        self.rx_stop.clear()

        def pump():
            while not self.rx_stop.is_set():
                try:
                    msg = self.bus.recv(timeout=0.5)
                except can.CanError as e:
                    asyncio.run_coroutine_threadsafe(self.send_error(websocket, str(e)), loop)
                    continue
                if msg is None:
                    continue
                frame = {
                    "type": "frame",
                    "t": msg.timestamp,
                    "id": msg.arbitration_id,
                    "ext": bool(msg.is_extended_id),
                    "dlc": msg.dlc,
                    "data": list(msg.data),
                    "dir": "rx",  # receive_own_messages=False, so anything from bus.recv() is rx
                }
                asyncio.run_coroutine_threadsafe(self.send_json(websocket, frame), loop)

        self.rx_thread = threading.Thread(target=pump, daemon=True)
        self.rx_thread.start()

    def stop_rx_pump(self):
        self.rx_stop.set()
        if self.rx_thread is not None:
            self.rx_thread.join(timeout=1.0)
            self.rx_thread = None

    @staticmethod
    async def send_json(websocket, obj):
        try:
            await websocket.send(json.dumps(obj))
        except websockets.exceptions.ConnectionClosed:
            pass

    @staticmethod
    async def send_error(websocket, message):
        await KvaserBridge.send_json(websocket, {"type": "error", "message": message})

    async def handle_tx(self, data):
        msg = can.Message(
            arbitration_id=data["id"],
            is_extended_id=bool(data.get("ext", False)),
            dlc=data.get("dlc", len(data.get("data", []))),
            data=bytearray(data.get("data", [])),
        )
        self.bus.send(msg)
        await self.send_json(self.websocket, {
            "type": "frame",
            "t": msg.timestamp or 0.0,
            "id": msg.arbitration_id,
            "ext": bool(msg.is_extended_id),
            "dlc": msg.dlc,
            "data": list(msg.data),
            "dir": "tx",
        })

    async def handler(self, websocket):
        if not self.serving.acquire(blocking=False):
            await self.send_json(websocket, {
                "type": "error",
                "message": "Kvaser bridge already serving another client — a Leaf Light v2 is a single channel.",
            })
            await websocket.close()
            return

        self.websocket = websocket
        self.loop = asyncio.get_running_loop()
        try:
            first = json.loads(await websocket.recv())
            if first.get("cmd") != "config":
                await self.send_error(websocket, "First message must be {'cmd': 'config', ...}")
                return

            channel = int(first.get("channel", 0))
            bitrate = int(first.get("bitrate", 500000))
            silent = bool(first.get("silent", False))

            try:
                self.bus = self.open_bus(channel, bitrate, silent)
            except Exception as e:
                await self.send_error(websocket, "Could not open Kvaser channel {}: {}".format(channel, e))
                return

            await self.send_json(websocket, {
                "type": "status", "channel": channel, "bitrate": bitrate, "silent": silent,
            })
            self.start_rx_pump(self.loop, websocket)

            async for raw in websocket:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if msg.get("cmd") == "tx":
                    try:
                        await self.handle_tx(msg)
                    except Exception as e:
                        await self.send_error(websocket, "TX failed: {}".format(e))
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self.stop_rx_pump()
            if self.bus is not None:
                self.bus.shutdown()
                self.bus = None
            self.websocket = None
            self.serving.release()


async def main():
    parser = argparse.ArgumentParser(description="Kvaser Leaf Light v2 <-> WebSocket bridge (Windows only)")
    parser.add_argument("--host", default="localhost", help="WebSocket host to bind (default: localhost)")
    parser.add_argument("--port", type=int, default=8765, help="WebSocket port to bind (default: 8765)")
    args = parser.parse_args()

    bridge = KvaserBridge()
    async with websockets.serve(bridge.handler, args.host, args.port):
        print("kvaser_bridge.py listening on ws://{}:{} — point the CANvas Studios trace tool at this URL.".format(
            args.host, args.port))
        print("Windows-only bridge (Kvaser CANlib SDK). Press Ctrl+C to stop.")
        await asyncio.Future()  # run forever


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

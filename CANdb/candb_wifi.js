/* =============================================================================
   candb_wifi.js — WiFi device live source for the CAN Trace tool
   Loaded by candb_web.html AFTER candb_serial.js (it reuses the serial
   module's shared parseDelimitedCanLine() and serialParseFormat()).

   A WiFi-attached CAN device (ESP32 + transceiver, Raspberry Pi, VCU with a
   WiFi module, ...) runs a small WebSocket server on the network; this module
   connects to it as a client and streams frames into the same traceOnFrame()
   pipeline as the Kvaser / Serial / Replay sources.

   Two configurable payload formats:

   1) TEXT LINES — identical format language to the Serial source: an editable
      field-order string (id,data,dt,time,dlc,dir,skip), delimiter, ID base and
      time unit. 'id' and 'data' are mandatory and validated on connect. Each
      WebSocket message may carry one line or many newline-separated lines.

   2) JSON FRAMES — each WebSocket message is a JSON object (or an array of
      objects for batching). The KEY NAMES are editable in the UI so any
      firmware's naming works, e.g. {"i":513,"d":"102700","ts":1890.5}.
      The id and data keys are mandatory; time/ext/dir keys optional.
      The data value may be an array of byte numbers or a hex string.
============================================================================= */

const WIFI = {
    connected: false,
    ws: null,
    url: 'ws://192.168.4.1:81',
    mode: 'text',             // 'text' | 'json'
    // text mode config (shares the serial format engine)
    fields: ['id', 'data', 'dt', 'time'],
    delimiter: ',',
    idHex: true,
    timeUnit: 0.001,
    // json mode config
    keys: { id: 'id', data: 'data', time: 't', ext: 'ext', dir: 'dir' },
    // timeline state (used by parseDelimitedCanLine and JSON fallback)
    accT: 0,
    hostT0: null,
    frames: 0,
    parseErrors: 0,
    lastErrorShown: 0
};

/* ============================= UI ============================= */
function wifiInitUI() {
    const span = document.getElementById('trWifiCtl');
    if (!span || span.dataset.built) return;
    span.dataset.built = '1';
    span.innerHTML = `
        <input type="text" id="trWifiUrl" value="ws://192.168.4.1:81" style="width:175px;" title="WebSocket URL of the WiFi CAN device">
        <label>Payload</label>
        <select id="trWifiMode" onchange="wifiModeChanged()">
            <option value="text">Text lines</option>
            <option value="json">JSON frames</option>
        </select>

        <span id="trWifiTextCfg" style="display:flex; align-items:center; gap:8px;">
            <label title="Field order of each line. 'id' and 'data' are mandatory.">Format</label>
            <input type="text" id="trWifiFormat" value="id,data,dt,time" style="width:150px;" title="Comma-separated field order. 'id' and 'data' are mandatory. Allowed: id, data, dlc, time, dt, dir, skip">
            <label>Delim</label>
            <select id="trWifiDelim">
                <option value=",">Comma</option>
                <option value=";">Semicolon</option>
                <option value="\\t">Tab</option>
                <option value=" ">Space</option>
            </select>
            <label>ID</label>
            <select id="trWifiIdBase"><option value="16">HEX</option><option value="10">DEC</option></select>
        </span>

        <span id="trWifiJsonCfg" style="display:none; align-items:center; gap:8px;">
            <label title="JSON key holding the CAN identifier (mandatory)">id key</label>
            <input type="text" id="trWifiKeyId" value="id" style="width:55px;">
            <label title="JSON key holding the payload — byte array or hex string (mandatory)">data key</label>
            <input type="text" id="trWifiKeyData" value="data" style="width:60px;">
            <label title="JSON key holding the timestamp (optional — leave blank to use the host clock)">time key</label>
            <input type="text" id="trWifiKeyTime" value="t" style="width:45px;">
        </span>

        <label>t-unit</label>
        <select id="trWifiTimeUnit"><option value="0.001">ms</option><option value="1">s</option><option value="0.000001">µs</option></select>
        <button class="toolbar-btn primary" id="trWifiBtn" onclick="wifiToggleConnect()">Connect</button>
    `;
}

function wifiModeChanged() {
    const mode = document.getElementById('trWifiMode').value;
    document.getElementById('trWifiTextCfg').style.display = mode === 'text' ? 'flex' : 'none';
    document.getElementById('trWifiJsonCfg').style.display = mode === 'json' ? 'flex' : 'none';
}

/* ============================= CONNECT / DISCONNECT ============================= */
function wifiToggleConnect() {
    if (WIFI.connected) { wifiDisconnect(); return; }

    const url = document.getElementById('trWifiUrl').value.trim();
    if (!/^wss?:\/\//i.test(url)) { showToast('Enter a WebSocket URL, e.g. ws://192.168.4.1:81', 'error'); return; }

    WIFI.mode = document.getElementById('trWifiMode').value;
    WIFI.timeUnit = parseFloat(document.getElementById('trWifiTimeUnit').value);

    if (WIFI.mode === 'text') {
        // Same guardrail as the serial source: 'id' and 'data' can never be missing.
        const fmt = serialParseFormat(document.getElementById('trWifiFormat').value);
        if (fmt.error) { showToast(fmt.error, 'error'); return; }
        WIFI.fields = fmt.fields;
        WIFI.delimiter = document.getElementById('trWifiDelim').value === '\\t' ? '\t' : document.getElementById('trWifiDelim').value;
        WIFI.idHex = document.getElementById('trWifiIdBase').value === '16';
    } else {
        const idKey = document.getElementById('trWifiKeyId').value.trim();
        const dataKey = document.getElementById('trWifiKeyData').value.trim();
        if (!idKey || !dataKey) { showToast("JSON mode: the 'id key' and 'data key' are mandatory and cannot be blank.", 'error'); return; }
        WIFI.keys = {
            id: idKey,
            data: dataKey,
            time: document.getElementById('trWifiKeyTime').value.trim(), // blank = host clock
            ext: 'ext',
            dir: 'dir'
        };
    }

    WIFI.url = url;
    trSetStatus('Connecting to WiFi device…', '');
    let ws;
    try { ws = new WebSocket(url); }
    catch (e) { trSetStatus('Invalid WebSocket URL', 'err'); return; }
    ws.binaryType = 'arraybuffer';
    WIFI.ws = ws;

    ws.onopen = () => {
        WIFI.connected = true;
        WIFI.accT = 0;
        WIFI.hostT0 = performance.now();
        WIFI.frames = 0;
        WIFI.parseErrors = 0;
        traceRebuildDbMaps();
        document.getElementById('trWifiBtn').innerText = 'Disconnect';
        trSetStatus(`WiFi device connected — ${url} (${WIFI.mode === 'text' ? 'text lines [' + WIFI.fields.join(' | ') + ']' : 'JSON frames'})`, 'on');
        showToast('WiFi CAN device connected.', 'success');
        if (typeof plotterUpdateMeta === 'function') plotterUpdateMeta();
    };
    ws.onmessage = (ev) => wifiOnMessage(ev.data);
    ws.onerror = () => { trSetStatus('WiFi connection failed — is the device on and reachable at ' + url + '?', 'err'); };
    ws.onclose = () => {
        const wasConnected = WIFI.connected;
        WIFI.connected = false;
        WIFI.ws = null;
        const btn = document.getElementById('trWifiBtn');
        if (btn) btn.innerText = 'Connect';
        if (wasConnected) trSetStatus('WiFi device disconnected', '');
        if (typeof plotterUpdateMeta === 'function') plotterUpdateMeta();
    };
}

function wifiDisconnect() { if (WIFI.ws) WIFI.ws.close(); }

/* ============================= MESSAGE HANDLING ============================= */
function wifiCountError(msg) {
    WIFI.parseErrors++;
    const now = performance.now();
    if (now - WIFI.lastErrorShown > 3000) {
        WIFI.lastErrorShown = now;
        showToast(`WiFi parse error (${WIFI.parseErrors} total): ${msg}`, 'warning');
        trSetStatus(`WiFi device connected — ${WIFI.frames} frames, ${WIFI.parseErrors} parse error(s)`, 'on');
    }
}

function wifiOnMessage(payload) {
    // Binary WS frames are decoded as UTF-8 text first.
    if (payload instanceof ArrayBuffer) payload = new TextDecoder().decode(payload);
    if (typeof payload !== 'string') return;

    if (WIFI.mode === 'text') {
        // A message may contain one line or many newline-separated lines.
        payload.split('\n').forEach(raw => {
            const line = raw.replace(/\r$/, '').trim();
            if (line) wifiHandleTextLine(line);
        });
    } else {
        let obj;
        try { obj = JSON.parse(payload); }
        catch (e) { wifiCountError('Message is not valid JSON: "' + payload.slice(0, 60) + '"'); return; }
        wifiHandleJson(obj);
    }
}

function wifiHandleTextLine(line) {
    const frame = parseDelimitedCanLine(line, {
        fields: WIFI.fields, delimiter: WIFI.delimiter, idHex: WIFI.idHex,
        timeUnit: WIFI.timeUnit, state: WIFI, onError: wifiCountError
    });
    if (frame) { WIFI.frames++; traceOnFrame(frame); }
}

function wifiHandleJson(obj) {
    if (Array.isArray(obj)) { obj.forEach(wifiHandleJson); return; }  // batched frames
    if (!obj || typeof obj !== 'object') { wifiCountError('JSON payload is not an object.'); return; }

    const k = WIFI.keys;
    const idRaw = obj[k.id];
    const id = typeof idRaw === 'string' ? parseInt(idRaw.replace(/^0x/i, ''), 16) : Number(idRaw);
    if (!Number.isFinite(id)) { wifiCountError(`Missing/invalid id under key '${k.id}'.`); return; }

    const dataRaw = obj[k.data];
    let data;
    if (Array.isArray(dataRaw)) {
        data = dataRaw.slice(0, 64).map(b => Number(b) & 0xFF);
    } else if (typeof dataRaw === 'string') {
        const hex = dataRaw.replace(/[\s.:-]/g, '');
        if (hex.length % 2 !== 0 || /[^0-9A-Fa-f]/.test(hex)) { wifiCountError(`Bad data hex string under key '${k.data}'.`); return; }
        data = [];
        for (let j = 0; j < hex.length && data.length < 64; j += 2) data.push(parseInt(hex.substr(j, 2), 16));
    } else {
        wifiCountError(`Missing/invalid data under key '${k.data}' (expected byte array or hex string).`);
        return;
    }

    let t;
    const tv = k.time ? obj[k.time] : undefined;
    if (k.time && Number.isFinite(Number(tv))) t = Number(tv) * WIFI.timeUnit;
    else t = (performance.now() - WIFI.hostT0) / 1000;

    const ext = obj[k.ext] !== undefined ? !!obj[k.ext] : id > 0x7FF;
    const dir = typeof obj[k.dir] === 'string' && /^t/i.test(obj[k.dir]) ? 'tx' : 'rx';

    WIFI.frames++;
    traceOnFrame({ t, id, ext, dlc: obj.dlc !== undefined && Number.isFinite(Number(obj.dlc)) ? Number(obj.dlc) : data.length, data, dir });
}
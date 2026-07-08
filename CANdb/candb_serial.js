/* =============================================================================
   candb_serial.js — Serial (host device) live source for the CAN Trace tool
   Loaded by candb_web.html after the trace tool. Adds a third trace source:
   line-based CAN frames arriving on a serial port of the host machine, read
   directly by the browser via the Web Serial API (Chrome/Edge desktop).

   Each serial line is a delimited record whose FIELD ORDER IS USER-EDITABLE
   in the UI (e.g. "id,data,dt,time" or "time,id,dlc,data"). Validation
   guarantees the essential fields can never be missing: 'id' and 'data' are
   mandatory; everything else is optional. Parsed frames flow into the same
   traceOnFrame() pipeline as Kvaser/Replay, so the trace grid, DBC decoding,
   and the signal plotter all work identically.

   Recognized field tokens:
     id    CAN identifier (base per the ID-base setting)       [REQUIRED]
     data  payload bytes, hex — "10 27 00" or contiguous "102700" [REQUIRED]
     dlc   payload length in bytes (decimal); derived from data if absent
     time  elapsed timestamp (unit per the time-unit setting)
     dt    delta time since previous frame (same unit); used to build the
           timeline when no absolute 'time' field exists
     dir   direction text: rx / tx (default rx)
     skip  ignore this position (placeholder for uninteresting columns)
============================================================================= */

const SER = {
    connected: false,
    port: null,
    reader: null,
    baud: 115200,
    fields: ['id', 'data', 'dt', 'time'],
    delimiter: ',',
    idHex: true,
    timeUnit: 0.001,          // multiplier to seconds (default: ms)
    lineBuf: '',
    accT: 0,                  // accumulated time when only 'dt' is available
    hostT0: null,             // fallback host clock base
    frames: 0,
    parseErrors: 0,
    lastErrorShown: 0
};

const SERIAL_REQUIRED = ['id', 'data'];
const SERIAL_KNOWN = ['id', 'data', 'dlc', 'time', 'dt', 'dir', 'skip'];

/* ============================= UI ============================= */
function serialInitUI() {
    const span = document.getElementById('trSerialCtl');
    if (!span || span.dataset.built) return;
    span.dataset.built = '1';
    span.innerHTML = `
        <label>Baud</label>
        <select id="trSerBaud">
            ${[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000]
                .map(b => `<option value="${b}" ${b === 115200 ? 'selected' : ''}>${b}</option>`).join('')}
        </select>
        <label>Delim</label>
        <select id="trSerDelim">
            <option value=",">Comma</option>
            <option value=";">Semicolon</option>
            <option value="\\t">Tab</option>
            <option value=" ">Space</option>
        </select>
        <label title="Field order of each serial line. Editable — reorder or add optional fields, but 'id' and 'data' are mandatory. Allowed: ${SERIAL_KNOWN.join(', ')}">Format</label>
        <input type="text" id="trSerFormat" value="id,data,dt,time" style="width:170px;" title="Comma-separated field order. 'id' and 'data' are mandatory. Allowed tokens: ${SERIAL_KNOWN.join(', ')}">
        <label>ID</label>
        <select id="trSerIdBase"><option value="16">HEX</option><option value="10">DEC</option></select>
        <label>t-unit</label>
        <select id="trSerTimeUnit"><option value="0.001">ms</option><option value="1">s</option><option value="0.000001">µs</option></select>
        <button class="toolbar-btn primary" id="trSerBtn" onclick="serialToggleConnect()">Connect</button>
    `;
}

/* ============================= FORMAT VALIDATION =============================
   The order is fully editable, but the essential data set can never be
   missing: 'id' and 'data' are enforced, duplicates and unknown tokens are
   rejected with an explanatory message. Returns { fields } or { error }.   */
function serialParseFormat(str) {
    const fields = String(str || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (fields.length === 0) return { error: 'Format is empty. It must at least contain: id, data.' };
    const unknown = fields.filter(f => !SERIAL_KNOWN.includes(f));
    if (unknown.length) return { error: `Unknown field(s): ${unknown.join(', ')}. Allowed: ${SERIAL_KNOWN.join(', ')}.` };
    const missing = SERIAL_REQUIRED.filter(r => !fields.includes(r));
    if (missing.length) return { error: `Mandatory field(s) missing from format: ${missing.join(', ')}. 'id' and 'data' can never be omitted.` };
    const seen = {};
    for (const f of fields) {
        if (f !== 'skip' && seen[f]) return { error: `Field '${f}' appears more than once in the format.` };
        seen[f] = true;
    }
    return { fields };
}

/* ============================= CONNECT / DISCONNECT ============================= */
async function serialToggleConnect() {
    if (SER.connected) { serialDisconnect(); return; }

    if (!('serial' in navigator)) {
        showToast('Web Serial is not available in this browser. Use Chrome or Edge (desktop).', 'error');
        return;
    }
    const fmt = serialParseFormat(document.getElementById('trSerFormat').value);
    if (fmt.error) { showToast(fmt.error, 'error'); return; }

    SER.fields = fmt.fields;
    SER.baud = parseInt(document.getElementById('trSerBaud').value, 10);
    SER.delimiter = document.getElementById('trSerDelim').value === '\\t' ? '\t' : document.getElementById('trSerDelim').value;
    SER.idHex = document.getElementById('trSerIdBase').value === '16';
    SER.timeUnit = parseFloat(document.getElementById('trSerTimeUnit').value);

    let port;
    try {
        port = await navigator.serial.requestPort();      // user picks the device
        await port.open({ baudRate: SER.baud });
    } catch (e) {
        if (e && e.name === 'NotFoundError') return;      // user cancelled the picker
        trSetStatus('Serial open failed: ' + (e.message || e), 'err');
        showToast('Could not open serial port: ' + (e.message || e), 'error');
        return;
    }

    SER.port = port;
    SER.connected = true;
    SER.lineBuf = '';
    SER.accT = 0;
    SER.hostT0 = performance.now();
    SER.frames = 0;
    SER.parseErrors = 0;

    traceRebuildDbMaps();
    document.getElementById('trSerBtn').innerText = 'Disconnect';
    trSetStatus(`Serial connected — ${SER.baud} baud, format [${SER.fields.join(' | ')}]`, 'on');
    showToast('Serial port opened.', 'success');
    if (typeof plotterUpdateMeta === 'function') plotterUpdateMeta();

    serialReadLoop();
}

async function serialDisconnect() {
    SER.connected = false;
    try { if (SER.reader) await SER.reader.cancel(); } catch (e) { /* already gone */ }
    try { if (SER.port) await SER.port.close(); } catch (e) { /* already gone */ }
    SER.reader = null;
    SER.port = null;
    const btn = document.getElementById('trSerBtn');
    if (btn) btn.innerText = 'Connect';
    trSetStatus('Serial disconnected', '');
    if (typeof plotterUpdateMeta === 'function') plotterUpdateMeta();
}

/* ============================= READ LOOP ============================= */
async function serialReadLoop() {
    const decoder = new TextDecoder();
    while (SER.connected && SER.port && SER.port.readable) {
        SER.reader = SER.port.readable.getReader();
        try {
            while (SER.connected) {
                const { value, done } = await SER.reader.read();
                if (done) break;
                SER.lineBuf += decoder.decode(value, { stream: true });
                let idx;
                while ((idx = SER.lineBuf.indexOf('\n')) >= 0) {
                    const line = SER.lineBuf.slice(0, idx).replace(/\r$/, '').trim();
                    SER.lineBuf = SER.lineBuf.slice(idx + 1);
                    if (line) serialHandleLine(line);
                }
                // Guard against a stream that never sends newlines
                if (SER.lineBuf.length > 65536) { SER.lineBuf = ''; serialCountError('No line endings detected in serial stream.'); }
            }
        } catch (e) {
            if (SER.connected) {
                trSetStatus('Serial read error: ' + (e.message || e) + ' — device unplugged?', 'err');
                SER.connected = false;
            }
        } finally {
            try { SER.reader.releaseLock(); } catch (e) { /* noop */ }
        }
    }
    if (!SER.connected) serialDisconnect();
}

/* ============================= LINE PARSER ============================= */
function serialCountError(msg) {
    SER.parseErrors++;
    // Surface at most one toast per 3 s so a misconfigured format doesn't flood the UI.
    const now = performance.now();
    if (now - SER.lastErrorShown > 3000) {
        SER.lastErrorShown = now;
        showToast(`Serial parse error (${SER.parseErrors} total): ${msg}`, 'warning');
        trSetStatus(`Serial connected — ${SER.frames} frames, ${SER.parseErrors} parse error(s)`, 'on');
    }
}

/* Shared line parser — also used by the WiFi source (candb_wifi.js).
   cfg: { fields, delimiter, idHex, timeUnit, state: {accT, hostT0}, onError(msg) }
   Returns a frame object or null. */
/* Shared delimited-record parser — used by BOTH the Serial and WiFi sources.
   cfg: { fields, delimiter, idHex, timeUnit, state: {accT, hostT0}, onError(msg) }
   Returns a frame object or null. */
function parseDelimitedCanLine(line, cfg) {
    const tokens = (cfg.delimiter === ' ' ? line.split(/\s+/) : line.split(cfg.delimiter))
        .map(t => t.trim());

    if (tokens.length < cfg.fields.length) {
        cfg.onError(`Line has ${tokens.length} field(s), format expects ${cfg.fields.length}: "${line.slice(0, 60)}"`);
        return null;
    }

    let id = null, data = null, dlc = null, timeVal = null, dtVal = null, dir = 'rx';

    for (let i = 0; i < cfg.fields.length; i++) {
        const f = cfg.fields[i], tok = tokens[i];
        if (f === 'skip') continue;
        if (f === 'id') {
            id = parseInt(tok.replace(/^0x/i, ''), cfg.idHex ? 16 : 10);
            if (!Number.isFinite(id)) { cfg.onError(`Bad id token "${tok}"`); return null; }
        } else if (f === 'data') {
            const hex = tok.replace(/[\s.:-]/g, '');       // "10 27 00", "10:27:00", "102700" all fine
            if (hex.length % 2 !== 0 || /[^0-9A-Fa-f]/.test(hex)) {
                if (hex !== '') { cfg.onError(`Bad data token "${tok}"`); return null; }
            }
            data = [];
            for (let j = 0; j < hex.length && data.length < 64; j += 2) data.push(parseInt(hex.substr(j, 2), 16));
        } else if (f === 'dlc') {
            const v = parseInt(tok, 10);
            if (Number.isFinite(v)) dlc = v;
        } else if (f === 'time') {
            const v = parseFloat(tok);
            if (Number.isFinite(v)) timeVal = v * cfg.timeUnit;
        } else if (f === 'dt') {
            const v = parseFloat(tok);
            if (Number.isFinite(v)) dtVal = v * cfg.timeUnit;
        } else if (f === 'dir') {
            dir = /^t/i.test(tok) ? 'tx' : 'rx';
        }
    }

    if (id === null || data === null) { cfg.onError('Line missing id/data value.'); return null; }

    // Timestamp priority: explicit elapsed time > accumulated dt > host clock.
    let t;
    if (timeVal !== null) t = timeVal;
    else if (dtVal !== null) { cfg.state.accT += dtVal; t = cfg.state.accT; }
    else t = (performance.now() - cfg.state.hostT0) / 1000;

    return {
        t,
        id,
        ext: id > 0x7FF,
        dlc: dlc !== null ? dlc : data.length,
        data,
        dir
    };
}

function serialHandleLine(line) {
    const frame = parseDelimitedCanLine(line, {
        fields: SER.fields, delimiter: SER.delimiter, idHex: SER.idHex, timeUnit: SER.timeUnit,
        state: SER, onError: serialCountError
    });
    if (frame) { SER.frames++; traceOnFrame(frame); }
}
/* =============================================================================
   candb_plotter.js — Multi-signal time plotter for CANdb++ Web
   Loaded by candb_web.html after the trace tool. Renders a side panel inside
   the Trace view that plots any number of signals (from any messages) against
   time on a shared X axis. Fed by the trace tool's frame stream, so it updates
   identically for Live (Kvaser WebSocket) and Replay (log file) sources.

   Integration contract with the trace tool:
     - plotterOnFrame(f)      called from traceOnFrame for every frame
     - plotterOnTraceClear()  called when the trace session resets (t0 changes)
     - plotterUpdateMeta()    called after a log file is parsed
     - reads TR.t0, TR.logStartedAt, TR.logFileName, TR.connected
     - uses db, traceLookupMsg(), traceDecodeRaw(), sigColors, escapeHtml()
============================================================================= */

const PLT = {
    built: false,
    open: false,
    paused: false,
    dirty: false,
    rafId: null,
    windowSec: 30,            // rolling window; 0 = all
    yMode: 'common',          // 'common' | 'norm'
    maxPointsPerSignal: 50000,
    series: []                // { key:'S514', msgName, sigName, color, points:[{t,v}], last, min, max, visible }
};

/* ============================= PANEL CONSTRUCTION ============================= */
function plotterToggle() {
    if (!PLT.built) plotterBuild();
    PLT.open = !PLT.open;
    document.getElementById('pltPanel').style.display = PLT.open ? 'flex' : 'none';
    if (PLT.open) {
        plotterPopulateMsgSelect();
        plotterUpdateMeta();
        PLT.dirty = true;
        plotterLoop();
    } else if (PLT.rafId) {
        cancelAnimationFrame(PLT.rafId);
        PLT.rafId = null;
    }
}

function plotterBuild() {
    PLT.built = true;

    const style = document.createElement('style');
    style.textContent = `
        #trMainRow { display:flex; flex:1; min-height:0; }
        #pltPanel { width:480px; flex-shrink:0; border-left:1px solid var(--border-color); background:var(--bg-panel); display:none; flex-direction:column; min-height:0; }
        .plt-head { padding:8px 12px; background:#141e2e; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center; flex-shrink:0; }
        .plt-head b { font-size:0.8rem; }
        .plt-meta { font-size:0.68rem; color:var(--text-muted); font-family:var(--font-mono); padding:5px 12px; border-bottom:1px solid var(--border-color); flex-shrink:0; }
        .plt-meta b { color:#93c5fd; font-weight:600; }
        .plt-ctl { display:flex; flex-wrap:wrap; gap:6px; padding:8px 12px; border-bottom:1px solid var(--border-color); align-items:center; flex-shrink:0; }
        .plt-ctl select, .plt-ctl button { background:var(--bg-base); border:1px solid var(--border-color); color:var(--text-main); padding:4px 7px; border-radius:4px; font-family:var(--font-mono); font-size:0.72rem; outline:none; cursor:pointer; }
        .plt-ctl select:focus { border-color:var(--accent); }
        .plt-ctl button:hover { border-color:var(--accent); }
        .plt-ctl button.primary { background:rgba(59,130,246,0.2); border-color:var(--accent); color:#93c5fd; }
        .plt-legend { padding:6px 12px; border-bottom:1px solid var(--border-color); display:flex; flex-direction:column; gap:3px; max-height:130px; overflow-y:auto; flex-shrink:0; }
        .plt-chip { display:flex; align-items:center; gap:7px; font-family:var(--font-mono); font-size:0.72rem; cursor:pointer; user-select:none; }
        .plt-chip .sw { width:11px; height:11px; border-radius:2px; flex-shrink:0; border:1px solid rgba(255,255,255,0.25); }
        .plt-chip.hidden-sig { opacity:0.35; }
        .plt-chip .nm { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-main); }
        .plt-chip .val { color:#fbbf24; font-weight:700; }
        .plt-chip .rm { color:var(--text-muted); padding:0 4px; }
        .plt-chip .rm:hover { color:var(--error); }
        .plt-canvas-wrap { flex:1; min-height:120px; position:relative; }
        .plt-canvas-wrap canvas { position:absolute; inset:0; width:100%; height:100%; }
        .plt-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:var(--text-muted); font-size:0.78rem; text-align:center; padding:20px; }
    `;
    document.head.appendChild(style);

    // Wrap the trace grid in a horizontal row and attach the panel beside it,
    // so the plotter is a true side window of the trace view.
    const wrap = document.getElementById('trGridWrap');
    const row = document.createElement('div');
    row.id = 'trMainRow';
    wrap.parentNode.insertBefore(row, wrap);
    row.appendChild(wrap);

    const panel = document.createElement('div');
    panel.id = 'pltPanel';
    panel.innerHTML = `
        <div class="plt-head">
            <b>📈 Signal Plotter</b>
            <span class="modal-close" onclick="plotterToggle()">✕</span>
        </div>
        <div class="plt-meta" id="pltMeta">Source: —</div>
        <div class="plt-ctl">
            <select id="pltMsgSel" onchange="plotterMsgChanged()" style="max-width:150px;"></select>
            <select id="pltSigSel" style="max-width:135px;"></select>
            <button class="primary" onclick="plotterAddSignal()">+ Add</button>
            <select id="pltWindow" onchange="plotterWindowChanged()" title="Time window">
                <option value="5">5 s</option><option value="10">10 s</option>
                <option value="30" selected>30 s</option><option value="60">60 s</option>
                <option value="300">5 min</option><option value="0">All</option>
            </select>
            <select id="pltYMode" onchange="plotterYModeChanged()" title="Y axis mode">
                <option value="common">Common Y</option>
                <option value="norm">Normalized %</option>
            </select>
            <button id="pltPauseBtn" onclick="plotterPause()">⏸</button>
            <button onclick="plotterClearPoints()" title="Clear plotted points">🧹</button>
        </div>
        <div class="plt-legend" id="pltLegend"></div>
        <div class="plt-canvas-wrap">
            <canvas id="pltCanvas"></canvas>
            <div class="plt-empty" id="pltEmpty">Add signals above, then start Live or Replay.<br>Signals from different messages plot on the same time axis.</div>
        </div>
    `;
    row.appendChild(panel);
}

/* ============================= META (log start timestamp) ============================= */
function plotterUpdateMeta() {
    const el = document.getElementById('pltMeta');
    if (!el) return;
    if (TR.source === 'live' && TR.connected) {
        el.innerHTML = `Source: <b>Live — Kvaser</b>`;
    } else if (TR.source === 'serial' && typeof SER !== 'undefined' && SER.connected) {
        el.innerHTML = `Source: <b>Live — Serial (${SER.baud} baud)</b>`;
    } else if (TR.source === 'wifi' && typeof WIFI !== 'undefined' && WIFI.connected) {
        el.innerHTML = `Source: <b>Live — WiFi (${escapeHtml(WIFI.url)})</b>`;
    } else if (TR.logFileName) {
        el.innerHTML = `Log: <b>${escapeHtml(TR.logFileName)}</b>` +
            (TR.logStartedAt ? ` &nbsp;|&nbsp; Logging started at: <b>${escapeHtml(TR.logStartedAt)}</b>` : '');
    } else {
        el.innerHTML = 'Source: —';
    }
}

/* ============================= SIGNAL SELECTION ============================= */
let pltMsgs = []; // flat [{ fileName, msg }] snapshot across all loaded DBCs

function plotterPopulateMsgSelect() {
    const sel = document.getElementById('pltMsgSel');
    const prevLabel = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : null;
    const entries = (typeof allDbEntries === 'function') ? allDbEntries() : [{ name: '', db }];
    const multi = entries.length > 1;
    pltMsgs = [];
    entries.forEach(e => e.db.messages.forEach(m => {
        if (!m.isIndependent && m.signals.length > 0) pltMsgs.push({ fileName: e.name, msg: m });
    }));
    sel.innerHTML = pltMsgs.map((x, i) => {
        const label = `${multi ? x.fileName + ' :: ' : ''}${x.msg.name} (0x${x.msg.id.toString(16).toUpperCase()})`;
        return `<option value="${i}">${escapeHtml(label)}</option>`;
    }).join('');
    if (prevLabel) {
        const match = [...sel.options].find(o => o.text === prevLabel);
        if (match) sel.value = match.value;
    }
    plotterMsgChanged();
}

function plotterMsgChanged() {
    const x = pltMsgs[parseInt(document.getElementById('pltMsgSel').value, 10)];
    const sigSel = document.getElementById('pltSigSel');
    sigSel.innerHTML = x ? x.msg.signals.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('') : '';
}

function plotterAddSignal() {
    const x = pltMsgs[parseInt(document.getElementById('pltMsgSel').value, 10)];
    const sigName = document.getElementById('pltSigSel').value;
    if (!x || !sigName) return;
    const sig = x.msg.signals.find(s => s.name === sigName);
    if (!sig) return;
    if (PLT.series.some(s => s.msgRef === x.msg && s.sigRef === sig)) { showToast('Signal is already on the plot.', 'warning'); return; }
    const multi = (typeof allDbEntries === 'function') && allDbEntries().length > 1;
    PLT.series.push({
        key: (x.msg.isExt ? 'X' : 'S') + x.msg.id,
        msgRef: x.msg, sigRef: sig,           // direct refs — immune to active-DB switching
        msgName: x.msg.name, sigName: sig.name,
        label: `${multi ? x.fileName + ' :: ' : ''}${x.msg.name}.${sig.name}`,
        color: sigColors[PLT.series.length % sigColors.length],
        points: [], last: null, min: Infinity, max: -Infinity, visible: true
    });
    plotterRenderLegend();
    PLT.dirty = true;
}

function plotterRemoveSignal(idx) {
    PLT.series.splice(idx, 1);
    plotterRenderLegend();
    PLT.dirty = true;
}

function plotterToggleVisible(idx) {
    PLT.series[idx].visible = !PLT.series[idx].visible;
    plotterRenderLegend();
    PLT.dirty = true;
}

function plotterRenderLegend() {
    const el = document.getElementById('pltLegend');
    el.innerHTML = PLT.series.map((s, i) => {
        const unit = plotterSigUnit(s);
        return `<div class="plt-chip ${s.visible ? '' : 'hidden-sig'}" onclick="plotterToggleVisible(${i})" title="Click to show/hide">
            <span class="sw" style="background:${s.color}"></span>
            <span class="nm">${escapeHtml(s.label || (s.msgName + '.' + s.sigName))}</span>
            <span class="val">${s.last === null ? '—' : s.last}${unit ? ' ' + escapeHtml(unit) : ''}</span>
            <span class="rm" onclick="event.stopPropagation(); plotterRemoveSignal(${i})">✕</span>
        </div>`;
    }).join('');
    document.getElementById('pltEmpty').style.display = PLT.series.length ? 'none' : 'flex';
}

function plotterResolveSig(s) {
    // Direct references stored at Add time — series keep working regardless of
    // which database is active in the explorer.
    return (s.msgRef && s.sigRef) ? { msg: s.msgRef, sig: s.sigRef } : null;
}

function plotterSigUnit(s) {
    const r = plotterResolveSig(s);
    return r ? r.sig.unit : '';
}

/* ============================= FRAME INGESTION ============================= */
function plotterOnFrame(f) {
    if (PLT.series.length === 0 || PLT.paused || !PLT.open) return;
    const key = (f.ext ? 'X' : 'S') + f.id;
    let touched = false;

    for (const s of PLT.series) {
        if (s.key !== key) continue;
        const r = plotterResolveSig(s);
        if (!r) continue;
        const { msg, sig } = r;

        // Multiplexed signal: only sample when its selector value is active.
        if (sig.muxType === 'm') {
            const muxor = msg.signals.find(x => x.muxType === 'M');
            if (!muxor || Number(traceDecodeRaw(muxor, f.data)) !== sig.muxValue) continue;
        }
        const raw = Number(traceDecodeRaw(sig, f.data));
        let v = raw * parseFloat(sig.factor) + parseFloat(sig.offset);
        if (!Number.isFinite(v)) continue;
        v = Number.isInteger(v) ? v : +v.toFixed(4);

        s.points.push({ t: f.t - TR.t0, v });
        if (s.points.length > PLT.maxPointsPerSignal) s.points.splice(0, s.points.length - PLT.maxPointsPerSignal);
        s.last = v;
        if (v < s.min) s.min = v;
        if (v > s.max) s.max = v;
        touched = true;
    }
    if (touched) PLT.dirty = true;
}

// Trace session reset (new replay / Clear): the time base (TR.t0) restarts, so
// existing points would be misaligned — drop points, keep the signal selection.
function plotterOnTraceClear() {
    PLT.series.forEach(s => { s.points = []; s.last = null; s.min = Infinity; s.max = -Infinity; });
    PLT.dirty = true;
    if (PLT.open) plotterRenderLegend();
}

/* ============================= CONTROLS ============================= */
function plotterWindowChanged() { PLT.windowSec = parseFloat(document.getElementById('pltWindow').value); PLT.dirty = true; }
function plotterYModeChanged() { PLT.yMode = document.getElementById('pltYMode').value; PLT.dirty = true; }
function plotterPause() {
    PLT.paused = !PLT.paused;
    document.getElementById('pltPauseBtn').innerText = PLT.paused ? '▶' : '⏸';
    PLT.dirty = true;
}
function plotterClearPoints() { plotterOnTraceClear(); }

/* ============================= RENDER LOOP ============================= */
function plotterLoop() {
    if (!PLT.open) return;
    if (PLT.dirty) {
        PLT.dirty = false;
        plotterDraw();
        plotterRefreshLegendValues();
    }
    PLT.rafId = requestAnimationFrame(plotterLoop);
}

function plotterRefreshLegendValues() {
    const chips = document.querySelectorAll('#pltLegend .plt-chip .val');
    PLT.series.forEach((s, i) => {
        if (!chips[i]) return;
        const unit = plotterSigUnit(s);
        chips[i].textContent = (s.last === null ? '—' : s.last) + (unit ? ' ' + unit : '');
    });
}

function plotterNiceStep(range, targetTicks) {
    const rough = range / Math.max(targetTicks, 1);
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    for (const m of [1, 2, 5, 10]) if (rough <= m * mag) return m * mag;
    return 10 * mag;
}

function plotterDraw() {
    const canvas = document.getElementById('pltCanvas');
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (W === 0 || H === 0) return;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const visible = PLT.series.filter(s => s.visible && s.points.length > 0);
    if (visible.length === 0) return;

    const padL = 52, padR = 10, padT = 8, padB = 22;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    // --- X range: rolling window ending at the latest sample across all series
    let tMax = -Infinity;
    visible.forEach(s => { tMax = Math.max(tMax, s.points[s.points.length - 1].t); });
    let tMin = PLT.windowSec > 0 ? tMax - PLT.windowSec : Infinity;
    if (PLT.windowSec === 0) visible.forEach(s => { tMin = Math.min(tMin, s.points[0].t); });
    if (!(tMax > tMin)) { tMin = tMax - 1; }

    // --- Y range
    let yMin = Infinity, yMax = -Infinity;
    if (PLT.yMode === 'common') {
        visible.forEach(s => s.points.forEach(p => {
            if (p.t < tMin) return;
            if (p.v < yMin) yMin = p.v;
            if (p.v > yMax) yMax = p.v;
        }));
        if (yMin === Infinity) { yMin = 0; yMax = 1; }
        if (yMin === yMax) { yMin -= 1; yMax += 1; }
        const pad = (yMax - yMin) * 0.08;
        yMin -= pad; yMax += pad;
    } else { yMin = 0; yMax = 100; }

    const xOf = t => padL + ((t - tMin) / (tMax - tMin)) * plotW;
    const yOf = v => padT + (1 - (v - yMin) / (yMax - yMin)) * plotH;

    // --- Grid + axes
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.fillStyle = '#64748b';
    ctx.font = '10px Consolas, monospace';
    ctx.lineWidth = 1;

    const yStep = plotterNiceStep(yMax - yMin, 6);
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) {
        const y = yOf(v);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillText(PLT.yMode === 'norm' ? v + '%' : +v.toFixed(3), 4, y + 3);
    }
    const xStep = plotterNiceStep(tMax - tMin, 6);
    for (let t = Math.ceil(tMin / xStep) * xStep; t <= tMax; t += xStep) {
        const x = xOf(t);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
        ctx.fillText(+t.toFixed(2) + 's', x - 12, H - 8);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(padL, padT, plotW, plotH);

    // --- Series (step-style lines: signal values hold between samples)
    visible.forEach(s => {
        // Per-signal normalization for the '%' mode
        let nMin = s.min, nMax = s.max;
        if (nMin === nMax) { nMin -= 1; nMax += 1; }
        const val = PLT.yMode === 'norm' ? (p => ((p.v - nMin) / (nMax - nMin)) * 100) : (p => p.v);

        ctx.strokeStyle = s.color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false, prevY = null;
        // Start one point before the window so the line enters from the left edge
        let startIdx = s.points.findIndex(p => p.t >= tMin);
        if (startIdx < 0) startIdx = s.points.length - 1;
        if (startIdx > 0) startIdx--;
        for (let i = startIdx; i < s.points.length; i++) {
            const p = s.points[i];
            const x = Math.max(padL, Math.min(W - padR, xOf(p.t)));
            const y = yOf(val(p));
            if (!started) { ctx.moveTo(x, y); started = true; }
            else { ctx.lineTo(x, prevY); ctx.lineTo(x, y); } // hold-then-step
            prevY = y;
        }
        // Extend the last value to "now" (right edge)
        if (started && prevY !== null) ctx.lineTo(W - padR, prevY);
        ctx.stroke();
    });
}
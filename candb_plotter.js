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
    document.getElementById('pltResizeHandle').style.display = PLT.open ? 'block' : 'none';
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
        #pltResizeHandle { width:6px; flex-shrink:0; cursor:col-resize; background:var(--border-color); position:relative; display:none; }
        #pltResizeHandle::before { content:''; position:absolute; inset:0 -3px; }
        #pltResizeHandle:hover, #pltResizeHandle.dragging { background:var(--accent); }
        .plt-head { padding:8px 12px; background:var(--bg-header); border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center; flex-shrink:0; }
        .plt-head b { font-size:0.8rem; }
        .plt-meta { font-size:0.68rem; color:var(--text-muted); font-family:var(--font-mono); padding:5px 12px; border-bottom:1px solid var(--border-color); flex-shrink:0; }
        .plt-meta b { color:var(--accent-blue); font-weight:600; }
        .plt-ctl { display:flex; flex-wrap:wrap; gap:6px; padding:8px 12px; border-bottom:1px solid var(--border-color); align-items:center; flex-shrink:0; }
        .plt-ctl select, .plt-ctl button { background:var(--bg-base); border:1px solid var(--border-color); color:var(--text-main); padding:4px 7px; border-radius:4px; font-family:var(--font-mono); font-size:0.72rem; outline:none; cursor:pointer; }
        .plt-ctl select:focus { border-color:var(--accent); }
        .plt-ctl button:hover { border-color:var(--accent); }
        .plt-ctl button.primary { background:rgba(59,130,246,0.2); border-color:var(--accent); color:var(--accent-blue); }
        .plt-ctl button:disabled { opacity:0.35; cursor:not-allowed; border-color:var(--border-color); }
        .plt-ctl button:disabled:hover { border-color:var(--border-color); }
        .plt-legend { padding:6px 12px; border-bottom:1px solid var(--border-color); display:flex; flex-direction:column; gap:3px; max-height:130px; overflow-y:auto; flex-shrink:0; }
        .plt-chip { display:flex; align-items:center; gap:5px; font-family:var(--font-mono); font-size:0.72rem; cursor:pointer; user-select:none; }
        .plt-chip .sw { width:11px; height:11px; border-radius:2px; flex-shrink:0; border:1px solid rgba(255,255,255,0.25); }
        .plt-chip.hidden-sig { opacity:0.35; }
        .plt-chip .nm { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--text-main); min-width:24px; }
        .plt-chip .val { color:var(--accent-amber-bright); font-weight:700; }
        .plt-chip .rm { color:var(--text-muted); padding:0 4px; }
        .plt-chip .rm:hover { color:var(--error); }
        .plt-axis-badge { flex-shrink:0; width:14px; height:14px; line-height:14px; text-align:center; border-radius:3px; font-size:0.62rem; font-weight:700; background:var(--bg-base); border:1px solid var(--border-color); color:var(--text-muted); cursor:pointer; }
        .plt-axis-badge:hover { border-color:var(--accent); color:var(--accent-blue); }
        .plt-scale-input, .plt-offset-input { flex-shrink:0; width:36px; background:var(--bg-base); border:1px solid var(--border-color); color:var(--text-main); border-radius:3px; font-family:var(--font-mono); font-size:0.65rem; padding:2px 3px; cursor:text; }
        .plt-scale-input:focus, .plt-offset-input:focus { outline:none; border-color:var(--accent); }
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

    const handle = document.createElement('div');
    handle.id = 'pltResizeHandle';
    handle.title = 'Drag to resize the plotter width';
    handle.addEventListener('mousedown', plotterResizeStart);
    row.appendChild(handle);

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
            <button id="pltExportBtn" onclick="plotterOpenExportDialog()" title="Save plot as image (pause the plot or the trace/replay first)" disabled>💾</button>
        </div>
        <div class="plt-legend" id="pltLegend"></div>
        <div class="plt-canvas-wrap">
            <canvas id="pltCanvas"></canvas>
            <div class="plt-empty" id="pltEmpty">Add signals above, then start Live or Replay.<br>Signals from different messages plot on the same time axis.</div>
        </div>
    `;
    row.appendChild(panel);
}

/* ============================= RESIZE HANDLE ============================= */
let pltResizeStartX = 0, pltResizeStartW = 0;

function plotterResizeStart(e) {
    pltResizeStartX = e.clientX;
    pltResizeStartW = document.getElementById('pltPanel').offsetWidth;
    document.getElementById('pltResizeHandle').classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', plotterResizeMove);
    document.addEventListener('mouseup', plotterResizeEnd);
    e.preventDefault();
}

function plotterResizeMove(e) {
    // Panel sits on the right of the handle, so dragging left (negative dx) widens it.
    const dx = pltResizeStartX - e.clientX;
    const min = 260, max = Math.max(min, window.innerWidth - 320);
    const w = Math.max(min, Math.min(pltResizeStartW + dx, max));
    document.getElementById('pltPanel').style.width = w + 'px';
    PLT.dirty = true;
}

function plotterResizeEnd() {
    document.getElementById('pltResizeHandle').classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', plotterResizeMove);
    document.removeEventListener('mouseup', plotterResizeEnd);
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
        points: [], last: null, min: Infinity, max: -Infinity, visible: true,
        axis: 'left', plotScale: 1, plotOffset: 0
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
            <span class="plt-axis-badge" onclick="event.stopPropagation(); plotterToggleAxis(${i})" title="Move to ${s.axis === 'right' ? 'left' : 'right'} axis (Common Y mode)">${s.axis === 'right' ? 'R' : 'L'}</span>
            <span class="nm">${escapeHtml(s.label || (s.msgName + '.' + s.sigName))}</span>
            <input class="plt-scale-input" type="number" step="0.1" value="${s.plotScale}" title="Plot scale (×) — line only, legend value stays true"
                onclick="event.stopPropagation()" oninput="plotterSetScale(${i}, this.value)">
            <input class="plt-offset-input" type="number" step="0.1" value="${s.plotOffset}" title="Plot offset (+) — line only, legend value stays true"
                onclick="event.stopPropagation()" oninput="plotterSetOffset(${i}, this.value)">
            <span class="val">${s.last === null ? '—' : s.last}${unit ? ' ' + escapeHtml(unit) : ''}</span>
            <span class="rm" onclick="event.stopPropagation(); plotterRemoveSignal(${i})">✕</span>
        </div>`;
    }).join('');
    document.getElementById('pltEmpty').style.display = PLT.series.length ? 'none' : 'flex';
}

function plotterToggleAxis(idx) {
    PLT.series[idx].axis = PLT.series[idx].axis === 'right' ? 'left' : 'right';
    plotterRenderLegend();
    PLT.dirty = true;
}

function plotterSetScale(idx, raw) {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) { PLT.series[idx].plotScale = n; PLT.dirty = true; }
}

function plotterSetOffset(idx, raw) {
    const n = parseFloat(raw);
    if (Number.isFinite(n)) { PLT.series[idx].plotOffset = n; PLT.dirty = true; }
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
    plotterSyncExportBtn();
    PLT.dirty = true;
}
function plotterClearPoints() { plotterOnTraceClear(); }

// True whenever nothing can currently push new points into the plot — either the
// plotter's own Pause is on, or the active source (replay/live/serial/WiFi) isn't
// streaming right now. Image export is safe/meaningful exactly in this state.
function plotterIsFrozen() {
    if (PLT.paused) return true;
    if (TR.source === 'replay') return TR.replayState !== 'playing';
    if (TR.source === 'live') return !TR.connected;
    if (TR.source === 'serial') return !(typeof SER !== 'undefined' && SER.connected);
    if (TR.source === 'wifi') return !(typeof WIFI !== 'undefined' && WIFI.connected);
    return true;
}

function plotterSyncExportBtn() {
    const btn = document.getElementById('pltExportBtn');
    if (btn) btn.disabled = !plotterIsFrozen();
}

/* ============================= RENDER LOOP ============================= */
function plotterLoop() {
    if (!PLT.open) return;
    plotterSyncExportBtn();
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
    plotterRenderToContext(ctx, W, H);
}

// Plot-only transform: scales/shifts the drawn line so mismatched-magnitude
// signals can share an axis. The legend's live value stays the true decoded
// reading — this never touches s.last.
function plotterDisplayVal(s, v) { return v * s.plotScale + s.plotOffset; }

// Shared by the live canvas (plotterDraw) and image export (plotterExportImage)
// so both always render identically.
function plotterRenderToContext(ctx, W, H) {
    const themeVars = getComputedStyle(document.documentElement);
    const bgColor = themeVars.getPropertyValue('--bg-panel').trim() || '#0f172a';
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, W, H);

    const visible = PLT.series.filter(s => s.visible && s.points.length > 0);
    if (visible.length === 0) return;

    const rightSeries = PLT.yMode === 'common' ? visible.filter(s => s.axis === 'right') : [];
    const leftSeries = PLT.yMode === 'common' ? visible.filter(s => s.axis !== 'right') : visible;
    const hasRightAxis = rightSeries.length > 0;

    const padL = 52, padR = hasRightAxis ? 52 : 10, padT = 8, padB = 22;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    // --- X range: rolling window ending at the latest sample across all series
    let tMax = -Infinity;
    visible.forEach(s => { tMax = Math.max(tMax, s.points[s.points.length - 1].t); });
    let tMin = PLT.windowSec > 0 ? tMax - PLT.windowSec : Infinity;
    if (PLT.windowSec === 0) visible.forEach(s => { tMin = Math.min(tMin, s.points[0].t); });
    if (!(tMax > tMin)) { tMin = tMax - 1; }

    // --- Y range(s)
    function commonRange(series) {
        let yMin = Infinity, yMax = -Infinity;
        series.forEach(s => s.points.forEach(p => {
            if (p.t < tMin) return;
            const dv = plotterDisplayVal(s, p.v);
            if (dv < yMin) yMin = dv;
            if (dv > yMax) yMax = dv;
        }));
        if (yMin === Infinity) { yMin = 0; yMax = 1; }
        if (yMin === yMax) { yMin -= 1; yMax += 1; }
        const pad = (yMax - yMin) * 0.08;
        return { min: yMin - pad, max: yMax + pad };
    }

    let leftRange, rightRange;
    if (PLT.yMode === 'common') {
        leftRange = commonRange(leftSeries.length ? leftSeries : visible);
        if (hasRightAxis) rightRange = commonRange(rightSeries);
    } else {
        leftRange = { min: 0, max: 100 };
    }

    const xOf = t => padL + ((t - tMin) / (tMax - tMin)) * plotW;
    const yOfLeft = v => padT + (1 - (v - leftRange.min) / (leftRange.max - leftRange.min)) * plotH;
    const yOfRight = hasRightAxis ? (v => padT + (1 - (v - rightRange.min) / (rightRange.max - rightRange.min)) * plotH) : null;

    // --- Grid + axes (colors follow the active dark/light theme via CSS vars,
    // read fresh each draw since a <canvas> can't reference var() directly)
    const gridColor = themeVars.getPropertyValue('--plot-grid').trim() || 'rgba(255,255,255,0.07)';
    const axisColor = themeVars.getPropertyValue('--plot-axis').trim() || 'rgba(255,255,255,0.25)';
    const tickColor = themeVars.getPropertyValue('--plot-tick-text').trim() || '#64748b';

    ctx.strokeStyle = gridColor;
    ctx.fillStyle = tickColor;
    ctx.font = '10px Consolas, monospace';
    ctx.lineWidth = 1;

    const yStep = plotterNiceStep(leftRange.max - leftRange.min, 6);
    for (let v = Math.ceil(leftRange.min / yStep) * yStep; v <= leftRange.max; v += yStep) {
        const y = yOfLeft(v);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
        ctx.fillText(PLT.yMode === 'norm' ? v + '%' : +v.toFixed(3), 4, y + 3);
    }
    if (hasRightAxis) {
        const rStep = plotterNiceStep(rightRange.max - rightRange.min, 6);
        ctx.fillStyle = tickColor;
        for (let v = Math.ceil(rightRange.min / rStep) * rStep; v <= rightRange.max; v += rStep) {
            const y = yOfRight(v);
            ctx.fillText(+v.toFixed(3), W - padR + 4, y + 3);
        }
    }
    const xStep = plotterNiceStep(tMax - tMin, 6);
    for (let t = Math.ceil(tMin / xStep) * xStep; t <= tMax; t += xStep) {
        const x = xOf(t);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
        ctx.fillText(+t.toFixed(2) + 's', x - 12, H - 8);
    }
    ctx.strokeStyle = axisColor;
    ctx.strokeRect(padL, padT, plotW, plotH);

    // --- Series (step-style lines: signal values hold between samples)
    visible.forEach(s => {
        // Per-signal normalization for the '%' mode
        let nMin = s.min, nMax = s.max;
        if (nMin === nMax) { nMin -= 1; nMax += 1; }
        const yOf = (s.axis === 'right' && yOfRight) ? yOfRight : yOfLeft;
        const val = PLT.yMode === 'norm' ? (p => ((p.v - nMin) / (nMax - nMin)) * 100) : (p => plotterDisplayVal(s, p.v));

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

/* ============================= IMAGE EXPORT (paused only) ============================= */
function plotterOpenExportDialog() {
    if (!plotterIsFrozen()) return;
    const canvas = document.getElementById('pltCanvas');
    const defW = Math.max(1, Math.round(canvas.clientWidth)) || 800;
    const defH = Math.max(1, Math.round(canvas.clientHeight)) || 400;
    openModal('Save Plot Image',
        `<label style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;font-weight:600;">Format</label>
         <select id="imgFormatSel">
            <option value="image/png">PNG (lossless)</option>
            <option value="image/jpeg">JPEG</option>
         </select>
         <label style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;font-weight:600;">Size (px)</label>
         <div style="display:flex; align-items:center; gap:6px;">
            <input type="number" id="imgWidthInput" value="${defW}" min="100" max="4000" style="flex:1;">
            <span style="color:var(--text-muted);">×</span>
            <input type="number" id="imgHeightInput" value="${defH}" min="100" max="4000" style="flex:1;">
         </div>
         <label style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;font-weight:600;">Resolution</label>
         <select id="imgScaleSel">
            <option value="1">1x (standard)</option>
            <option value="2" selected>2x (high-res)</option>
            <option value="3">3x (ultra)</option>
         </select>
         <div class="modal-error-text" id="imgExportErr"></div>`,
        [
            { label: 'Cancel', onClick: closeModal },
            { label: 'Download', variant: 'primary', onClick: () => {
                const w = parseInt(document.getElementById('imgWidthInput').value, 10);
                const h = parseInt(document.getElementById('imgHeightInput').value, 10);
                const scale = parseInt(document.getElementById('imgScaleSel').value, 10);
                const format = document.getElementById('imgFormatSel').value;
                if (!Number.isFinite(w) || w < 100 || w > 4000 || !Number.isFinite(h) || h < 100 || h > 4000) {
                    document.getElementById('imgExportErr').innerText = 'Width and height must be between 100 and 4000 px.';
                    return;
                }
                closeModal();
                plotterExportImage(w, h, scale, format);
            } }
        ]);
}

function plotterExportImage(width, height, scale, format) {
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    plotterRenderToContext(ctx, width, height);

    const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    const ext = format === 'image/jpeg' ? 'jpg' : 'png';
    canvas.toBlob(blob => {
        if (!blob) { showToast('Image export failed.', 'error'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `canvas-studios-plot_${ts}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, format, format === 'image/jpeg' ? 0.92 : undefined);
}

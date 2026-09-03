/* =============================================================================
   candb_blf.js — Vector .blf (Binary Logging Format) reader for Replay source
   Loaded by index.html alongside candb_plotter.js / candb_serial.js / candb_wifi.js.

   .blf is a binary container format: a 144-byte file header ("LOGG") followed
   by a stream of LOBJ objects. In practice the top-level objects are almost
   always LOG_CONTAINER records, each holding a zlib-deflated chunk of further
   LOBJ objects (CAN_MESSAGE / CAN_MESSAGE2 / CAN_FD_MESSAGE, among others) —
   a single message can straddle two containers, so the tail of one container's
   decompressed bytes is carried over and prefixed onto the next.

   Decompression uses the browser's native DecompressionStream('deflate') (zlib
   framing, matching BLF's ZLIB_DEFLATE method) instead of a bundled inflate
   library — Chrome/Edge/Firefox/Safari have all shipped it since ~2023, and
   this project already leans on Chromium-only APIs (Web Serial) elsewhere.

   Struct layout cross-checked against python-can's can/io/blf.py (BSD-licensed
   BLF reader) — ObjectHeaderBase is 16 bytes, ObjectHeaderV1 adds 16 (32 total),
   ObjectHeaderV2 adds 24 (40 total); the object's own `header_size` field is
   authoritative, so those totals are only cross-validation, not hardcoded here.

   Output frames use the same {t, id, ext, dlc, data, dir} shape produced by
   trParseLogTextAsync() for .asc/.trc/.log, so trToggleReplay() can hand BLF
   frames straight to the existing replay engine. Timestamps are kept relative
   to the file's own clock (raw ticks * resolution factor) — the replay engine
   only ever uses the delta between frame timestamps, never absolute time. */

const BLF_LOG_CONTAINER = 10;
const BLF_CAN_MESSAGE = 1;
const BLF_CAN_MESSAGE2 = 86;
const BLF_CAN_FD_MESSAGE = 100;
const BLF_CAN_MSG_EXT = 0x80000000;
const BLF_REMOTE_FLAG = 0x80;
const BLF_DIR_TX = 0x1;
const BLF_DLC2LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];

function blfSig4(view, offset) {
    return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

async function blfInflateZlib(bytes) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('This browser has no DecompressionStream support (needed to decompress .blf log containers). Use Chrome, Edge, Firefox 113+, or Safari 16.4+.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decodes CAN_MESSAGE / CAN_MESSAGE2 / CAN_FD_MESSAGE objects out of one
// already-decompressed container's bytes, appending frames. Objects here are
// packed back-to-back with NO 4-byte padding between them (unlike the
// top-level container framing below) — matches python-can's inner object loop.
// Returns the leftover bytes of a trailing object that didn't fully fit, to
// be prefixed onto the next container's decompressed bytes.
function blfParseContainerObjects(bytes, frames) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = bytes.byteLength;
    let pos = 0;
    while (pos + 16 <= len) {
        if (blfSig4(view, pos) !== 'LOBJ') break;
        const headerSize = view.getUint16(pos + 4, true);
        const headerVersion = view.getUint16(pos + 6, true);
        const objSize = view.getUint32(pos + 8, true);
        const objType = view.getUint32(pos + 12, true);
        if (objSize < 16 || headerSize < 16) break;
        if (pos + objSize > len) break; // incomplete trailing object -> carried to next container

        if (headerVersion === 1 || headerVersion === 2) {
            const resFlag = view.getUint8(pos + 16);      // V1 flags low byte / V2 timestamp_status
            const timestamp = view.getBigUint64(pos + 24, true);
            const factor = resFlag === 1 ? 1e-5 : 1e-9;    // TIME_TEN_MICS : TIME_ONE_NANS
            const t = Number(timestamp) * factor;
            const payloadOffset = pos + headerSize;
            const objEnd = pos + objSize;

            if ((objType === BLF_CAN_MESSAGE || objType === BLF_CAN_MESSAGE2) && payloadOffset + 16 <= objEnd) {
                const flags = view.getUint8(payloadOffset + 2);
                const dlc = Math.min(view.getUint8(payloadOffset + 3), 8);
                const canId = view.getUint32(payloadOffset + 4, true);
                const data = [];
                for (let b = 0; b < dlc; b++) data.push(view.getUint8(payloadOffset + 8 + b));
                frames.push({
                    t, id: canId & 0x1FFFFFFF, ext: !!(canId & BLF_CAN_MSG_EXT),
                    dlc: data.length, data, dir: (flags & BLF_DIR_TX) ? 'tx' : 'rx'
                });
            } else if (objType === BLF_CAN_FD_MESSAGE && payloadOffset + 20 <= objEnd) {
                // <HBBLLBBB5x64s>: channel,flags,dlc,arbId,frameLen,bitCount,fdFlags,validBytes,pad5,data64
                const flags = view.getUint8(payloadOffset + 2);
                const dlcRaw = view.getUint8(payloadOffset + 3);
                const canId = view.getUint32(payloadOffset + 4, true);
                const validBytes = view.getUint8(payloadOffset + 14);
                const byteLen = BLF_DLC2LEN[Math.min(dlcRaw, 15)];
                const n = Math.min(validBytes || byteLen, 64);
                const dataStart = payloadOffset + 20;
                const data = [];
                for (let b = 0; b < n && dataStart + b < objEnd; b++) data.push(view.getUint8(dataStart + b));
                frames.push({
                    t, id: canId & 0x1FFFFFFF, ext: !!(canId & BLF_CAN_MSG_EXT),
                    dlc: data.length, data, dir: (flags & BLF_DIR_TX) ? 'tx' : 'rx'
                });
            }
        }
        pos += objSize;
    }
    return bytes.subarray(pos);
}

// Parses a whole .blf ArrayBuffer into replay frames. onProgress(0..1) is
// called between top-level containers (decompression already yields to the
// event loop via await, so this never freezes the tab).
async function parseBlfArrayBuffer(buffer, onProgress) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const fileLen = bytes.byteLength;
    if (fileLen < 8 || blfSig4(view, 0) !== 'LOGG') {
        throw new Error('Not a Vector BLF file (missing "LOGG" signature).');
    }
    const fileHeaderSize = view.getUint32(4, true) || 144;

    const frames = [];
    let carry = new Uint8Array(0);
    let pos = fileHeaderSize;

    while (pos + 16 <= fileLen) {
        if (blfSig4(view, pos) !== 'LOBJ') {
            // Resync: some third-party BLF writers pad top-level objects
            // inconsistently — scan a short window for the next object start.
            let resynced = -1;
            for (let p = pos + 1; p < Math.min(pos + 8, fileLen - 4); p++) {
                if (blfSig4(view, p) === 'LOBJ') { resynced = p; break; }
            }
            if (resynced < 0) break;
            pos = resynced;
        }
        const objSize = view.getUint32(pos + 8, true);
        const objType = view.getUint32(pos + 12, true);
        if (objSize < 16 || pos + objSize > fileLen) break;

        if (objType === BLF_LOG_CONTAINER) {
            const containerSubHeader = pos + 16;
            const compressionMethod = view.getUint16(containerSubHeader, true);
            const containerDataStart = containerSubHeader + 16; // LOG_CONTAINER's own 16-byte sub-header
            const containerDataEnd = pos + objSize;
            const compData = bytes.subarray(containerDataStart, containerDataEnd);

            let raw;
            if (compressionMethod === 0) raw = compData;
            else if (compressionMethod === 2) raw = await blfInflateZlib(compData);
            else raw = new Uint8Array(0); // unknown compression method — skip this container

            let combined = raw;
            if (carry.length) {
                combined = new Uint8Array(carry.length + raw.length);
                combined.set(carry, 0);
                combined.set(raw, carry.length);
            }
            carry = blfParseContainerObjects(combined, frames);
        }

        pos += objSize + (objSize % 4); // top-level objects are padded to a 4-byte boundary
        if (onProgress) onProgress(Math.min(1, pos / fileLen));
    }

    frames.sort((a, b) => a.t - b.t);
    return frames;
}

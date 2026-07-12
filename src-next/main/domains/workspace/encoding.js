'use strict';

function decodeText(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { text: bytes.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: bytes.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) { swapped[index - 2] = bytes[index + 1]; swapped[index - 1] = bytes[index]; }
    return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
  }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
  catch (_) { try { return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' }; } catch (_) { return { text: bytes.toString('latin1'), encoding: 'latin1' }; } }
}

function dominantEol(text) { return String(text || '').includes('\r\n') ? '\r\n' : '\n'; }
function normalizeEol(text) { return String(text || '').replace(/\r\n/g, '\n'); }
function restoreEol(text, eol) { return normalizeEol(text).replace(/\n/g, eol || '\n'); }
function containsNul(text) { return String(text || '').includes('\0'); }

module.exports = { decodeText, dominantEol, normalizeEol, restoreEol, containsNul };

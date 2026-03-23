// Lightweight debug helper. Use DEBUG_OAUTH or DEBUG to enable debug output.
function _isTruthy(val) {
  if (val === undefined || val === null) return false;
  const s = String(val).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

export function isDebug() {
  return _isTruthy(process.env.DEBUG_OAUTH) || _isTruthy(process.env.DEBUG);
}

export function debugLog(...args) {
  if (!isDebug()) return;
  try { console.log(...args); } catch (e) { /* ignore */ }
}

export default { isDebug, debugLog };


/**
 * Evaluates pure physical terminal capabilities for output formatting (Contract Baseline v1.3).
 * Stripped of OS environment labels (Docker, CI, etc.).
 */

/**
 * @param {NodeJS.WritableStream} [stream=process.stdout]
 * @returns {Readonly<{ isTTY: boolean, supportsColor: boolean, supportsCursorMovement: boolean, columns: number, rows: number }>}
 */
export function getTerminalCapabilities(stream = process.stdout) {
  const isTTY = Boolean(stream && stream.isTTY);

  // Check color support (via stream, Chalk detection or NO_COLOR standard)
  const noColor = Boolean(process.env.NO_COLOR && process.env.NO_COLOR !== '0');
  const forceColor = Boolean(process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0');
  const supportsColor = !noColor && (forceColor || isTTY || Boolean(stream?.getColorDepth && stream.getColorDepth() > 1));

  // Cursor movement is safe only on interactive TTYs
  const supportsCursorMovement = Boolean(isTTY && stream === process.stdout);

  const columns = (stream && typeof stream.columns === 'number' && stream.columns > 0)
    ? stream.columns
    : 80;

  const rows = (stream && typeof stream.rows === 'number' && stream.rows > 0)
    ? stream.rows
    : 24;

  return Object.freeze({
    isTTY,
    supportsColor,
    supportsCursorMovement,
    columns,
    rows
  });
}

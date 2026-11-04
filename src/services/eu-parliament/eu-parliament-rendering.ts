/**
 * @fileoverview Lossless field-path text: the `content[]` twin of every tool result.
 * @module services/eu-parliament/eu-parliament-rendering
 */

function quoted(value: string): string {
  const json = JSON.stringify(value);
  let longestRun = 0;
  for (const match of json.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${json} ${fence}`;
}
/** Render every scalar, empty container and array entry, retaining active URL links. */
function renderValue(value: unknown, path: string): string {
  if (Array.isArray(value))
    return value.length
      ? value.map((item, index) => renderValue(item, `${path}[${index}]`)).join('\n')
      : `${path}: []`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    return entries.length
      ? entries.map(([key, item]) => renderValue(item, `${path}.${key}`)).join('\n')
      : `${path}: {}`;
  }
  if (typeof value === 'string') {
    const text = quoted(value);
    return `${path}: ${/^https?:\/\/[^\s<>]*$/.test(value) ? `[${text}](<${value.replaceAll('\\', '%5C')}>)` : text}`;
  }
  return `${path}: ${String(value)}`;
}
/** Every leaf of `value` as `path: value`; a blank line between leaves keeps each one independent. */
export function fieldPathText(value: unknown, path = 'result'): string {
  return renderValue(value, path).replaceAll('\n', '\n\n');
}

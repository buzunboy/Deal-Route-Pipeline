/**
 * Recover the JSON payload from a model reply. Models sometimes wrap JSON in a
 * ```json fence (occasionally with a missing closing fence on a truncated reply),
 * append prose after it, or emit invalid backslash escapes (e.g. the German
 * gender-star "Nutzer\*innen"). We (1) unwrap a fenced block, closed or not,
 * (2) else take the first balanced top-level object, then (3) repair invalid JSON
 * string escapes. This only UN-WRAPS and REPAIRS shape; the boundary parser still
 * validates every field — we never trust raw output.
 */
export function recoverJsonText(text: string): string {
  const trimmed = text.trim();
  let body: string;
  const closed = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  if (closed) {
    body = closed[1]!.trim();
  } else {
    // Strip an unterminated opening fence (truncated reply), else use the text.
    const open = /^```(?:json)?\s*([\s\S]*)$/.exec(trimmed);
    const candidate = open ? open[1]!.trim() : trimmed;
    body = firstBalancedObject(candidate) ?? candidate;
  }
  return repairInvalidEscapes(body);
}

/**
 * JSON permits only \" \\ \/ \b \f \n \r \t \uXXXX as backslash escapes. Models
 * copying verbatim source text sometimes emit others (e.g. "\*"); JSON.parse then
 * rejects the whole document. We drop the stray backslash before such a character
 * so the literal survives, leaving valid escapes untouched.
 */
function repairInvalidEscapes(json: string): string {
  return json.replace(/\\(.)/g, (match, next: string) => {
    if (next === 'u') return match; // \uXXXX — leave the unicode escape intact
    return '"\\/bfnrt'.includes(next) ? match : next;
  });
}

/** Return the first balanced `{ … }` block in `text`, or null if none. */
function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

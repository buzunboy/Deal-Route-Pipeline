/**
 * Recover the JSON payload from a model reply.
 *
 * LLMs copying verbatim source text into JSON strings produce several recurring
 * malformations that make `JSON.parse` reject the whole document:
 *  - wrapping the JSON in a ```json fence (sometimes unterminated on a truncated
 *    reply) and/or appending prose after it;
 *  - invalid backslash escapes, e.g. the German gender-star "Nutzer\*innen";
 *  - UNESCAPED inner double-quotes, e.g. copying  „DB Navigator"  into a value,
 *    which prematurely closes the string;
 *  - raw control characters (literal newlines/tabs) inside a string.
 *
 * We (1) unwrap any fence, (2) else take the first balanced top-level object,
 * then (3) run a string-aware repair that fixes the above. This only UN-WRAPS and
 * REPAIRS shape so the document parses; the boundary schema still validates every
 * field afterwards — we never trust raw output, this just makes it parseable.
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
  return repairJsonStrings(body);
}

const VALID_ESCAPES = '"\\/bfnrtu';
/** After a real closing quote, the next non-space char is one of these. */
const STRUCTURAL_AFTER_STRING = new Set([',', '}', ']', ':']);

/**
 * Single-pass, string-aware repair. Walks the text tracking whether we're inside
 * a JSON string and rewrites only the known LLM mistakes:
 *  - a backslash before a non-JSON-escape char → drop the backslash (keep the char);
 *  - a raw control character inside a string → escape it (\n, \t, …);
 *  - a bare `"` inside a string that is NOT the terminator (the next non-space
 *    char isn't structural) → escape it to `\"`.
 * Structure outside strings is left untouched.
 */
function repairJsonStrings(json: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;

    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }

    // Inside a string.
    if (ch === '\\') {
      const next = json[i + 1];
      if (next !== undefined && VALID_ESCAPES.includes(next)) {
        out += ch + next; // valid escape — keep the pair
        i++;
      } else if (next !== undefined) {
        out += next; // invalid escape (e.g. \*) — drop the backslash, keep char
        i++;
      } else {
        out += '\\\\'; // trailing lone backslash — escape it
      }
      continue;
    }

    if (ch === '"') {
      // Is this the string terminator, or an unescaped inner quote? It terminates
      // only if the next non-space char is structural (or end of input).
      let j = i + 1;
      while (
        j < json.length &&
        (json[j] === ' ' || json[j] === '\t' || json[j] === '\n' || json[j] === '\r')
      ) {
        j++;
      }
      const nextSig = json[j];
      if (nextSig === undefined || STRUCTURAL_AFTER_STRING.has(nextSig)) {
        out += '"'; // genuine terminator
        inString = false;
      } else {
        out += '\\"'; // inner quote the model forgot to escape
      }
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      // Raw control char inside a string is invalid JSON — escape it.
      out +=
        { 8: '\\b', 9: '\\t', 10: '\\n', 12: '\\f', 13: '\\r' }[code] ??
        `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    out += ch;
  }
  return out;
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

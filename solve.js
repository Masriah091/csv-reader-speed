// csv-reader-speed-01 — entry for @maseiah990 (GitHub: Masriah091)
//
// Architecture: a regular-expression tokenizer driving a small state machine.
//
// Optimisation pass: the tokenizer now uses one sticky RegExp PER STATE, and
// each pattern is shaped so the common case is matched in as few, as large
// tokens as possible — the per-exec call and match-array allocation are the
// dominant cost, so the win comes from making fewer, bigger tokens:
//
//   FIELD (unquoted state): /[^,\r\n]*(?:,|\r\n|\n|\r)/y
//     One exec matches a WHOLE clean field plus its terminator as a single
//     token: the run alternative includes '"' (a quote mid-field is literal),
//     so it stops only at a real delimiter, and the terminator rides along in
//     the same match — ~1 token per field instead of ~2. The terminator is
//     identified from the token's last character (a trailing '\n' preceded
//     by '\r' is a CRLF; a trailing lone '\r' is a stray CR, which is dropped
//     with an error and the scan continues). At end of text the pattern
//     cannot match (no terminator remains), the exec fails, and the rest of
//     the text is the field — a failed sticky exec() resets lastIndex to 0,
//     so the scan position is kept in a local (`pos`) that a failed exec
//     never touches.
//
//   LINE (record fast path): /[^"\r\n]*(?:\r\n|\n|$)/y
//     A whole quote-free, lone-CR-free line plus its terminator as ONE
//     token — one exec per record, fields from the native split of the
//     token. A quote or lone CR anywhere in the line makes the match fail
//     outright and the record falls back to the field state machine.
//
//   QTOK (in-quoted state): /[^"\r]+|""|"|\r\n|\r/y
//     The run alternative is [^"\r]+: inside quotes, commas and LFs are
//     payload, so they are swallowed in the same bite as the surrounding
//     text instead of cutting the run at every comma. LFs inside a matched
//     run stay LFs in the value; the line counter is advanced by counting
//     the LFs in the run with native indexOf hops. CRs still end a run:
//     a CRLF or a lone CR inside quotes each read as one LF.
//
// The parser keeps the original three field states — unquoted, in-quoted,
// and after-quote — and field values are still assembled from whole matched
// token strings, never character by character. A clean field is a single
// token used directly (no parts array, no join); parts arrays appear only
// for quoted fields and for the rare stray-CR / junk continuations. The
// cheap one-character decisions (opening quote, blank-line skip, the token
// after a closing quote) are made from the character at `pos` directly,
// which is exactly the token the shared pattern would have produced there.
//
// Deliberate re-reads, as in the original semantics:
//   - a field that opens with `""` has only its first quote consumed as the
//     opening quote (`pos` rewound to start + 1), so the second quote is
//     re-read inside the quoted field;
//   - a quoted field that never closes rewinds `pos` to just after its
//     opening quote and restores the line counter, so the text is re-read
//     as an unquoted field whose first character is a literal quote.
//
// run() keeps no state between calls: every counter and collection is a
// local, and the module-level regexes have their lastIndex explicitly set
// from `pos` before every exec.

const FIELD = /[^,\r\n]*(?:,|\r\n|\n|\r)/y;
const QTOK = /[^"\r]+|""|"|\r\n|\r/y;
const LINE = /[^"\r\n]*(?:\r\n|\n|$)/y;

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let line = 1; // the line the next token sits on
  let recordLine = 1; // the line the current record starts on
  let recordRow = null; // the current record's index in rows (null: the header)

  // The scan position. A U+FEFF at the very start of the text is dropped.
  // Kept in a local (not in any regex's lastIndex) because a failed sticky
  // exec() resets lastIndex to 0 — `pos` survives a failed exec untouched.
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Unquoted scan returning the field value directly. A clean field is one
  // FIELD token; the accumulation path is taken only when a stray CR splits
  // the field into chunks. Returns the value and how the field ended.
  function scanUnquotedValue() {
    let acc = null;
    for (;;) {
      const save = pos;
      FIELD.lastIndex = pos;
      const m = FIELD.exec(text);
      if (m === null) {
        // No terminator remains: the rest of the text is the field.
        const rest = save < text.length ? text.slice(save) : '';
        pos = text.length;
        return { value: acc === null ? rest : acc + rest, ended: END };
      }
      pos = FIELD.lastIndex;
      const t = m[0];
      const last = t.charCodeAt(t.length - 1);
      if (last === 44) { // ','
        const v = t.length === 1 ? '' : t.slice(0, -1);
        return { value: acc === null ? v : acc + v, ended: COMMA };
      }
      if (last === 10) { // '\n' (possibly the tail of a CRLF)
        line += 1;
        const crlf = t.length >= 2 && t.charCodeAt(t.length - 2) === 13;
        const v = crlf
          ? (t.length === 2 ? '' : t.slice(0, -2))
          : (t.length === 1 ? '' : t.slice(0, -1));
        return { value: acc === null ? v : acc + v, ended: LINE_BREAK };
      }
      // A trailing lone CR: dropped with a stray_cr error; the field goes on.
      pushError('stray_cr');
      const v = t.length === 1 ? '' : t.slice(0, -1);
      acc = acc === null ? v : acc + v;
    }
  }

  // Unquoted scan appending chunks to an existing `parts` array (the
  // after-quote junk continuation). Returns how the field ended and how
  // many characters were kept (`added`).
  function scanUnquotedParts(parts) {
    let added = 0;
    for (;;) {
      const save = pos;
      FIELD.lastIndex = pos;
      const m = FIELD.exec(text);
      if (m === null) {
        if (save < text.length) {
          const rest = text.slice(save);
          parts.push(rest);
          added += rest.length;
        }
        pos = text.length;
        return { ended: END, added };
      }
      pos = FIELD.lastIndex;
      const t = m[0];
      const last = t.charCodeAt(t.length - 1);
      if (last === 44) { // ','
        if (t.length > 1) {
          const v = t.slice(0, -1);
          parts.push(v);
          added += v.length;
        }
        return { ended: COMMA, added };
      }
      if (last === 10) { // '\n' (possibly the tail of a CRLF)
        line += 1;
        const crlf = t.length >= 2 && t.charCodeAt(t.length - 2) === 13;
        const n = crlf ? t.length - 2 : t.length - 1;
        if (n > 0) {
          const v = t.slice(0, n);
          parts.push(v);
          added += v.length;
        }
        return { ended: LINE_BREAK, added };
      }
      // A trailing lone CR: dropped with a stray_cr error; the field goes on.
      pushError('stray_cr');
      if (t.length > 1) {
        const v = t.slice(0, -1);
        parts.push(v);
        added += v.length;
      }
    }
  }

  function joinParts(parts) {
    return parts.length === 0 ? '' : parts.length === 1 ? parts[0] : parts.join('');
  }

  // Reads one field starting at `pos`.
  function readField() {
    const start = pos;

    if (text.charCodeAt(pos) === 34) { // '"'
      // Quoted field. Consume exactly the one opening quote: if the text
      // opened with the pair `""`, the second quote is re-read as part of
      // the quoted body, exactly as the reference semantics require.
      pos = start + 1;
      const openLine = line;
      const parts = [];
      let closed = false;
      for (;;) {
        QTOK.lastIndex = pos;
        const m = QTOK.exec(text);
        if (m === null) break;
        pos = QTOK.lastIndex;
        const t = m[0];
        if (t === '"') {
          closed = true;
          break;
        }
        if (t === '""') {
          parts.push('"');
          continue;
        }
        if (t === '\r\n' || t === '\r') {
          // CRLF and a lone CR inside quotes each read as one LF.
          parts.push('\n');
          line += 1;
          continue;
        }
        // A run of payload text (commas and LFs included). LFs in the run
        // stay in the value; count them for the line counter.
        let nl = t.indexOf('\n');
        if (nl !== -1) {
          line += 1;
          while ((nl = t.indexOf('\n', nl + 1)) !== -1) line += 1;
        }
        parts.push(t);
      }
      if (!closed) {
        // The quote never closes: the opening quote is a literal character
        // and the text after it is re-read as an unquoted field. Newlines
        // seen during the aborted quote scan do not count.
        pos = start + 1;
        line = openLine;
        pushError('unterminated_quote');
        const r = scanUnquotedValue();
        return { value: '"' + r.value, ended: r.ended, quoted: true };
      }
      // After the closing quote, the character at `pos` decides how the
      // field ends.
      if (pos >= text.length) return { value: joinParts(parts), ended: END, quoted: true };
      const after = text.charCodeAt(pos);
      if (after === 44) { // ','
        pos += 1;
        return { value: joinParts(parts), ended: COMMA, quoted: true };
      }
      if (after === 10) { // '\n'
        pos += 1;
        line += 1;
        return { value: joinParts(parts), ended: LINE_BREAK, quoted: true };
      }
      if (after === 13 && text.charCodeAt(pos + 1) === 10) { // '\r\n'
        pos += 2;
        line += 1;
        return { value: joinParts(parts), ended: LINE_BREAK, quoted: true };
      }
      // Anything else is junk: it is read as an unquoted continuation
      // appended to the quoted value (stray CRs in it dropped with errors),
      // and reported as quote_junk if it kept at least one character.
      const junk = scanUnquotedParts(parts);
      if (junk.added > 0) pushError('quote_junk');
      return { value: joinParts(parts), ended: junk.ended, quoted: true };
    }

    const r = scanUnquotedValue();
    return { value: r.value, ended: r.ended, quoted: false };
  }

  // Applies the record-level rules (blank/stray-only lines, header capture,
  // width fixing with short_row / long_row errors) to one parsed record.
  function processRecord(fields, lastQuoted) {
    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay). A quoted empty field IS a record.
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) return;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    for (;;) {
      const c = text.charCodeAt(pos);
      if (c === 10) { // '\n'
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) { // '\r\n'
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= text.length) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Record-level fast path: a line containing no '"' and no lone CR is
    // one whole record. LINE matches the entire line plus its terminator
    // as a single token — one exec per record instead of one per field —
    // and the fields come from the native split of that token. If the line
    // contains a quote or a lone CR the match fails outright (the run
    // stops there and no terminator alternative fits), `pos` is untouched,
    // and the record is read by the field state machine below.
    LINE.lastIndex = pos;
    const lm = LINE.exec(text);
    if (lm !== null) {
      pos = LINE.lastIndex;
      const t = lm[0];
      let content = t;
      if (t.endsWith('\r\n')) {
        content = t.slice(0, -2);
        line += 1;
      } else if (t.endsWith('\n')) {
        content = t.slice(0, -1);
        line += 1;
      }
      processRecord(content.split(','), false);
      continue;
    }

    const fields = [];
    let field;
    let lastQuoted = false;
    do {
      field = readField();
      fields.push(field.value);
      lastQuoted = field.quoted;
    } while (field.ended === COMMA);

    processRecord(fields, lastQuoted);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// Self-warmup: at import time, run a small synthetic input that exercises
// every code path — quoted fields with doubled quotes, CRLF and a lone CR
// inside quotes, junk after a closing quote, a stray CR in an unquoted
// field, short and long rows, blank lines, a CR-only line, a quoted empty
// field, and an unterminated quote (kept last, with no quote after it) —
// under both header modes, so the hot loops are compiled before the first
// real case arrives. Results are discarded.
const WARM_TEXT =
  'name,note,val\r\n' +
  '"a""b","x\r\ny\rz",1\n' +
  '\n' +
  '\r\n' +
  'ab\rcd,"q"junk,2\r\n' +
  'short\n' +
  'long,row,extra,fields\n' +
  '"",x,3\n' +
  '\r\r\n' +
  'alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,kappa,lambda,mu\n' +
  '101,202,303,404,505,606,707,808,909,111,222,333\r\n' +
  '"open,never closed\nmore text';
for (let i = 0; i < 40; i++) {
  run({ text: WARM_TEXT, header: i % 2 === 0 });
}

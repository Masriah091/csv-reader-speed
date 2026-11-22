[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Masriah091/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Masriah091/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# CSV Reader Speed — a regex-tokenizer CSV reader

An entry for the make.fun bounty **csv-reader-speed-01-run-20261121**: a CSV
reader that reproduces the csv-reader 1.0.0 semantics exactly — the header
row, every record padded or cut to the first record's width, and an error
list covering stray carriage returns, junk after a closing quote,
unterminated quotes, and short and long rows — while scanning the text as
fast as a single regular expression can feed it.

## How it works

Instead of walking the input one character at a time, `solve.js` tokenizes
it with **one sticky global RegExp**. The pattern's alternatives are ordered
so the first one — a run of characters that are not a comma, quote, CR or
LF — swallows ordinary field text in a single big bite, and each remaining
alternative names one structural token: a doubled quote `""`, a lone quote,
a comma, a CRLF pair, an LF, or a lone CR. A small state machine consumes
the token stream with `exec()`: it is either in an unquoted field, inside a
quoted field, or just past a closing quote deciding how that field ends.
Field values are never built character by character; whole matched token
strings are pushed onto a per-field parts array and joined once when the
field ends.

Two spots in the machine deliberately move the regex's `lastIndex`
backwards by a token boundary, which is where the subtle semantics live. A
field whose first token is the pair `""` has only its first quote consumed
as the opening quote, so the second quote is re-read inside the quoted
field. And a quoted field that never closes rewinds the scan to just after
its opening quote, restores the line counter to what it was at the quote,
and re-reads the text as an unquoted field whose first character is a
literal quote — matching the reference behaviour, including which errors
are emitted and in what order.

`main.ts` is a thin driver: it reads `cases.json` from the input directory,
answers each case with `run()`, and writes `answers.json` to the output
directory, stringifying one case at a time so the answer graphs never all
sit on the heap at once (the resulting file is byte-identical to
stringifying the whole array). Directory paths come from the
`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` environment variables, defaulting
to `/input` and `/output`.

At import time `solve.js` also warms itself up: it runs a small synthetic
input — built to touch every branch: doubled quotes, CRLF and lone CR
inside quotes, junk after a closing quote, stray CRs, blank lines, short
and long rows, an unterminated quote — a few dozen times under both header
modes and discards the results, so the tokenizer loop is already compiled
when the first real case arrives.

## Layout

- `solve.js` — the parser: `run({text, header})` → `{columns, rows, errors}`
- `main.ts` — the harness driver described above
- `package.json` — `{"type": "module"}`

## License

MIT — see `LICENSE`.

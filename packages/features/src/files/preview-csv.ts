export type CsvTable = {
  /** Rows as split by the delimiter, blank lines dropped. */
  readonly rows: readonly (readonly string[])[];
  /** The row count before any display cap, so a capped table can say how much it hides. */
  readonly rowCount: number;
};

/**
 * RFC 4180-style split for preview: quoted fields keep delimiters, doubled quotes and line
 * breaks; anything ambiguous is kept as text rather than rejected, because a preview guesses
 * rather than claims to know the file's grammar.
 */
export function parseCsv(text: string, delimiter = ","): CsvTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  function endRow() {
    row.push(field);

    // A row is blank only when every field is empty and it is the only field.
    if (row.length > 1 || row[0] !== "") rows.push(row);

    row = [];
    field = "";
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }

      continue;
    }

    // Opening quotes count only at a field start; elsewhere a quote is ordinary text.
    if (char === '"' && field === "") {
      quoted = true;
      continue;
    }

    if (char === delimiter) {
      row.push(field);
      field = "";
      continue;
    }

    if (char === "\n") {
      endRow();
      continue;
    }

    if (char === "\r") {
      if (text[index + 1] === "\n") index += 1;
      endRow();
      continue;
    }

    field += char;
  }

  // A final field without its line break, and an unterminated quote in a truncated file,
  // both close as what was read.
  endRow();

  return { rows, rowCount: rows.length };
}

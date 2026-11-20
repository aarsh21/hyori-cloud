import { expect, test } from "bun:test";
import { parseCsv } from "#features/files/preview-csv.ts";

test("plain rows split on the delimiter", () => {
  expect(parseCsv("name,size\nbudget.pdf,120\n")).toEqual({
    rows: [
      ["name", "size"],
      ["budget.pdf", "120"],
    ],
    rowCount: 2,
  });
});

test("quoted fields keep delimiters, breaks and doubled quotes", () => {
  expect(parseCsv('"a,b","say ""hi"""\n"line\nbreak",x')).toEqual({
    rows: [
      ["a,b", 'say "hi"'],
      ["line\nbreak", "x"],
    ],
    rowCount: 2,
  });
});

test("carriage returns end rows in either Windows or old-Mac form", () => {
  expect(parseCsv("a,b\r\nc,d\re,f").rows).toEqual([
    ["a", "b"],
    ["c", "d"],
    ["e", "f"],
  ]);
});

test("blank lines are dropped but empty fields are kept", () => {
  expect(parseCsv('a,""\n\nb,,c').rows).toEqual([
    ["a", ""],
    ["b", "", "c"],
  ]);
});

test("tabs split TSV files", () => {
  expect(parseCsv("year\tvalue\n2026\t31", "\t").rows).toEqual([
    ["year", "value"],
    ["2026", "31"],
  ]);
});

test("a quote outside a quoted field is ordinary text, and a truncated quote still closes", () => {
  expect(parseCsv('6" wrench,2').rows).toEqual([['6" wrench', "2"]]);
  expect(parseCsv('"open ended,text').rows).toEqual([["open ended,text"]]);
});

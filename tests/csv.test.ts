import test from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../api/_lib/csv';

test('quotes commas, quotes and newlines', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('l1\nl2'), '"l1\nl2"');
});

test('absent values are empty cells, never 0', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
  assert.equal(csvCell(NaN), '');
  assert.equal(csvCell(0), '0'); // a real zero stays a zero
});

test('scraped text cannot start a spreadsheet formula', () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-cmd'), "'-cmd");
});

test('negative numbers stay numeric', () => {
  assert.equal(csvCell(-12.5), '-12.5');
});

test('toCsv writes a BOM, header, CRLF rows', () => {
  const out = toCsv([{ header: 'a', value: (r: { a: number }) => r.a }, { header: 'b', value: () => null }], [{ a: 1 }, { a: 2 }]);
  assert.equal(out, '﻿a,b\r\n1,\r\n2,\r\n');
});

test('column values receive the row index, for a rank column', () => {
  const out = toCsv([{ header: 'rank', value: (_: string, i: number) => i + 1 }], ['x', 'y']);
  assert.equal(out, '﻿rank\r\n1\r\n2\r\n');
});

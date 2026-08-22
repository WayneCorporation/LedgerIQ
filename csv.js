function parseCSV(text, { maxRows = 5000 } = {}) {
  const source = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map(h => h.trim());
  const dataRows = rows.slice(1).filter(r => r.some(value => value !== ''));
  if (dataRows.length > maxRows) throw new Error(`CSV exceeds the maximum of ${maxRows} rows`);
  return {
    headers,
    rows: dataRows.map(cells => {
      const record = {};
      headers.forEach((header, index) => { record[header] = (cells[index] ?? '').trim(); });
      return record;
    }),
  };
}

module.exports = { parseCSV };

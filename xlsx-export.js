(() => {
  "use strict";

  const encoder = new TextEncoder();
  const xml = value => String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let value = n;
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      table[n] = value >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >>> 1),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function concat(parts) {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
  }

  function binaryHeader(size) {
    const bytes = new Uint8Array(size);
    return { bytes, view: new DataView(bytes.buffer) };
  }

  function zipStore(files) {
    const localParts = [];
    const centralParts = [];
    const clock = dosDateTime();
    let offset = 0;
    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
      const crc = crc32(data);
      const local = binaryHeader(30);
      local.view.setUint32(0, 0x04034b50, true);
      local.view.setUint16(4, 20, true);
      local.view.setUint16(6, 0x0800, true);
      local.view.setUint16(10, clock.time, true);
      local.view.setUint16(12, clock.date, true);
      local.view.setUint32(14, crc, true);
      local.view.setUint32(18, data.length, true);
      local.view.setUint32(22, data.length, true);
      local.view.setUint16(26, name.length, true);
      localParts.push(local.bytes, name, data);

      const central = binaryHeader(46);
      central.view.setUint32(0, 0x02014b50, true);
      central.view.setUint16(4, 20, true);
      central.view.setUint16(6, 20, true);
      central.view.setUint16(8, 0x0800, true);
      central.view.setUint16(12, clock.time, true);
      central.view.setUint16(14, clock.date, true);
      central.view.setUint32(16, crc, true);
      central.view.setUint32(20, data.length, true);
      central.view.setUint32(24, data.length, true);
      central.view.setUint16(28, name.length, true);
      central.view.setUint32(42, offset, true);
      centralParts.push(central.bytes, name);
      offset += local.bytes.length + name.length + data.length;
    }
    const centralBytes = concat(centralParts);
    const end = binaryHeader(22);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, files.length, true);
    end.view.setUint16(10, files.length, true);
    end.view.setUint32(12, centralBytes.length, true);
    end.view.setUint32(16, offset, true);
    return concat([...localParts, centralBytes, end.bytes]);
  }

  function columnName(index) {
    let result = "";
    while (index > 0) { index--; result = String.fromCharCode(65 + (index % 26)) + result; index = Math.floor(index / 26); }
    return result;
  }

  function textCell(reference, value, style = 0) {
    return `<c r="${reference}" s="${style}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
  }

  function numberCell(reference, value, style = 0) {
    if (value === "" || value == null) return textCell(reference, "", style);
    const number = Number(value);
    return Number.isFinite(number) ? `<c r="${reference}" s="${style}"><v>${number}</v></c>` : textCell(reference, "", style);
  }

  function build(records, minutesBetween) {
    const headers = [
      "FECHA", "TRABAJADOR", "LÍNEA", "MATRÍCULA", "CENTRO", "HORA INICIO", "HORA FIN", "MINUTOS",
      "KM INICIALES", "KM FINALES", "KM REALIZADOS", "PEDIDOS ONLINE", "PEDIDOS CAJA", "PEDIDOS ESPECIALES",
      "PEDIDOS TOTAL", "REPOSTADO", "KM AL REPOSTAR", "LITROS", "OBSERVACIONES"
    ];
    const headerCells = headers.map((value, index) => textCell(`${columnName(index + 1)}1`, value, 1)).join("");
    const rowData = [];
    const sorted = records.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.worker).localeCompare(String(b.worker), "es"));
    for (const record of sorted) {
      const multiple = record.center === "Varios centros";
      const details = multiple ? (record.centerLines || []) : [];
      const center = record.center === "Otras" ? (record.centerOther || "Otras") : record.center;
      const firstStart = multiple ? (details[0]?.startTime || "") : (record.morningStart || record.afternoonStart || "");
      const lastEnd = multiple ? (details.at(-1)?.endTime || "") : (record.afternoonEnd || record.morningEnd || "");
      const minutes = multiple
        ? details.reduce((total, line) => total + minutesBetween(line.startTime, line.endTime), 0)
        : minutesBetween(record.morningStart, record.morningEnd) + minutesBetween(record.afternoonStart, record.afternoonEnd);
      const distance = multiple
        ? details.reduce((total, line) => total + (Number(line.endKm) - Number(line.startKm)), 0)
        : Number(record.endKm) - Number(record.startKm);
      const onlineOrders = multiple ? details.reduce((total, line) => total + Number(line.onlineOrders || 0), 0) : Number(record.onlineOrders || 0);
      const boxOrders = multiple ? details.reduce((total, line) => total + Number(line.boxOrders || 0), 0) : Number(record.boxOrders || 0);
      const specialOrders = multiple ? details.reduce((total, line) => total + Number(line.specialOrders || 0), 0) : Number(record.specialOrders || 0);
      const hasLineOrders = details.some(line => line.onlineOrders != null || line.boxOrders != null || line.specialOrders != null);
      const summaryOnline = multiple && !hasLineOrders ? Number(record.onlineOrders || 0) : onlineOrders;
      const summaryBox = multiple && !hasLineOrders ? Number(record.boxOrders || 0) : boxOrders;
      const summarySpecial = multiple && !hasLineOrders ? Number(record.specialOrders || 0) : specialOrders;
      const totalOrders = summaryOnline + summaryBox + summarySpecial;
      rowData.push([record.date, record.worker, "RESUMEN", record.vehicle, center, firstStart, lastEnd, minutes, multiple ? "" : record.startKm, multiple ? "" : record.endKm, distance, summaryOnline, summaryBox, summarySpecial, totalOrders, record.refueled, record.refuelKm, record.refuelLiters, record.notes]);
      details.forEach((line, index) => {
        const lineCenter = line.center === "Otras" ? (line.centerOther || "Otras") : line.center;
        const lineOnline = line.onlineOrders == null ? "" : Number(line.onlineOrders || 0);
        const lineBox = line.boxOrders == null ? "" : Number(line.boxOrders || 0);
        const lineSpecial = line.specialOrders == null ? "" : Number(line.specialOrders || 0);
        const lineTotal = lineOnline === "" && lineBox === "" && lineSpecial === "" ? "" : Number(lineOnline || 0) + Number(lineBox || 0) + Number(lineSpecial || 0);
        rowData.push([record.date, record.worker, index + 1, record.vehicle, lineCenter, line.startTime, line.endTime, minutesBetween(line.startTime, line.endTime), line.startKm, line.endKm, Number(line.endKm) - Number(line.startKm), lineOnline, lineBox, lineSpecial, lineTotal, "", "", "", ""]);
      });
    }
    const numericColumns = new Set([8, 9, 10, 11, 12, 13, 14, 15, 17, 18]);
    const rows = rowData.map((values, index) => {
        const row = index + 2;
        const cells = values.map((value, cellIndex) => {
          const ref = `${columnName(cellIndex + 1)}${row}`;
          return numericColumns.has(cellIndex + 1) ? numberCell(ref, value) : textCell(ref, value);
        }).join("");
        return `<row r="${row}">${cells}</row>`;
      }).join("");

    const lastRow = Math.max(1, rowData.length + 1);
    const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="13" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/><col min="3" max="3" width="12" customWidth="1"/><col min="4" max="5" width="21" customWidth="1"/><col min="6" max="18" width="17" customWidth="1"/><col min="19" max="19" width="40" customWidth="1"/></cols><sheetData><row r="1" ht="32" customHeight="1">${headerCells}</row>${rows}</sheetData><autoFilter ref="A1:S${lastRow}"/></worksheet>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF006B61"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
    const files = [
      { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
      { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Erdella Express" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: "xl/worksheets/sheet1.xml", data: worksheet },
      { name: "xl/styles.xml", data: styles }
    ];
    return new Blob([zipStore(files)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function download(records, fileName, minutesBetween) {
    const url = URL.createObjectURL(build(records, minutesBetween));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.ExpressXlsx = { build, download };
})();

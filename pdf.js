const PDFDocument = require('pdfkit');

const STANDARD_FONTS = {
  sans: { regular: 'Helvetica', bold: 'Helvetica-Bold' },
  serif: { regular: 'Times-Roman', bold: 'Times-Bold' },
  mono: { regular: 'Courier', bold: 'Courier-Bold' }
};

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || '');
  return match ? { mime: match[1], buffer: Buffer.from(match[2], 'base64') } : null;
}

function initials(name) {
  return String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0] ? w[0].toUpperCase() : '').join('') || '?';
}

// Renders one invoice/quote/business-document as a PDF, streamed directly to `res`.
function renderDocumentPdf(res, { kind, number, issueDate, secondaryLabel, secondaryDate, status, company, party, items = [], discount = 0, taxRate = 0, currency, notes, paymentDetails }) {
  const fonts = STANDARD_FONTS[company.invoiceFont] || STANDARD_FONTS.sans;
  const accent = /^#[0-9a-fA-F]{6}$/.test(company.invoiceAccentColor || '') ? company.invoiceAccentColor : '#5b5fef';
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  let headerX = 50;
  const logo = parseDataUrl(company.logo);
  if (logo && (logo.mime === 'image/png' || logo.mime === 'image/jpeg')) {
    try { doc.image(logo.buffer, 50, 45, { fit: [56, 56] }); headerX = 118; } catch { headerX = 50; }
  }
  if (headerX === 50) {
    doc.save(); doc.roundedRect(50, 45, 44, 44, 8).fill(accent);
    doc.fillColor('#fff').font(fonts.bold).fontSize(15).text(initials(company.companyName), 50, 60, { width: 44, align: 'center' });
    doc.restore();
    headerX = 110;
  }
  doc.fillColor('#111').font(fonts.bold).fontSize(16).text(company.companyName || '', headerX, 48, { width: 230 });
  doc.fillColor('#555').font(fonts.regular).fontSize(9)
    .text([company.address, company.email, company.phone].filter(Boolean).join('\n'), headerX, 68, { width: 230 });

  doc.fillColor(accent).font(fonts.bold).fontSize(22).text(kind, 350, 48, { width: 195, align: 'right' });
  doc.fillColor('#333').font(fonts.regular).fontSize(10);
  doc.text(`# ${number}`, 350, 78, { width: 195, align: 'right' });
  doc.text(`Issued ${issueDate || ''}`, 350, 94, { width: 195, align: 'right' });
  if (secondaryLabel) doc.text(`${secondaryLabel} ${secondaryDate || ''}`, 350, 110, { width: 195, align: 'right' });
  if (status) doc.fillColor(accent).font(fonts.bold).text(String(status).toUpperCase(), 350, 126, { width: 195, align: 'right' });

  doc.moveTo(50, 150).lineTo(545, 150).strokeColor(accent).lineWidth(1.5).stroke();

  doc.fillColor('#888').font(fonts.regular).fontSize(9).text(((party && party.label) || 'To').toUpperCase(), 50, 165);
  doc.fillColor('#111').font(fonts.bold).fontSize(11).text((party && party.name) || '—', 50, 180);
  const partyLines = [party && party.address, party && party.email, party && party.vat_number].filter(Boolean);
  if (partyLines.length) doc.fillColor('#555').font(fonts.regular).fontSize(9).text(partyLines.join('\n'), 50, 196, { width: 300 });

  let y = 250;
  const col = { desc: 50, qty: 320, rate: 390, amount: 470 };
  doc.fillColor('#888').font(fonts.bold).fontSize(9);
  doc.text('DESCRIPTION', col.desc, y);
  doc.text('QTY', col.qty, y);
  doc.text('RATE', col.rate, y);
  doc.text('AMOUNT', col.amount, y, { width: 75, align: 'right' });
  y += 16;
  doc.moveTo(50, y).lineTo(545, y).strokeColor('#ddd').lineWidth(1).stroke();
  y += 10;

  let subtotal = 0;
  doc.font(fonts.regular).fontSize(10).fillColor('#222');
  for (const item of items) {
    const qty = Number(item.qty || item.quantity || 0), rate = Number(item.rate || 0), amount = qty * rate;
    subtotal += amount;
    if (y > 700) { doc.addPage(); y = 50; }
    const rowHeight = doc.heightOfString(item.description || '', { width: 260 }) + 8;
    doc.text(item.description || '', col.desc, y, { width: 260 });
    doc.text(`${qty}${item.unit ? ' ' + item.unit : ''}`, col.qty, y, { width: 60 });
    doc.text(rate.toFixed(2), col.rate, y, { width: 70 });
    doc.text(amount.toFixed(2), col.amount, y, { width: 75, align: 'right' });
    y += Math.max(rowHeight, 18);
  }
  if (!items.length) { doc.fillColor('#999').text('No line items', col.desc, y); y += 20; }

  y += 10;
  doc.moveTo(320, y).lineTo(545, y).strokeColor('#ddd').stroke();
  y += 10;

  const discounted = Math.max(0, subtotal - Number(discount || 0));
  const tax = discounted * Number(taxRate || 0) / 100;
  const total = discounted + tax;
  function totalRow(label, value, bold) {
    doc.font(bold ? fonts.bold : fonts.regular).fontSize(bold ? 12 : 10).fillColor(bold ? '#111' : '#555');
    doc.text(label, 350, y, { width: 120 });
    doc.text(`${currency || ''} ${value.toFixed(2)}`, 470, y, { width: 75, align: 'right' });
    y += bold ? 22 : 16;
  }
  totalRow('Subtotal', subtotal);
  if (Number(discount || 0) > 0) totalRow('Discount', -Number(discount));
  if (Number(taxRate || 0) > 0) totalRow(`Tax (${taxRate}%)`, tax);
  totalRow('Total', total, true);

  if (paymentDetails || notes) {
    y += 20;
    if (y > 680) { doc.addPage(); y = 50; }
    if (paymentDetails) {
      doc.font(fonts.bold).fontSize(9).fillColor('#888').text('PAYMENT DETAILS', 50, y); y += 14;
      doc.font(fonts.regular).fontSize(9).fillColor('#333').text(paymentDetails, 50, y, { width: 495 });
      y += doc.heightOfString(paymentDetails, { width: 495 }) + 14;
    }
    if (notes) {
      doc.font(fonts.bold).fontSize(9).fillColor('#888').text('NOTES', 50, y); y += 14;
      doc.font(fonts.regular).fontSize(9).fillColor('#333').text(notes, 50, y, { width: 495 });
    }
  }

  doc.end();
}

module.exports = { renderDocumentPdf };

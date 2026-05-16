const { PurchaseOrder, GRN, Invoice, MatchResult } = require('../models');

function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return d;

  const parts = dateStr.split(/[\/\-]/);
  if (parts.length === 3) {
    const [a, b, c] = parts.map(Number);
    if (a > 12) {
      const attempt = new Date(c, b - 1, a);
      if (!isNaN(attempt.getTime())) return attempt;
    }
  }
  return null;
}

function normaliseKey(code) {
  return String(code || '').trim().toLowerCase().replace(/[-_\s]+/g, '');
}

function aggregateGrnQty(grns) {
  const map = new Map();
  for (const grn of grns) {
    for (const item of grn.items || []) {
      const key = normaliseKey(item.itemCode);
      map.set(key, (map.get(key) || 0) + (item.receivedQuantity || 0));
    }
  }
  return map;
}

async function runMatch(poNumber) {
  const po = await PurchaseOrder.findOne({ poNumber });
  const grns = await GRN.find({ poNumber });
  const invoices = await Invoice.find({ poNumber });

  const hasPO = !!po;
  const hasGRN = grns.length > 0;
  const hasInvoice = invoices.length > 0;

  // Duplicate PO guard
  const allPOs = await PurchaseOrder.find({ poNumber });
  if (allPOs.length > 1) {
    return MatchResult.findOneAndUpdate(
      { poNumber },
      { poNumber, hasPO, hasGRN, hasInvoice, status: 'mismatch', reasons: ['duplicate_po'], itemResults: [], lastUpdated: new Date() },
      { upsert: true, new: true }
    );
  }

  // Insufficient documents
  if (!hasPO || !hasGRN || !hasInvoice) {
    const missing = [];
    if (!hasPO) missing.push('PO');
    if (!hasGRN) missing.push('GRN');
    if (!hasInvoice) missing.push('Invoice');
    return MatchResult.findOneAndUpdate(
      { poNumber },
      { poNumber, hasPO, hasGRN, hasInvoice, status: 'insufficient_documents', reasons: [`Waiting for: ${missing.join(', ')}`], itemResults: [], lastUpdated: new Date() },
      { upsert: true, new: true }
    );
  }

  // Full three-way match
  const poDateParsed = parseDate(po.poDate);
  const globalReasons = [];
  const itemResults = [];

  const poItemMap = new Map();
  for (const item of po.items || []) {
    poItemMap.set(normaliseKey(item.itemCode), item);
  }

  const grnQtyMap = aggregateGrnQty(grns);

  const invoiceItemMap = new Map();
  for (const inv of invoices) {
    const invDate = parseDate(inv.invoiceDate);
    if (poDateParsed && invDate && invDate > poDateParsed) {
      globalReasons.push(`invoice_date_after_po_date (invoice ${inv.invoiceNumber})`);
    }
    for (const item of inv.items || []) {
      const key = normaliseKey(item.itemCode);
      invoiceItemMap.set(key, (invoiceItemMap.get(key) || 0) + (item.quantity || 0));
    }
  }

  let hasAnyMismatch = false;
  let hasAnyMatch = false;

  for (const [key, poItem] of poItemMap) {
    const poQty = poItem.quantity || 0;
    const grnQty = grnQtyMap.get(key) || 0;
    const invoiceQty = invoiceItemMap.get(key) || 0;
    const issues = [];

    if (grnQty > poQty) issues.push('grn_qty_exceeds_po_qty');
    if (invoiceQty > poQty) issues.push('invoice_qty_exceeds_po_qty');
    if (invoiceQty > grnQty) issues.push('invoice_qty_exceeds_grn_qty');
    if (invoiceQty > 0 && grnQty === 0) issues.push('item_not_received_in_grn');

    const itemStatus = issues.length === 0 ? 'matched' : 'mismatch';
    if (itemStatus === 'mismatch') hasAnyMismatch = true;
    if (itemStatus === 'matched') hasAnyMatch = true;

    itemResults.push({
      itemCode: poItem.itemCode,
      description: poItem.description,
      poQty,
      grnQty,
      invoiceQty,
      status: itemStatus,
      issues,
    });
  }

  // Items in invoice not in PO
  for (const [key, invoiceQty] of invoiceItemMap) {
    if (!poItemMap.has(key)) {
      globalReasons.push(`item_missing_in_po (key: ${key})`);
      hasAnyMismatch = true;
      itemResults.push({
        itemCode: key,
        description: '(not in PO)',
        poQty: 0,
        grnQty: grnQtyMap.get(key) || 0,
        invoiceQty,
        status: 'mismatch',
        issues: ['item_missing_in_po'],
      });
    }
  }

  const allReasons = [...globalReasons, ...itemResults.flatMap((r) => r.issues)];
  let status;
  if (allReasons.length === 0) status = 'matched';
  else if (hasAnyMatch && hasAnyMismatch) status = 'partially_matched';
  else status = 'mismatch';

  return MatchResult.findOneAndUpdate(
    { poNumber },
    { poNumber, hasPO, hasGRN, hasInvoice, status, reasons: allReasons, itemResults, lastUpdated: new Date() },
    { upsert: true, new: true }
  );
}

module.exports = { runMatch };
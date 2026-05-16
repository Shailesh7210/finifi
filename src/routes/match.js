const express = require('express');
const { PurchaseOrder, GRN, Invoice } = require('../models');
const { runMatch } = require('../services/matchingEngine');

const router = express.Router();

// GET /match/:poNumber
router.get('/:poNumber', async (req, res, next) => {
  try {
    const { poNumber } = req.params;
    const matchResult = await runMatch(poNumber);

    const po = await PurchaseOrder.findOne({ poNumber });
    const grns = await GRN.find({ poNumber });
    const invoices = await Invoice.find({ poNumber });

    res.json({
      poNumber,
      matchStatus: matchResult.status,
      reasons: matchResult.reasons,
      documents: {
        po: po ? { id: po._id, poDate: po.poDate, vendorName: po.vendorName, totalAmount: po.totalAmount, itemCount: po.items?.length } : null,
        grns: grns.map((g) => ({ id: g._id, grnNumber: g.grnNumber, grnDate: g.grnDate, totalReceivedQty: g.totalReceivedQty, itemCount: g.items?.length })),
        invoices: invoices.map((i) => ({ id: i._id, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate, totalAmount: i.totalAmount, itemCount: i.items?.length })),
      },
      itemResults: matchResult.itemResults,
      lastUpdated: matchResult.lastUpdated,
    });
  } catch (err) {
    next(err);
  }
});

// POST /match/:poNumber/rerun
router.post('/:poNumber/rerun', async (req, res, next) => {
  try {
    const { poNumber } = req.params;
    const matchResult = await runMatch(poNumber);
    res.json({ poNumber, matchStatus: matchResult.status, reasons: matchResult.reasons });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
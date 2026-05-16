const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema(
  {
    itemCode: { type: String, required: true },
    description: { type: String },
    quantity: { type: Number },
    receivedQuantity: { type: Number },
    unitPrice: { type: Number },
    taxableValue: { type: Number },
    hsnCode: { type: String },
    mrp: { type: Number },
  },
  { _id: false }
);

const poSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    poNumber: { type: String, required: true, index: true },
    poDate: { type: String },
    vendorName: { type: String },
    vendorGstin: { type: String },
    buyerName: { type: String },
    paymentTerms: { type: String },
    expectedDeliveryDate: { type: String },
    items: [itemSchema],
    totalAmount: { type: Number },
    rawExtracted: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

const grnSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    grnNumber: { type: String, required: true },
    poNumber: { type: String, required: true, index: true },
    grnDate: { type: String },
    invoiceNumber: { type: String },
    vendorName: { type: String },
    items: [itemSchema],
    totalReceivedQty: { type: Number },
    rawExtracted: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

const invoiceSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Document' },
    invoiceNumber: { type: String, required: true },
    poNumber: { type: String, required: true, index: true },
    invoiceDate: { type: String },
    vendorName: { type: String },
    vendorGstin: { type: String },
    items: [itemSchema],
    totalAmount: { type: Number },
    totalTax: { type: Number },
    rawExtracted: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

const documentSchema = new mongoose.Schema(
  {
    filename: { type: String },
    originalName: { type: String },
    documentType: { type: String, enum: ['po', 'grn', 'invoice'], required: true },
    poNumber: { type: String, index: true },
    parseStatus: { type: String, enum: ['pending', 'parsed', 'failed'], default: 'pending' },
    parseError: { type: String },
    parsedData: { type: mongoose.Schema.Types.Mixed },
    typedDocumentId: { type: mongoose.Schema.Types.ObjectId },
  },
  { timestamps: true }
);

const matchResultSchema = new mongoose.Schema(
  {
    poNumber: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ['matched', 'partially_matched', 'mismatch', 'insufficient_documents'],
      default: 'insufficient_documents',
    },
    hasPO: { type: Boolean, default: false },
    hasGRN: { type: Boolean, default: false },
    hasInvoice: { type: Boolean, default: false },
    reasons: [{ type: String }],
    itemResults: [
      {
        itemCode: String,
        description: String,
        poQty: Number,
        grnQty: Number,
        invoiceQty: Number,
        status: String,
        issues: [String],
      },
    ],
    lastUpdated: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const Document = mongoose.model('Document', documentSchema);
const PurchaseOrder = mongoose.model('PurchaseOrder', poSchema);
const GRN = mongoose.model('GRN', grnSchema);
const Invoice = mongoose.model('Invoice', invoiceSchema);
const MatchResult = mongoose.model('MatchResult', matchResultSchema);

module.exports = { Document, PurchaseOrder, GRN, Invoice, MatchResult };
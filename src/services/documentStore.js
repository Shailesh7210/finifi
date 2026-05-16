const { PurchaseOrder, GRN, Invoice } = require('../models');

async function storeTypedDocument(documentType, parsedData, documentId) {
  switch (documentType) {
    case 'po': {
      const doc = new PurchaseOrder({ ...parsedData, documentId });
      await doc.save();
      return doc;
    }
    case 'grn': {
      const doc = new GRN({ ...parsedData, documentId });
      await doc.save();
      return doc;
    }
    case 'invoice': {
      const doc = new Invoice({ ...parsedData, documentId });
      await doc.save();
      return doc;
    }
    default:
      throw new Error(`Unknown document type: ${documentType}`);
  }
}

function extractPoNumber(documentType, parsedData) {
  return parsedData.poNumber || null;
}

module.exports = { storeTypedDocument, extractPoNumber };
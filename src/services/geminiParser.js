const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PO_PROMPT = `
You are a document parser. Extract structured data from this Purchase Order document.
Return ONLY valid JSON (no markdown, no explanation) in exactly this shape:

{
  "poNumber": "string",
  "poDate": "string",
  "vendorName": "string",
  "vendorGstin": "string or null",
  "buyerName": "string",
  "paymentTerms": "string or null",
  "expectedDeliveryDate": "string or null",
  "totalAmount": number,
  "items": [
    {
      "itemCode": "string",
      "description": "string",
      "quantity": number,
      "unitPrice": number,
      "mrp": number or null,
      "taxableValue": number,
      "hsnCode": "string or null"
    }
  ]
}

Rules:
- itemCode must be the alphanumeric code from the table (e.g. "11423", "18004").
- quantity is the ordered quantity.
- Return numbers as numbers, not strings.
- If a field is missing, use null.
`;

const GRN_PROMPT = `
You are a document parser. Extract structured data from this Goods Receipt Note (GRN).
Return ONLY valid JSON (no markdown, no explanation) in exactly this shape:

{
  "grnNumber": "string",
  "poNumber": "string",
  "grnDate": "string",
  "invoiceNumber": "string or null",
  "vendorName": "string",
  "totalReceivedQty": number,
  "items": [
    {
      "itemCode": "string",
      "description": "string",
      "receivedQuantity": number,
      "quantity": number,
      "unitPrice": number,
      "taxableValue": number,
      "hsnCode": "string or null",
      "mrp": number or null
    }
  ]
}

Rules:
- itemCode = SKU Code column value.
- receivedQuantity = Recv Qty column.
- quantity = Exp Qty column.
- Return numbers as numbers, not strings.
`;

const INVOICE_PROMPT = `
You are a document parser. Extract structured data from this Tax Invoice.
Return ONLY valid JSON (no markdown, no explanation) in exactly this shape:

{
  "invoiceNumber": "string",
  "poNumber": "string",
  "invoiceDate": "string",
  "vendorName": "string",
  "vendorGstin": "string or null",
  "totalAmount": number,
  "totalTax": number,
  "items": [
    {
      "itemCode": "string",
      "description": "string",
      "quantity": number,
      "unitPrice": number,
      "taxableValue": number,
      "hsnCode": "string or null"
    }
  ]
}

Rules:
- poNumber comes from "Customer Order No." or PO No field.
- Return numbers as numbers, not strings.
`;

function getPrompt(documentType) {
  switch (documentType) {
    case 'po': return PO_PROMPT;
    case 'grn': return GRN_PROMPT;
    case 'invoice': return INVOICE_PROMPT;
    default: throw new Error(`Unknown document type: ${documentType}`);
  }
}

function cleanJson(text) {
  return text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

async function parseDocument(filePath, documentType) {
const model = genAI.getGenerativeModel({ model: 'gemini-3.1-pro-preview' });
  const prompt = getPrompt(documentType);

  const fileBuffer = fs.readFileSync(filePath);
  const base64Data = fileBuffer.toString('base64');

  const ext = filePath.split('.').pop().toLowerCase();
  let mimeType = 'application/pdf';
  if (['jpg', 'jpeg'].includes(ext)) mimeType = 'image/jpeg';
  else if (ext === 'png') mimeType = 'image/png';

  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType, data: base64Data } },
      ]);

      const rawText = result.response.text();
      const cleaned = cleanJson(rawText);

      try {
        return JSON.parse(cleaned);
      } catch (e) {
        throw new Error(`Gemini returned invalid JSON: ${cleaned.slice(0, 300)}`);
      }

    } catch (err) {
      lastError = err;

      const is429 =
        err.message?.includes('429') ||
        err.message?.includes('Too Many Requests');

      if (is429 && attempt < MAX_RETRIES) {
        const retryMatch = err.message?.match(/retry in (\d+)/i);
        const waitSeconds = retryMatch ? parseInt(retryMatch[1]) + 2 : attempt * 15;

        console.log(
          `Gemini rate limit hit. Attempt ${attempt}/${MAX_RETRIES}. Retrying in ${waitSeconds}s...`
        );
        await new Promise((res) => setTimeout(res, waitSeconds * 1000));
      } else {
        throw new Error(`Gemini parsing failed: ${err.message}`);
      }
    }
  }

  throw new Error(
    `Gemini parsing failed after ${MAX_RETRIES} attempts: ${lastError.message}`
  );
}

module.exports = { parseDocument };
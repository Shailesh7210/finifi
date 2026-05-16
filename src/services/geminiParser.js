const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");

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
      "mrp": number,
      "taxableValue": number,
      "hsnCode": "string"
    }
  ]
}
`;

const GRN_PROMPT = `
You are a document parser. Extract structured data from this Goods Receipt Note document.
Return ONLY valid JSON (no markdown, no explanation) in exactly this shape:

{
  "grnNumber": "string",
  "poNumber": "string",
  "grnDate": "string",
  "invoiceNumber": "string",
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
      "hsnCode": "string",
      "mrp": number
    }
  ]
}
`;

const INVOICE_PROMPT = `
You are a document parser. Extract structured data from this Invoice document.
Return ONLY valid JSON (no markdown, no explanation) in exactly this shape:

{
  "invoiceNumber": "string",
  "poNumber": "string",
  "invoiceDate": "string",
  "vendorName": "string",
  "vendorGstin": "string",
  "totalAmount": number,
  "totalTax": number,
  "items": [
    {
      "itemCode": "string",
      "description": "string",
      "quantity": number,
      "unitPrice": number,
      "taxableValue": number,
      "hsnCode": "string"
    }
  ]
}
`;

function getPrompt(documentType) {
  switch (documentType) {
    case "po":
      return PO_PROMPT;

    case "grn":
      return GRN_PROMPT;

    case "invoice":
      return INVOICE_PROMPT;

    default:
      throw new Error(`Unknown document type: ${documentType}`);
  }
}

function cleanJson(text) {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

async function parseDocument(filePath, documentType) {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash"
    });

    const prompt = getPrompt(documentType);

    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString("base64");

    const ext = filePath.split(".").pop().toLowerCase();

    let mimeType = "application/pdf";

    if (["jpg", "jpeg"].includes(ext)) {
      mimeType = "image/jpeg";
    } else if (ext === "png") {
      mimeType = "image/png";
    }

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType,
          data: base64Data
        }
      }
    ]);

    const rawText = result.response.text();
    console.log("Gemini Raw Response:", rawText);

    const cleaned = cleanJson(rawText);

    let parsedData;

    try {
      parsedData = JSON.parse(cleaned);
    } catch (error) {
      throw new Error(
        `Gemini returned invalid JSON: ${cleaned.slice(0, 300)}`
      );
    }

    return parsedData;

  } catch (error) {
    throw new Error(`Gemini parsing failed: ${error.message}`);
  }
}

module.exports = { parseDocument };
const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { StringOutputParser } = require('@langchain/core/output_parsers');
const { RunnableSequence } = require('@langchain/core/runnables');
const pdfParse = require('pdf-parse');
const fs = require('fs');

// ─── LangChain Model ──────────────────────────────────────────────────────────

const model = new ChatGoogleGenerativeAI({
  model: 'gemini-2.0-flash-lite',
  apiKey: process.env.GOOGLE_API_KEY,
  maxOutputTokens: 4000,
  temperature: 0,
  maxRetries: 1, 
});

// ─── Prompts — Items Only ─────────────────────────────────────────────────────

const ITEMS_PROMPT_PO = `
Extract all line items from this Purchase Order table text.
Return ONLY a JSON array, no markdown, no explanation.

[
  {{
    "itemCode": "string (numeric SKU like 11423)",
    "description": "string",
    "quantity": number,
    "unitPrice": number,
    "mrp": number or null,
    "taxableValue": number,
    "hsnCode": "string or null"
  }}
]

Rules:
- itemCode is the numeric SKU code column.
- quantity is ordered qty column.
- Return numbers as numbers not strings.
- Return ONLY the JSON array starting with [ and ending with ].

Table text:
{table_text}
`;

const ITEMS_PROMPT_GRN = `
Extract all line items from this GRN table text.
Return ONLY a JSON array, no markdown, no explanation.

[
  {{
    "itemCode": "string (numeric SKU like 11423)",
    "description": "string",
    "receivedQuantity": number,
    "quantity": number,
    "unitPrice": number,
    "mrp": number or null,
    "taxableValue": number,
    "hsnCode": "string or null"
  }}
]

Rules:
- itemCode = SKU Code column (numeric).
- receivedQuantity = Recv Qty column.
- quantity = Exp Qty column.
- Return numbers as numbers not strings.
- Return ONLY the JSON array starting with [ and ending with ].

Table text:
{table_text}
`;

const ITEMS_PROMPT_INVOICE = `
Extract all line items from this Invoice table text.
Return ONLY a JSON array, no markdown, no explanation.

[
  {{
    "itemCode": "string",
    "description": "string",
    "quantity": number,
    "unitPrice": number,
    "taxableValue": number,
    "hsnCode": "string or null"
  }}
]

Rules:
- Return numbers as numbers not strings.
- Return ONLY the JSON array starting with [ and ending with ].

Table text:
{table_text}
`;

function getItemsPrompt(documentType) {
  switch (documentType) {
    case 'po':      return ITEMS_PROMPT_PO;
    case 'grn':     return ITEMS_PROMPT_GRN;
    case 'invoice': return ITEMS_PROMPT_INVOICE;
    default: throw new Error(`Unknown document type: ${documentType}`);
  }
}

// ─── FIX 1: Remove unnecessary sections ──────────────────────────────────────
// Removes Terms & Conditions, legal pages etc.
// This alone reduces token count by 70%+

function removeUnnecessarySections(text) {
  const stopWords = [
    'Terms And Conditions',
    'Terms & Conditions',
    'Terms and Conditions',
    'This purchase order',
    'Force Majeure',
    'TERMS AND CONDITIONS',
    'General Terms',
    'Standard Terms',
    'Authorised Signatory',
    'For and on behalf',
    'Bank Details',
    'E. & O.E',
  ];

  for (const word of stopWords) {
    const index = text.indexOf(word);
    if (index !== -1) {
      console.log(`\nTrimmed text at: "${word}" (removed ${text.length - index} chars)`);
      return text.slice(0, index);
    }
  }

  return text;
}

// ─── FIX 2 + 3: Extract header with REGEX — no AI needed ─────────────────────

function extractHeaderWithRegex(text, documentType) {
  // Helper: try multiple patterns, return first match
  const get = (patterns) => {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) return match[1].trim();
    }
    return null;
  };

  // Helper: parse number safely
  const num = (val) => parseFloat((val || '0').replace(/,/g, '')) || 0;

  switch (documentType) {

    case 'po':
      return {
        poNumber: get([
          /PO No\s*[:\-]?\s*\n?\s*(CI[\w\d]+)/i,
          /PO No\s*[:\-]\s*([\w\d]+)/i,
          /Purchase Order No\s*[:\-]\s*([\w\d]+)/i,
        ]),
        poDate: get([
          /PO Date\s*[:\-]?\s*\n?\s*([\w]+ \d+,? \d{4})/i,
          /PO Date\s*[:\-]\s*([\d\-\/]+)/i,
          /Order Date\s*[:\-]\s*([\d\-\/]+)/i,
        ]),
        vendorName: get([
          /Vendor Name\s*[:\-]\s*\n?\s*(.+?)(?:\n|$)/i,
          /M\/s\s+(.+?)(?:\n|$)/i,
          /Supplier\s*[:\-]\s*(.+?)(?:\n|$)/i,
        ]),
        vendorGstin: get([
          /GSTIN\s*[:\-]\s*([A-Z0-9]{15})/i,
          /GST No\s*[:\-]\s*([A-Z0-9]{15})/i,
        ]),
        buyerName: get([
          /(CLOUDSTORE RETAIL PRIVATE LIMITED)/i,
          /Bill To\s*[:\-]\s*(.+?)(?:\n|$)/i,
        ]) || 'CLOUDSTORE RETAIL PRIVATE LIMITED',
        paymentTerms: get([
          /Payment Terms\s*[:\-]\s*(.+?)(?:\n|$)/i,
          /Payment\s*[:\-]\s*(.+?)(?:\n|$)/i,
        ]),
        expectedDeliveryDate: get([
          /Expected Delivery Date\s*[:\-]?\s*\n?\s*([\w]+ \d+,? \d{4})/i,
          /Expected Delivery Date\s*[:\-]\s*([\d\-\/]+)/i,
          /Delivery Date\s*[:\-]\s*([\d\-\/]+)/i,
        ]),
        totalAmount: num(get([
          /Grand Total\s*\(INR\)\s*([\d,]+\.?\d*)/i,
          /Total Amount\s*[:\-]\s*([\d,]+\.?\d*)/i,
          /Grand Total\s*[:\-]\s*([\d,]+\.?\d*)/i,
        ])),
      };

    case 'grn':
      return {
        grnNumber: get([
          /GRN No\s*[:\-]\s*(CI[\w\d]+)/i,
          /GRN No\s*[:\-]\s*([\w\d]+)/i,
        ]),
        poNumber: get([
          /PO No\s*[:\-]\s*(CI[\w\d]+)/i,
          /PO No\s*[:\-]\s*([\w\d]+)/i,
        ]),
        grnDate: get([
          /GRN Date\s*[:\-]\s*([\d\-\/]+)/i,
        ]),
        invoiceNumber: get([
          /Invoice No\s*[:\-]\s*([\w\d]+)/i,
        ]),
        vendorName: get([
          /Vendor Name\s*[:\-]\s*(.+?)(?:\n|PO No|$)/i,
          /M\/s\s+(.+?)(?:\n|$)/i,
        ]),
      };

    case 'invoice':
      return {
        invoiceNumber: get([
          /Invoice No\s*[:\-]\s*([\w\d]+)/i,
          /Invoice Number\s*[:\-]\s*([\w\d]+)/i,
        ]),
        poNumber: get([
          /PO No\s*[:\-]\s*(CI[\w\d]+)/i,
          /Customer Order No\s*[:\-]\s*([\w\d]+)/i,
          /Purchase Order No\s*[:\-]\s*([\w\d]+)/i,
          /Order No\s*[:\-]\s*([\w\d]+)/i,
        ]),
        invoiceDate: get([
          /Invoice Date\s*[:\-]\s*([\d\-\/]+)/i,
          /Date\s*[:\-]\s*([\d\-\/]+)/i,
        ]),
        vendorName: get([
          /From\s*[:\-]\s*(.+?)(?:\n|$)/i,
          /Seller\s*[:\-]\s*(.+?)(?:\n|$)/i,
          /M\/s\s+(.+?)(?:\n|$)/i,
        ]),
        vendorGstin: get([
          /GSTIN\s*[:\-]\s*([A-Z0-9]{15})/i,
        ]),
        totalAmount: num(get([
          /Total Amount\s*[:\-]\s*([\d,]+\.?\d*)/i,
          /Grand Total\s*[:\-]\s*([\d,]+\.?\d*)/i,
          /Invoice Total\s*[:\-]\s*([\d,]+\.?\d*)/i,
        ])),
        totalTax: num(get([
          /Total Tax\s*[:\-]\s*([\d,]+\.?\d*)/i,
          /Tax Amount\s*[:\-]\s*([\d,]+\.?\d*)/i,
          /GST Amount\s*[:\-]\s*([\d,]+\.?\d*)/i,
        ])),
      };

    default:
      return {};
  }
}

// ─── FIX 2: Extract ONLY the items table section ──────────────────────────────
// Smart section finder — retrieves only relevant rows

function extractTableSection(text) {
  const lines = text.split('\n');

  // Patterns that indicate table header row
  const tableStartPatterns = [
    /Sr\.?\s*No/i,
    /S\.?\s*No/i,
    /SKU\s*Code/i,
    /Item\s*Code/i,
    /Sl\.?\s*No/i,
    /HSN.*Qty/i,
    /Description.*Qty/i,
  ];

  // Patterns that indicate table has ended
  const tableEndPatterns = [
    /^Total\s*[:\s]/i,
    /^Grand\s*Total/i,
    /^Sub\s*Total/i,
    /Amount\s*in\s*[Ww]ords/i,
    /Rupees/i,
    /Bank\s*Details/i,
    /Terms\s*(And|&)\s*Conditions/i,
    /Authorised\s*Signatory/i,
    /Declaration/i,
  ];

  let tableStart = -1;
  let tableEnd = lines.length;

  // Find table start line
  for (let i = 0; i < lines.length; i++) {
    if (tableStartPatterns.some(p => p.test(lines[i]))) {
      tableStart = i;
      break;
    }
  }

  // If no header found, find first numeric item row
  if (tableStart === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (/^\d{4,7}\s+\S/.test(lines[i].trim())) {
        tableStart = Math.max(0, i - 1);
        break;
      }
    }
  }

  // Find table end after table start
  if (tableStart !== -1) {
    for (let i = tableStart + 3; i < lines.length; i++) {
      if (tableEndPatterns.some(p => p.test(lines[i].trim()))) {
        tableEnd = Math.min(i + 3, lines.length);
        break;
      }
    }
  }

  // Extract only the table
  let tableText;
  if (tableStart !== -1) {
    tableText = lines.slice(tableStart, tableEnd).join('\n');
    console.log(`\nTable: lines ${tableStart}–${tableEnd} (${tableText.length} chars)`);
  } else {
    // Fallback: use whole cleaned text
    tableText = text;
    console.log('\nNo table header found — using full cleaned text as fallback');
  }

  console.log('\n---- Table Section (first 500 chars) ----');
  console.log(tableText.slice(0, 500));
  console.log('-----------------------------------------\n');

  return tableText;
}

// ─── FIX 3: Extract total with regex — no AI needed ──────────────────────────

function extractTotalWithRegex(text) {
  const patterns = [
    /Grand Total\s*\(INR\)\s*([\d,]+\.?\d*)/i,
    /Total\s*Amount\s*[:\-]\s*([\d,]+\.?\d*)/i,
    /Grand Total\s*[:\-]\s*([\d,]+\.?\d*)/i,
    /Total\s*[:\-]\s*([\d,]+\.?\d*)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return parseFloat(match[1].replace(/,/g, '')) || 0;
    }
  }

  return 0;
}

// ─── Call Gemini via LangChain with table text only ───────────────────────────

async function extractItemsWithAI(tableText, documentType) {
  const promptTemplate = getItemsPrompt(documentType);

  const prompt = PromptTemplate.fromTemplate(promptTemplate);
  const chain = RunnableSequence.from([
    prompt,
    model,
    new StringOutputParser(),
  ]);

  // Small delay before calling API
  await new Promise(res => setTimeout(res, 1500));

  const MAX_RETRIES = 1; // Fix 4: only 1 retry
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      console.log(`Calling Gemini for items (attempt ${attempt})...`);
      console.log(`Sending ${tableText.length} chars to Gemini`);

      const rawOutput = await chain.invoke({ table_text: tableText });

      console.log('\n---- Gemini Response ----');
      console.log(rawOutput.slice(0, 400));
      console.log('------------------------\n');

      // Clean response
      let cleaned = rawOutput
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

      // Extract JSON array
      const arrStart = cleaned.indexOf('[');
      const arrEnd = cleaned.lastIndexOf(']');
      if (arrStart !== -1 && arrEnd !== -1) {
        cleaned = cleaned.slice(arrStart, arrEnd + 1);
      }

      const items = JSON.parse(cleaned);

      if (!Array.isArray(items)) {
        throw new Error('Gemini did not return a valid array');
      }

      console.log(`Parsed ${items.length} items successfully`);
      return items;

    } catch (err) {
      lastError = err;

      const isRateLimit =
        err.message?.includes('429') ||
        err.message?.includes('quota') ||
        err.message?.includes('Too Many Requests');

      if (isRateLimit && attempt <= MAX_RETRIES) {
        // Read retry delay from error message
        const retryMatch = err.message?.match(/(\d+)s/);
        const waitSeconds = retryMatch
          ? parseInt(retryMatch[1]) + 5
          : 30;

        console.log(`Rate limit hit. Waiting ${waitSeconds}s before retry...`);
        await new Promise(res => setTimeout(res, waitSeconds * 1000));
      } else {
        throw new Error(`Gemini items extraction failed: ${err.message}`);
      }
    }
  }

  throw new Error(`Items extraction failed: ${lastError.message}`);
}

// ─── Merge header + AI items + regex total ────────────────────────────────────

function buildFinalResult(header, items, documentType, fullText) {
  switch (documentType) {

    case 'po': {
      // If regex didn't get total, try again on full text
      const total = header.totalAmount || extractTotalWithRegex(fullText);
      return { ...header, totalAmount: total, items };
    }

    case 'grn': {
      const totalReceivedQty = items.reduce(
        (sum, i) => sum + (i.receivedQuantity || 0), 0
      );
      return { ...header, totalReceivedQty, items };
    }

    case 'invoice': {
      const total = header.totalAmount || extractTotalWithRegex(fullText);
      return { ...header, totalAmount: total, items };
    }

    default:
      return { ...header, items };
  }
}

// ─── Main parse function ──────────────────────────────────────────────────────

async function parseDocument(filePath, documentType) {
  // Read PDF
  const fileBuffer = fs.readFileSync(filePath);
  const pdfData = await pdfParse(fileBuffer);
  const rawText = pdfData.text;

  console.log(`\nRaw PDF text: ${rawText.length} chars`);

  if (!rawText || rawText.trim().length < 30) {
    throw new Error('Could not extract text from PDF. File may be scanned/image-based.');
  }

  // ── FIX 1: Remove useless sections first ─────────────────────────────────
  const cleanedText = removeUnnecessarySections(rawText);
  console.log(`After cleanup: ${cleanedText.length} chars (was ${rawText.length})`);

  // ── FIX 3: Extract header with regex — zero API calls ────────────────────
  console.log('\nStep 1: Extracting header with regex...');
  const header = extractHeaderWithRegex(cleanedText, documentType);
  console.log('Header:', JSON.stringify(header, null, 2));

  // ── FIX 2: Smart extract only the items table ─────────────────────────────
  console.log('\nStep 2: Extracting table section...');
  const tableText = extractTableSection(cleanedText);

  // ── Send only table to Gemini — much smaller payload ─────────────────────
  console.log('\nStep 3: Sending table to Gemini...');
  const items = await extractItemsWithAI(tableText, documentType);

  // ── Merge everything ──────────────────────────────────────────────────────
  console.log('\nStep 4: Building final result...');
  const result = buildFinalResult(header, items, documentType, cleanedText);

  console.log(`\nDone. ${items.length} items, poNumber: ${result.poNumber}`);
  return result;
}

module.exports = { parseDocument };

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Data Model](#data-model)
- [Parsing Flow](#parsing-flow)
- [Smart Chunking & RAG Approach](#smart-chunking--rag-approach)
- [Matching Logic](#matching-logic)
- [Out-of-Order Upload Handling](#out-of-order-upload-handling)
- [API Reference](#api-reference)
- [Sample Parsed JSON](#sample-parsed-json)
- [Sample Match Result](#sample-match-result)
- [Assumptions](#assumptions)
- [Tradeoffs](#tradeoffs)
- [What I Would Improve With More Time](#what-i-would-improve-with-more-time)

---

## Overview

This service allows users to upload PO, GRN, and Invoice documents (PDF). Each document is:

1. Saved to disk via **Multer**
2. Text extracted locally using **pdf-parse** (no API call)
3. Cleaned — Terms & Conditions and legal pages stripped (reduces tokens by 70%+)
4. Header fields extracted using **regex** (zero API calls)
5. Only the items table sent to **Google Gemini** via **LangChain** (minimal tokens)
6. Structured JSON stored in **MongoDB**
7. Three-way match automatically triggered for the linked `poNumber`

The match result is always available at `GET /match/:poNumber` regardless of document upload order.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express.js |
| Database | MongoDB + Mongoose |
| AI Model | Google Gemini 2.0 Flash Lite (via LangChain) |
| LangChain | @langchain/google-genai, @langchain/core |
| PDF Parsing | pdf-parse (local, no API) |
| File Upload | Multer |
| Environment | dotenv |

---

## Project Structure

```
three-way-match/
├── src/
│   ├── index.js                    # App entry point, MongoDB connection
│   ├── models/
│   │   └── index.js                # All Mongoose schemas
│   ├── routes/
│   │   ├── documents.js            # Upload and fetch document APIs
│   │   └── match.js                # Match result APIs
│   ├── services/
│   │   ├── geminiParser.js         # Smart parsing: regex + LangChain + Gemini
│   │   ├── matchingEngine.js       # Three-way match logic
│   │   └── documentStore.js        # Save parsed data to typed collections
│   └── middleware/
│       └── errorHandler.js         # Global error handler
├── uploads/                        # Uploaded files saved here (auto-created)
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js >= 18
- MongoDB >= 6 (local or Atlas)
- Google AI API Key — free at [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)

### Installation

```bash
# 1. Clone the repo
git clone https://github.com/your-username/three-way-match.git
cd three-way-match

# 2. Install dependencies
npm install

# 3. Set up environment
cp .env.example .env
```

Edit `.env`:

```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/three-way-match
GOOGLE_API_KEY=your_google_api_key_here
```

### Run

```bash
npm run dev     # development with nodemon
npm start       # production
```

Server starts at `http://localhost:3000`

### Get a Free Google API Key

1. Go to [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Click **"Create API Key"**
3. Select **"Create API key in new project"** — gives fresh quota each time
4. Copy and paste into `.env`

### Check Available Models

```
GET http://localhost:3000/models
```

Returns all Gemini models your API key supports. Use `gemini-2.0-flash-lite` for lowest quota usage on free tier.

---

## Data Model

Five MongoDB collections:

### `documents`
Generic upload record. Tracks every upload regardless of parse status.

```js
{
  filename: String,           // saved filename on disk
  originalName: String,       // original uploaded filename
  documentType: String,       // 'po' | 'grn' | 'invoice'
  poNumber: String,           // extracted after parsing
  parseStatus: String,        // 'pending' | 'parsed' | 'failed'
  parseError: String,         // populated if parsing fails
  parsedData: Mixed,          // full structured output for debugging
  typedDocumentId: ObjectId   // reference to PO / GRN / Invoice record
}
```

### `purchaseorders`
```js
{
  documentId: ObjectId,
  poNumber: String,
  poDate: String,
  vendorName: String,
  vendorGstin: String,
  buyerName: String,
  paymentTerms: String,
  expectedDeliveryDate: String,
  totalAmount: Number,
  items: [
    {
      itemCode: String,       // numeric SKU e.g. "11423"
      description: String,
      quantity: Number,
      unitPrice: Number,
      mrp: Number,
      taxableValue: Number,
      hsnCode: String
    }
  ]
}
```

### `grns`
```js
{
  documentId: ObjectId,
  grnNumber: String,
  poNumber: String,
  grnDate: String,
  invoiceNumber: String,
  vendorName: String,
  totalReceivedQty: Number,
  items: [
    {
      itemCode: String,
      description: String,
      receivedQuantity: Number,   // Recv Qty column
      quantity: Number,           // Exp Qty column
      unitPrice: Number,
      taxableValue: Number,
      mrp: Number,
      hsnCode: String
    }
  ]
}
```

### `invoices`
```js
{
  documentId: ObjectId,
  invoiceNumber: String,
  poNumber: String,
  invoiceDate: String,
  vendorName: String,
  vendorGstin: String,
  totalAmount: Number,
  totalTax: Number,
  items: [
    {
      itemCode: String,
      description: String,
      quantity: Number,
      unitPrice: Number,
      taxableValue: Number,
      hsnCode: String
    }
  ]
}
```

### `matchresults`
One document per `poNumber`. Always holds the latest computed match state.

```js
{
  poNumber: String,
  status: String,         // 'matched' | 'partially_matched' | 'mismatch' | 'insufficient_documents'
  hasPO: Boolean,
  hasGRN: Boolean,
  hasInvoice: Boolean,
  reasons: [String],      // e.g. ['grn_qty_exceeds_po_qty']
  itemResults: [
    {
      itemCode: String,
      description: String,
      poQty: Number,
      grnQty: Number,
      invoiceQty: Number,
      status: String,     // 'matched' | 'mismatch'
      issues: [String]
    }
  ],
  lastUpdated: Date
}
```

---

## Parsing Flow

```
POST /documents/upload (file + documentType)
            │
            ▼
    Multer saves file to /uploads/
            │
            ▼
    Document record created { parseStatus: 'pending' }
            │
            ▼
    pdf-parse extracts raw text locally
    (no API call — runs on machine)
            │
            ▼
    removeUnnecessarySections()
    Strips Terms & Conditions, legal pages
    Reduces text by up to 70%
            │
            ▼
    extractHeaderWithRegex()
    Extracts poNumber, poDate, vendorName etc.
    using regex patterns — ZERO API calls
            │
            ▼
    extractTableSection()
    Smart finder — locates only the items table
    Sends 500–2000 chars instead of 12,000+
            │
            ▼
    LangChain + Gemini 2.0 Flash Lite
    Receives ONLY the items table
    Returns structured JSON array of items
            │
        ┌───┴──────────────────┐
      success               failure
        │                       │
        ▼                       ▼
    buildFinalResult()     Document { parseStatus: 'failed' }
    merge header + items   return 422
        │
        ▼
    storeTypedDocument()
    PO / GRN / Invoice saved to typed collection
        │
        ▼
    Document updated { parseStatus: 'parsed' }
        │
        ▼
    runMatch(poNumber) → MatchResult upserted
        │
        ▼
    Response { parsedData, matchStatus }
```

---

## Smart Chunking & RAG Approach

### Problem with naive chunking

```
Old approach:
  Full PDF (36,000 chars)
  → split every 12,000 chars → 4 chunks
  → findBestChunk() picks wrong chunk
  → table rows cut in the middle
  → AI gets incomplete data
  → hits token and rate limits
```

### Our approach

```
New approach:
  Full PDF (36,000 chars)
      │
      ▼
  Step 1: Strip legal pages       → ~10,000 chars  (regex, 0 API calls)
      │
      ▼
  Step 2: Extract header fields   → instant         (regex, 0 API calls)
      │
      ▼
  Step 3: Find table section      → ~1,500 chars    (pattern matching)
      │
      ▼
  Step 4: Send ONLY table to AI   → 1 API call, tiny payload
      │
      ▼
  Step 5: Merge header + items    → final JSON
```

### Four specific optimisations

**Fix 1 — Remove unnecessary sections**

Strips Terms & Conditions, Force Majeure, Bank Details etc. before any processing. Reduces token count by 70%+.

```js
function removeUnnecessarySections(text) {
  const stopWords = ['Terms And Conditions', 'Force Majeure', 'Bank Details' ...];
  // Returns text only up to first stopword found
}
```

**Fix 2 — Smart table section extraction**

Finds where the items table starts and ends using pattern matching on column headers and total rows. Sends only table rows to AI.

```js
// Table starts at: "Sr. No", "SKU Code", "Item Code" etc.
// Table ends at:   "Grand Total", "Amount in Words", "Authorised Signatory" etc.
```

**Fix 3 — Regex for header fields and totals**

Fields like `poNumber`, `poDate`, `vendorName`, `totalAmount` are simple key-value pairs. Extracted with regex — zero AI calls needed.

```js
const poNumber = text.match(/PO No\s*[:\-]?\s*(CI[\w\d]+)/i)?.[1];
const poDate   = text.match(/PO Date\s*[:\-]\s*([\d\-\/]+)/i)?.[1];
const total    = text.match(/Grand Total\s*\(INR\)\s*([\d,]+)/i)?.[1];
```

**Fix 4 — Reduced retries**

Retry count reduced from 3 to 1. Repeated retries on rate-limited keys waste quota without benefit.

### Token usage comparison

| Approach | Chars sent to AI | API calls | Rate Limit Risk |
|---|---|---|---|
| Old (full chunks) | ~12,000 | 3–4 | Very High |
| New (table only) | ~500–2,000 | 1 | Very Low |

---

## Matching Logic

Matching runs automatically after every successful upload. `runMatch(poNumber)` is **idempotent** — same input always gives same output.

### Item-level rules

| Rule | Reason Code |
|---|---|
| GRN received qty > PO qty | `grn_qty_exceeds_po_qty` |
| Invoice qty > PO qty | `invoice_qty_exceeds_po_qty` |
| Invoice qty > total GRN received qty | `invoice_qty_exceeds_grn_qty` |
| Item invoiced but never received in GRN | `item_not_received_in_grn` |
| Invoice item not found in PO | `item_missing_in_po` |

### Document-level rules

| Rule | Reason Code |
|---|---|
| Invoice date is after PO date | `invoice_date_after_po_date` |
| More than one PO for same poNumber | `duplicate_po` |

### Match status values

| Status | Meaning |
|---|---|
| `matched` | All items and rules pass |
| `partially_matched` | Some items match, some have issues |
| `mismatch` | All items fail or critical rule breaks |
| `insufficient_documents` | PO / GRN / Invoice not all uploaded yet |

### Multiple GRNs

GRN quantities for the same `itemCode` are **summed** across all GRNs. Supports partial deliveries:

```
GRN-1: itemCode 11423 → receivedQty 30
GRN-2: itemCode 11423 → receivedQty 20
Total used for matching = 50
```

### Item matching key

**Primary key: numeric `itemCode` (SKU)**

The PO and GRN use numeric SKU codes (`11423`, `18004`). Keys are normalised before comparison:

```js
function normaliseKey(code) {
  return String(code).trim().toLowerCase().replace(/[-_\s]+/g, '');
}
```

> **Note:** Some invoices use vendor-internal codes that differ from buyer SKUs. These are flagged as `item_missing_in_po`. A cross-reference table would resolve this in production.

---

## Out-of-Order Upload Handling

There is no pipeline or workflow engine. The design is intentionally simple:

- Every upload is **parsed and stored independently**
- Every successful upload calls `runMatch(poNumber)` which **reads all available documents from MongoDB** and recomputes from scratch
- `MatchResult` is upserted — always reflects the latest state

Any upload order produces the correct final result:

```
PO → GRN → Invoice    ✅ final: matched / mismatch
Invoice → GRN → PO    ✅ same final result
GRN → Invoice → PO    ✅ same final result
```

Early uploads return `insufficient_documents`. Status upgrades automatically as more documents arrive.

---

## API Reference

### POST `/documents/upload`

Upload and parse a document.

**Request** — `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | File | Yes | PDF only |
| `documentType` | String | Yes | `po`, `grn`, or `invoice` |

**Response — 201**
```json
{
  "documentId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "documentType": "grn",
  "poNumber": "CI4PO05788",
  "parseStatus": "parsed",
  "parsedData": { "..." },
  "matchTriggered": true,
  "matchStatus": "insufficient_documents"
}
```

**Response — 422 (parse failed)**
```json
{
  "documentId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "error": "Parsing failed",
  "detail": "Gemini items extraction failed: ..."
}
```

---

### GET `/documents/:id`

Get a parsed document by MongoDB ID.

**Response — 200**
```json
{
  "_id": "64f1a2b3c4d5e6f7a8b9c0d1",
  "documentType": "grn",
  "poNumber": "CI4PO05788",
  "parseStatus": "parsed",
  "parsedData": { "..." },
  "createdAt": "2026-03-24T10:00:00.000Z"
}
```

---

### GET `/documents`

List documents with optional filters.

**Query params:** `?poNumber=CI4PO05788` or `?documentType=grn`

**Response — 200**
```json
{
  "count": 3,
  "documents": ["..."]
}
```

---

### GET `/match/:poNumber`

Get the three-way match result for a PO number.

**Response — 200**
```json
{
  "poNumber": "CI4PO05788",
  "matchStatus": "partially_matched",
  "reasons": ["grn_qty_exceeds_po_qty"],
  "documents": {
    "po": {
      "id": "...",
      "poDate": "Mar 17, 2026",
      "vendorName": "M/s AFP",
      "totalAmount": 1045042.19,
      "itemCount": 38
    },
    "grns": [
      {
        "id": "...",
        "grnNumber": "CI4000020234",
        "grnDate": "24-3-2026",
        "totalReceivedQty": 4705,
        "itemCount": 31
      }
    ],
    "invoices": [
      {
        "id": "...",
        "invoiceNumber": "IN25MH2504251",
        "invoiceDate": "24-3-2026",
        "totalAmount": 780426.40,
        "itemCount": 31
      }
    ]
  },
  "itemResults": [
    {
      "itemCode": "11423",
      "description": "Spicy Veg Momos 24.0 Pieces",
      "poQty": 50,
      "grnQty": 50,
      "invoiceQty": 50,
      "status": "matched",
      "issues": []
    },
    {
      "itemCode": "18003",
      "description": "Meatigo Chicken Curry Cut Skinless Frozen 450.0 g",
      "poQty": 120,
      "grnQty": 30,
      "invoiceQty": 30,
      "status": "matched",
      "issues": []
    }
  ],
  "lastUpdated": "2026-03-24T12:00:00.000Z"
}
```

---

### POST `/match/:poNumber/rerun`

Force re-evaluation of match result.

**Response — 200**
```json
{
  "poNumber": "CI4PO05788",
  "matchStatus": "matched",
  "reasons": []
}
```

---

### GET `/health`

Health check.

**Response — 200**
```json
{
  "status": "ok",
  "timestamp": "2026-03-24T12:00:00.000Z"
}
```

---

### GET `/models`

List all Gemini models available for your API key. Use this to find which model to configure.

**Response — 200**
```json
{
  "models": [
    { "name": "models/gemini-2.0-flash-lite", "displayName": "Gemini 2.0 Flash-Lite" },
    { "name": "models/gemini-2.0-flash", "displayName": "Gemini 2.0 Flash" }
  ]
}
```

---

## Sample Parsed JSON

### GRN (from actual uploaded document)

```json
{
  "grnNumber": "CI4000020234",
  "poNumber": "CI4PO05788",
  "grnDate": "24-3-2026",
  "invoiceNumber": "IN25MH2504251",
  "vendorName": "M/s AFP",
  "totalReceivedQty": 4705,
  "items": [
    {
      "itemCode": "11423",
      "description": "Spicy Veg Momos 24.0 Pieces",
      "receivedQuantity": 50,
      "quantity": 50,
      "unitPrice": 220.76,
      "taxableValue": 11038.10,
      "mrp": 305.00,
      "hsnCode": null
    },
    {
      "itemCode": "18003",
      "description": "Meatigo Chicken Curry Cut Skinless Frozen 450.0 g",
      "receivedQuantity": 30,
      "quantity": 120,
      "unitPrice": 141.14,
      "taxableValue": 4234.29,
      "mrp": 195.00,
      "hsnCode": null
    },
    {
      "itemCode": "33390",
      "description": "Seekh Kebab 500.0 g",
      "receivedQuantity": 272,
      "quantity": 272,
      "unitPrice": 228.00,
      "taxableValue": 62016.00,
      "mrp": 315.00,
      "hsnCode": null
    }
  ]
}
```

---

## Sample Match Result

```json
{
  "poNumber": "CI4PO05788",
  "matchStatus": "partially_matched",
  "reasons": ["grn_qty_exceeds_po_qty"],
  "itemResults": [
    {
      "itemCode": "11423",
      "description": "Spicy Veg Momos 24.0 Pieces",
      "poQty": 50,
      "grnQty": 50,
      "invoiceQty": 50,
      "status": "matched",
      "issues": []
    },
    {
      "itemCode": "18004",
      "description": "Meatigo Chicken Boneless Breast Frozen 450.0 g",
      "poQty": 540,
      "grnQty": 30,
      "invoiceQty": 30,
      "status": "matched",
      "issues": []
    }
  ]
}
```

---

## Assumptions

1. **One PO per `poNumber`** — uploading a second PO with the same number sets match to `mismatch` with reason `duplicate_po`.

2. **`itemCode` is the matching key** — numeric SKU from PO and GRN is the primary identifier. Normalised before comparison (trimmed, lowercased, dashes removed).

3. **Invoice codes may differ** — invoices sometimes use vendor-internal codes different from buyer SKU. These are flagged as `item_missing_in_po` rather than silently ignored.

4. **PDF must be text-based** — scanned or image PDFs cannot be parsed by pdf-parse. File must have an extractable text layer.

5. **Dates stored as strings** — parsed flexibly for comparison. All dates assumed to be in same timezone.

6. **Files not deleted after parsing** — uploaded files remain in `/uploads/`. Move to object storage (S3, GCS) in production.

7. **No authentication** — endpoints are open. Add JWT or API key middleware before any deployment.

8. **Partial deliveries are valid** — GRN received qty less than PO qty is acceptable and not flagged as an error. Only over-delivery is flagged.

---

## Tradeoffs

| Decision | Reason | What We'd Change |
|---|---|---|
| Regex for header fields | Zero API calls, instant, reliable for structured key-value fields | No change needed |
| AI only for items table | Minimises tokens, avoids rate limits | No change needed |
| Strip legal pages first | 70%+ token reduction before any processing | ML-based section classifier for higher accuracy |
| `gemini-2.0-flash-lite` | Lowest quota usage on free tier | Use `gemini-2.5-flash` in production |
| Re-run match on every upload | Simple, no stale state, idempotent | Add dirty-flag to skip recompute when nothing changed |
| Retry count = 1 | Avoids burning quota on repeated failures | Exponential backoff in production |
| Synchronous parsing in handler | Simple to reason about | Move to BullMQ background job queue for large files |
| No auth | Out of scope for assignment | Add JWT or API key middleware |

---

## What I Would Improve With More Time

1. **Background job queue** — Move Gemini parsing to BullMQ worker. Upload returns job ID immediately. Client polls for completion. Prevents timeout on large files.

2. **Item code cross-reference table** — A `item_mappings` collection mapping vendor invoice codes to buyer SKU codes. Resolves namespace mismatch between GRN and Invoice cleanly.

3. **Scanned PDF support** — Integrate Google Cloud Vision OCR or Tesseract for image-based PDFs that pdf-parse cannot read.

4. **Confidence scores** — Add a `confidence` field per extracted item. Lets reviewers focus on uncertain rows instead of checking everything manually.

5. **Webhook / event system** — Notify downstream systems (ERP, finance) when match status changes to `matched`. Currently consumer must poll `GET /match/:poNumber`.

6. **Unit and integration tests** — Jest tests for matching engine with fixture JSON. Supertest tests for all API routes.

7. **Swagger / OpenAPI docs** — Auto-generated from route definitions so API documentation is always up to date.

8. **File cleanup** — Move uploads to S3 post-parse, delete local copy to avoid disk buildup in production.

9. **Multi-tenancy** — Scope all collections by `tenantId` so multiple buyers share one deployment without data leakage.

10. **Admin dashboard** — Simple UI to view upload history, match results, and manually trigger re-runs without Postman.

---

## License

MIT

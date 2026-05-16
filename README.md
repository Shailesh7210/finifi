# Three-Way Match Engine

A backend service that automates the matching of Purchase Orders (PO), Goods Receipt Notes (GRN), and Invoices using **Gemini API** for document parsing and **MongoDB** for storage.

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Data Model](#data-model)
- [Parsing Flow](#parsing-flow)
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

This service allows users to upload PO, GRN, and Invoice documents (PDF or image). Each document is:

1. Saved to disk via Multer
2. Parsed into structured JSON using Gemini 1.5 Flash
3. Stored in MongoDB in a typed collection
4. Automatically triggers three-way matching logic for the linked `poNumber`

The match result is always available at `GET /match/:poNumber` regardless of the order documents were uploaded.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express.js |
| Database | MongoDB + Mongoose |
| AI Parsing | Google Gemini 1.5 Flash |
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
│   │   ├── geminiParser.js         # Gemini API integration + prompts
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
- Gemini API Key ([get one here](https://aistudio.google.com/))

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
GEMINI_API_KEY=your_gemini_api_key_here
```

### Run

```bash
npm run dev     # development (nodemon)
npm start       # production
```

Server starts at `http://localhost:3000`

---

## Data Model

There are 5 MongoDB collections:

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
  parsedData: Mixed,          // full Gemini output stored for debugging
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
      itemCode: String,
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
      quantity: Number,           // Exp Qty column (expected from PO)
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
  status: String,           // 'matched' | 'partially_matched' | 'mismatch' | 'insufficient_documents'
  hasPO: Boolean,
  hasGRN: Boolean,
  hasInvoice: Boolean,
  reasons: [String],        // e.g. ['grn_qty_exceeds_po_qty']
  itemResults: [
    {
      itemCode: String,
      description: String,
      poQty: Number,
      grnQty: Number,
      invoiceQty: Number,
      status: String,       // 'matched' | 'mismatch'
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
    fs.readFile → base64 encode
            │
            ▼
    Gemini 1.5 Flash called with:
      - Typed prompt (per documentType)
      - base64 file as inline data
            │
            ▼
    cleanJson() strips markdown fences
            │
        JSON.parse()
            │
      ┌─────┴──────────────────┐
    success                 failure
      │                         │
      ▼                         ▼
  storeTypedDocument()     Document { parseStatus: 'failed' }
  PO / GRN / Invoice       return 422
      │
      ▼
  Document updated { parseStatus: 'parsed', poNumber, parsedData }
      │
      ▼
  runMatch(poNumber) → MatchResult upserted
      │
      ▼
  Response { parsedData, matchStatus }
```

### Why Gemini?

Each document type (PO, GRN, Invoice) has its own tailored prompt. The prompt tells Gemini:
- Exactly which JSON shape to return
- Which table column maps to which field
- To return **only JSON** — no markdown, no explanation

This is necessary because different documents use different column names for the same concept. For example:
- GRN calls it `Recv Qty` → we map it to `receivedQuantity`
- GRN calls it `Exp Qty` → we map it to `quantity` (expected)

---

## Matching Logic

Matching is triggered automatically after every successful upload. The function `runMatch(poNumber)` is **idempotent** — calling it multiple times with the same data always gives the same result.

### Rules Implemented (Item Level)

| Rule | Reason Code |
|---|---|
| GRN received qty > PO qty | `grn_qty_exceeds_po_qty` |
| Invoice qty > PO qty | `invoice_qty_exceeds_po_qty` |
| Invoice qty > total GRN received qty | `invoice_qty_exceeds_grn_qty` |
| Invoice item not found in PO | `item_missing_in_po` |
| Item invoiced but never received in any GRN | `item_not_received_in_grn` |

### Rules Implemented (Document Level)

| Rule | Reason Code |
|---|---|
| Invoice date is after PO date | `invoice_date_after_po_date` |
| More than one PO uploaded for same `poNumber` | `duplicate_po` |

### Match Status

| Status | Meaning |
|---|---|
| `matched` | All items and all rules pass |
| `partially_matched` | Some items pass, some have issues |
| `mismatch` | All items fail or a critical document-level rule breaks |
| `insufficient_documents` | One or more of PO / GRN / Invoice not yet uploaded |

### Multiple GRNs

GRN quantities for the same `itemCode` are **summed** across all GRN documents before comparison. This supports partial deliveries:

```
GRN-1: itemCode 11423 → receivedQty 30
GRN-2: itemCode 11423 → receivedQty 20
Total GRN qty used for matching = 50
```

### Item Matching Key

**Primary key: numeric `itemCode` (SKU)**

The PO and GRN both use numeric SKU codes (e.g. `11423`, `18004`). These are stable and unambiguous across documents.

Keys are normalised before comparison:
```js
function normaliseKey(code) {
  return String(code).trim().toLowerCase().replace(/[-_\s]+/g, '');
}
```

This handles minor formatting differences (dashes, spaces, casing) between documents.

> **Note:** Some invoices use a different internal code format (e.g. `FG-P-F-0503`) which does not match the numeric PO/GRN SKUs. These are surfaced as `item_missing_in_po` rather than silently dropped. In production, a cross-reference table mapping vendor codes to buyer SKUs would resolve this.

---

## Out-of-Order Upload Handling

There is no pipeline or workflow engine. The approach is simpler:

- Every upload is **parsed and stored independently** — no dependency on other documents
- Every successful upload calls `runMatch(poNumber)` which **reads all available documents from MongoDB** and recomputes the match from scratch
- `MatchResult` is upserted — it always reflects the latest state

This means any upload order produces the correct final result:

```
PO → GRN → Invoice    ✅ final status: matched/mismatch
Invoice → GRN → PO    ✅ same final status
GRN → Invoice → PO    ✅ same final status
```

Early uploads get `insufficient_documents`. The status upgrades automatically as more documents arrive.

---

## API Reference

### POST `/documents/upload`

Upload and parse a document.

**Request** — `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | File | Yes | PDF, JPEG, or PNG |
| `documentType` | String | Yes | `po`, `grn`, or `invoice` |

**Response — 201**
```json
{
  "documentId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "documentType": "grn",
  "poNumber": "CI4PO05788",
  "parseStatus": "parsed",
  "parsedData": { ... },
  "matchTriggered": true,
  "matchStatus": "insufficient_documents"
}
```

**Response — 422 (parse failed)**
```json
{
  "documentId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "error": "Parsing failed",
  "detail": "Gemini returned invalid JSON: ..."
}
```

---

### GET `/documents/:id`

Get a parsed document by its MongoDB ID.

**Response — 200**
```json
{
  "_id": "64f1a2b3c4d5e6f7a8b9c0d1",
  "documentType": "grn",
  "poNumber": "CI4PO05788",
  "parseStatus": "parsed",
  "parsedData": { ... },
  "createdAt": "2026-03-24T10:00:00.000Z"
}
```

---

### GET `/documents`

List documents. Optional filters.

**Query params:**
- `?poNumber=CI4PO05788`
- `?documentType=grn`

**Response — 200**
```json
{
  "count": 3,
  "documents": [ ... ]
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
  "reasons": [
    "grn_qty_exceeds_po_qty",
    "invoice_qty_exceeds_grn_qty"
  ],
  "documents": {
    "po": {
      "id": "...",
      "poDate": "17-3-2026",
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
      "description": "Cheesy Spicy Veg Momos 24.0 Pieces",
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
  ],
  "lastUpdated": "2026-03-24T12:00:00.000Z"
}
```

---

### POST `/match/:poNumber/rerun`

Force re-evaluation of match (useful after manual data corrections).

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

Basic health check.

**Response — 200**
```json
{
  "status": "ok",
  "timestamp": "2026-03-24T12:00:00.000Z"
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

1. **One PO per `poNumber`** — uploading a second PO with the same number sets match status to `mismatch` with reason `duplicate_po`.

2. **`itemCode` is the matching key** — the numeric SKU code from the PO and GRN is used as the primary item identifier. It is stable and consistent across both documents. Keys are normalised (trimmed, lowercased, dashes removed) before comparison.

3. **Invoice codes may differ** — in real documents, invoices sometimes use vendor-internal codes that differ from the buyer's SKU. These are flagged as `item_missing_in_po` rather than silently ignored.

4. **Dates stored as strings** — parsed flexibly for comparison using a best-effort date parser. All dates assumed to be in the same timezone.

5. **Files are not deleted after parsing** — uploaded files remain in `/uploads/`. In production, move to object storage (S3, GCS) after parsing.

6. **No authentication** — endpoints are open. JWT or API key middleware should be added before any deployment.

7. **Partial deliveries are valid** — if GRN received qty is less than PO qty, that is acceptable (not flagged as an error). Only over-delivery is flagged.

---

## Tradeoffs

| Decision | Reason | What We'd Change |
|---|---|---|
| Re-run match on every upload | Simple, no stale state, idempotent | Add dirty-flag to skip recompute when nothing changed |
| Store full `parsedData` on Document | Easy debugging without re-parsing | Normalise only in high-volume systems; raw data is large |
| Gemini 1.5 Flash | Fast and cost-efficient | Use Pro for higher accuracy on complex/messy layouts |
| Numeric SKU as item key | Most stable identifier across docs | Add vendor ↔ buyer item code cross-reference table |
| Synchronous parsing in upload handler | Simple to reason about | Move to background job queue (BullMQ) for large files |
| No auth | Out of scope for assignment | Add JWT or API key middleware before any deployment |

---

## What I Would Improve With More Time

1. **Background job queue** — Move Gemini parsing to a BullMQ worker. Upload returns a job ID immediately; client polls for completion. Prevents request timeouts on large files.

2. **Item code cross-reference table** — A `item_mappings` collection mapping vendor invoice codes to buyer SKU codes. Resolves the namespace mismatch between GRN and Invoice item codes cleanly.

3. **Confidence scores on extraction** — Gemini extractions are probabilistic. Adding a `confidence` field per extracted item lets reviewers focus on uncertain rows instead of checking everything.

4. **Webhook / event system** — Notify downstream systems (ERP, finance) when a match status changes to `matched`. Currently the consumer must poll `GET /match/:poNumber`.

5. **Unit and integration tests** — Jest tests for the matching engine using fixture JSON. Supertest tests for all API routes. Currently untested.

6. **Swagger / OpenAPI docs** — Auto-generated from route definitions so the API is always up to date.

7. **File cleanup** — Move uploads to S3 post-parse; delete local copy to avoid disk buildup.

8. **Multi-tenancy** — Scope all collections by `tenantId` so multiple buyers can share one deployment without data leakage.

9. **Retry logic for Gemini** — Exponential backoff on rate limit errors (429) from Gemini API.

10. **Admin dashboard** — Simple UI to view upload history, match results, and manually trigger re-runs.

---

## License

MIT

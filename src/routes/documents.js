const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Document } = require('../models');
const { parseDocument } = require('../services/geminiParser');
const { storeTypedDocument, extractPoNumber } = require('../services/documentStore');
const { runMatch } = require('../services/matchingEngine');

const router = express.Router();

const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    cb(null, `${unique}-${file.originalname}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    allowed.includes(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Only PDF, JPEG, PNG supported'));
  },
});

// POST /documents/upload
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    const { documentType } = req.body;

    if (!req.file)
      return res.status(400).json({ error: 'No file uploaded' });

    if (!['po', 'grn', 'invoice'].includes(documentType))
      return res.status(400).json({
        error: 'documentType must be po, grn, or invoice',
      });

    // Create pending record
    const doc = await Document.create({
      filename: req.file.filename,
      originalName: req.file.originalname,
      documentType,
      parseStatus: 'pending',
    });

    // Parse with Gemini
    let parsedData;
    try {
      parsedData = await parseDocument(req.file.path, documentType);
    } catch (parseErr) {
      await Document.findByIdAndUpdate(doc._id, {
        parseStatus: 'failed',
        parseError: parseErr.message,
      });
      return res.status(422).json({
        documentId: doc._id,
        error: 'Parsing failed',
        detail: parseErr.message,
      });
    }

    // Store in typed collection
    const poNumber = extractPoNumber(documentType, parsedData);
    const typedDoc = await storeTypedDocument(documentType, parsedData, doc._id);

    // Update document record
    await Document.findByIdAndUpdate(doc._id, {
      parseStatus: 'parsed',
      poNumber,
      parsedData,
      typedDocumentId: typedDoc._id,
    });

    // Trigger matching
    let matchResult = null;
    if (poNumber) {
      try {
        matchResult = await runMatch(poNumber);
      } catch (matchErr) {
        console.error(
          `Match trigger failed for PO ${poNumber}:`,
          matchErr.message
        );
      }
    }

    return res.status(201).json({
      documentId: doc._id,
      documentType,
      poNumber,
      parseStatus: 'parsed',
      parsedData,
      matchTriggered: !!poNumber,
      matchStatus: matchResult?.status || null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /documents/:id
router.get('/:id', async (req, res, next) => {
  try {
    const doc = await Document.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

// GET /documents
router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.poNumber) filter.poNumber = req.query.poNumber;
    if (req.query.documentType) filter.documentType = req.query.documentType;

    const docs = await Document.find(filter)
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({ count: docs.length, documents: docs });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
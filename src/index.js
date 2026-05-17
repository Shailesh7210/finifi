require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');

const documentRoutes = require('./routes/documents');
const matchRoutes = require('./routes/match');
const errorHandler = require('./middleware/errorHandler');
const dns = require('dns')

dns.setServers(["0.0.0.0", "8.8.4.4"])

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use('/documents', documentRoutes);
app.use('/match', matchRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Temporary: list available Gemini models
app.get('/models', async (req, res) => {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GOOGLE_API_KEY}`
    );
    const data = await response.json();
    const models = data.models
      ?.filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => ({
        name: m.name,
        displayName: m.displayName,
      }));
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(errorHandler);

async function start() {
  try {
    await mongoose.connect(
      process.env.MONGODB_URI || 'mongodb://localhost:27017/three-way-match'
    );
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err.message);
    process.exit(1);
  }
}

start();
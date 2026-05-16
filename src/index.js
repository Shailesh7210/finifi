require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');


const  dns = require('dns')

const documentRoutes = require('./routes/documents');
const matchRoutes = require('./routes/match');
const errorHandler = require('./middleware/errorHandler');

dns.setServers(["8.8.8.8", "8.8.4.4"])

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use('/documents', documentRoutes);
app.use('/match', matchRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


app.get('/models', async (req, res) => {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`
    );
    const data = await response.json();
    
    const models = data.models
      ?.filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name);
    
    res.json({ available_models: models });
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
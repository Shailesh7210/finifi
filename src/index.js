require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');

const documentRoutes = require('./routes/documents');
const matchRoutes = require('./routes/match');
const errorHandler = require('./middleware/errorHandler');
const dns = require('dns')


dns.setServers(["8.8.8.8", "8.8.4.4"])
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use('/documents', documentRoutes);
app.use('/match', matchRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

async function start() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (err) {
    console.error('Failed to start:', err.message);
    process.exit(1);
  }
}

start();
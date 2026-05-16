module.exports = function errorHandler(err, req, res, next) {
  console.error(err);
  if (err.name === 'ValidationError') return res.status(400).json({ error: 'Validation error', detail: err.message });
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid ID format' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 20 MB)' });
  res.status(500).json({ error: err.message || 'Internal server error' });
};
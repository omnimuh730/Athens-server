/** Central error handler — consistent JSON shape. */
export function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Internal server error';
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ success: false, error: message });
}

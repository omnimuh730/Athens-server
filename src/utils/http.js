export function createAsyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function apiError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

export function apiOk(res, data, status = 200) {
  return res.status(status).json({ success: true, ...data });
}

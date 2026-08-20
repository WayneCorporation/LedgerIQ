const server = require('../server.js');

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET) {
    const expected = `Bearer ${process.env.CRON_SECRET}`;
    if (req.headers['authorization'] !== expected) {
      res.statusCode = 401;
      res.end('Unauthorized');
      return;
    }
  }
  try {
    await server.runMaintenance();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
};

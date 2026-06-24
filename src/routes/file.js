const express = require('express');
const router  = express.Router();
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// GET /api/file/proxy?url=<cloudinary_url>&name=<filename>&disposition=inline|attachment
router.get('/proxy', async (req, res) => {
  const { url, name, disposition } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  if (parsed.hostname !== 'res.cloudinary.com') return res.status(403).json({ error: 'Forbidden' });

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).end();

    const rawType    = upstream.headers.get('content-type') || 'application/octet-stream';
    const safeType   = /^(application\/pdf|image\/|text\/plain)/.test(rawType)
      ? rawType : 'application/octet-stream';
    const disp       = disposition === 'attachment' ? 'attachment' : 'inline';
    const filename   = (name || 'file').replace(/"/g, "'");

    res.setHeader('Content-Type', safeType);
    res.setHeader('Content-Disposition', `${disp}; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');

    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    res.status(502).json({ error: 'proxy error', details: err.message });
  }
});

module.exports = router;

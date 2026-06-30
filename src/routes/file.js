const express = require('express');
const router  = express.Router();
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// GET /api/file/proxy?url=<cloudinary_url>&name=<filename>&disposition=inline|attachment
router.get('/proxy', async (req, res) => {
  const { url, name, disposition } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') return res.status(403).json({ error: 'Forbidden' });

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      // Never forward a 401 to the client — the Axios interceptor treats it as session-expired
      const status = upstream.status === 401 ? 502 : upstream.status;
      return res.status(status).json({ error: `Upstream fetch failed: ${upstream.status}` });
    }

    const rawType  = upstream.headers.get('content-type') || '';
    const ext      = (name || '').split('.').pop().toLowerCase();
    const EXT_MAP  = {
      pdf:  'application/pdf',
      jpg:  'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif:  'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
      txt:  'text/plain',
    };
    const guessed  = EXT_MAP[ext] || '';
    const VIEWABLE = /^(application\/pdf|image\/|text\/plain)/;
    // Use Cloudinary's type if viewable; fall back to extension guess; else octet-stream
    const safeType = VIEWABLE.test(rawType) ? rawType
      : VIEWABLE.test(guessed)              ? guessed
      : rawType                             || 'application/octet-stream';
    const disp     = disposition === 'attachment' ? 'attachment' : 'inline';
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

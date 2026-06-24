const express = require('express');
const router  = express.Router();
const fetch   = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const TIMEOUT_MS = 8000;

const withTimeout = (promise) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), TIMEOUT_MS)),
  ]);

// GET /api/geocode?lat=17.43&lng=78.37
router.get('/', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });

  const fromNominatim = async () => {
    const r = await withTimeout(fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`,
      { headers: { 'User-Agent': 'BRP-AMS/1.0 (brp-ams@raminfo.com)', 'Accept-Language': 'en' } }
    ));
    const j = await r.json();
    if (!j.display_name) throw new Error('no data');
    const a = j.address || {};
    return {
      city:     a.city || a.town || a.village || a.municipality || a.county || '',
      suburb:   a.suburb || a.neighbourhood || a.quarter || a.hamlet || a.locality || '',
      postcode: a.postcode || '',
      state:    a.state || '',
      district: a.state_district || a.county || a.district || '',
      address:  j.display_name,
    };
  };

  const fromBigData = async () => {
    const r = await withTimeout(fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`
    ));
    const j = await r.json();
    if (!j.city && !j.locality && !j.principalSubdivision) throw new Error('no data');
    const adminList = (j.localityInfo?.administrative || [])
      .filter(a => a.name && a.adminLevel >= 4 && a.adminLevel <= 8)
      .sort((a, b) => b.adminLevel - a.adminLevel);
    const city   = j.city || j.locality || adminList[0]?.name || '';
    const suburb = (j.locality && j.locality !== city) ? j.locality
      : (adminList.find(a => a.adminLevel >= 7)?.name || '');
    return {
      city,
      suburb,
      postcode: j.postcode || '',
      state:    j.principalSubdivision || '',
      district: j.localityInfo?.administrative?.find(a => a.adminLevel === 5)?.name || '',
      address:  [suburb, city, j.principalSubdivision, j.countryName].filter(Boolean).join(', '),
    };
  };

  const results = await Promise.allSettled([fromNominatim(), fromBigData()]);
  const winner  = results.find(r => r.status === 'fulfilled' && (r.value.city || r.value.suburb || r.value.district || r.value.state));
  if (winner) return res.json({ lat, lng, ...winner.value });

  const partial = results.find(r => r.status === 'fulfilled');
  if (partial) return res.json({ lat, lng, ...partial.value });

  res.status(502).json({ error: 'geocoding failed', details: results.map(r => r.reason?.message) });
});

module.exports = router;

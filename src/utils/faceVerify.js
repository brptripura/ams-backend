// utils/faceVerify.js
const path  = require('path');
const https = require('https');
const http  = require('http');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');

const MODELS_PATH        = path.join(__dirname, '../../public/models');
const CONFIDENCE_THRESHOLD = 70;   // Match if confidence >= 70%
const MATCH_THRESHOLD    = 0.30;   // Euclidean distance equiv of 70% confidence
const BLOCK_CONFIDENCE_MIN = 0;    // Block ALL mismatches
const MIN_FACE_CONF      = 0.3;

let modelsLoaded     = false;
let modelLoadPromise = null;
let modelsFailedMsg  = null;

// ── Transform Cloudinary URL to force JPEG + optimal face-detection size ──
// This is the KEY fix: Cloudinary PNG uploads may have issues with
// @napi-rs/canvas. Forcing f_jpg,q_90,w_640 ensures:
//   1. JPEG format — no alpha channel issues
//   2. 640px width — good size for SSD face detection
//   3. Quality 90 — high enough detail for face recognition
function toCloudinaryJpeg(url) {
  if (!url) return url;

  // Only transform Cloudinary URLs
  if (!url.includes('res.cloudinary.com')) return url;

  try {
    // Cloudinary URL format:
    // https://res.cloudinary.com/CLOUD/image/upload/VERSION/PATH.ext
    // Insert transformation after /upload/
    const transformed = url.replace(
      /\/image\/upload\//,
      '/image/upload/f_jpg,q_90,w_640,c_limit/'
    );
    console.log('[FaceVerify] Cloudinary transform:', transformed);
    return transformed;
  } catch (e) {
    console.warn('[FaceVerify] Could not transform Cloudinary URL:', e.message);
    return url;
  }
}

// ── Fetch URL as Buffer with timeout and redirect following ────────────────
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const doFetch = (fetchUrl, redirectCount = 0) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));

      const client = fetchUrl.startsWith('https') ? https : http;
      const req = client.get(fetchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BRP-AMS/1.0)',
          'Accept':     'image/jpeg,image/png,image/webp,image/*,*/*',
        },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doFetch(res.headers.location, redirectCount + 1);
        }
        if (res.statusCode !== 200) {
          res.resume(); // drain
          return reject(new Error(`HTTP ${res.statusCode} from: ${fetchUrl}`));
        }
        const chunks = [];
        res.on('data',  chunk => chunks.push(chunk));
        res.on('end',   ()    => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(20000, () => {
        req.destroy();
        reject(new Error('Timeout fetching image'));
      });
    };

    doFetch(url);
  });
}

// ── Convert image buffer → tf.Tensor3D ────────────────────────────────────
// Composites on white background to handle any alpha/transparency issues.
async function bufferToTensor(buffer, label = '') {
  const tf = faceapi.tf;

  let img;
  try {
    img = await loadImage(buffer);
  } catch (err) {
    throw new Error(`loadImage failed for ${label}: ${err.message}`);
  }

  const { width, height } = img;
  console.log(`[FaceVerify] ${label} raw size: ${width}x${height}`);

  if (width < 20 || height < 20) {
    throw new Error(`${label} image too small: ${width}x${height}`);
  }

  // Resize: SSD Mobilenet works best with images 300–640px wide
  const MAX_DIM = 640;
  const MIN_DIM = 300;
  let drawW = width;
  let drawH = height;

  if (Math.max(width, height) > MAX_DIM) {
    const scale = MAX_DIM / Math.max(width, height);
    drawW = Math.round(width  * scale);
    drawH = Math.round(height * scale);
  } else if (Math.max(width, height) < MIN_DIM) {
    const scale = MIN_DIM / Math.max(width, height);
    drawW = Math.round(width  * scale);
    drawH = Math.round(height * scale);
  }

  console.log(`[FaceVerify] ${label} tensor size: ${drawW}x${drawH}`);

  const canvas = createCanvas(drawW, drawH);
  const ctx    = canvas.getContext('2d');

  // White background — handles RGBA/transparent PNG correctly
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, drawW, drawH);
  ctx.drawImage(img, 0, 0, drawW, drawH);

  const imgData = ctx.getImageData(0, 0, drawW, drawH);
  const { data } = imgData;

  // RGBA → RGB Float32
  const rgbData = new Float32Array(drawW * drawH * 3);
  for (let i = 0; i < drawW * drawH; i++) {
    rgbData[i * 3]     = data[i * 4];      // R
    rgbData[i * 3 + 1] = data[i * 4 + 1]; // G
    rgbData[i * 3 + 2] = data[i * 4 + 2]; // B
  }

  return tf.tensor3d(rgbData, [drawH, drawW, 3]);
}

// ── Load face-api models once ──────────────────────────────────────────────
async function ensureModels() {
  if (modelsLoaded) return;
  if (modelsFailedMsg) throw new Error(modelsFailedMsg);
  if (modelLoadPromise) return modelLoadPromise;

  modelLoadPromise = (async () => {
    const tf = faceapi.tf;
    for (const backend of ['tensorflow', 'cpu']) {
      try {
        await tf.setBackend(backend);
        await tf.ready();
        console.log('[FaceVerify] TF backend ready:', tf.getBackend());
        break;
      } catch (e) {
        console.warn(`[FaceVerify] Backend "${backend}" failed:`, e.message);
      }
    }
    console.log('[FaceVerify] Loading models from:', MODELS_PATH);
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_PATH);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_PATH);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_PATH);
    modelsLoaded = true;
    console.log('[FaceVerify] ✅ Models ready');
  })();

  try {
    await modelLoadPromise;
  } catch (err) {
    modelsFailedMsg  = err.message;
    modelLoadPromise = null;
    throw err;
  }
}

ensureModels().catch(err =>
  console.error('[FaceVerify] Startup preload failed:', err.message)
);

// ── Get 128-d face descriptor from a Buffer ────────────────────────────────
// CRITICAL FIX: bufferToTensor is called ONCE per confidence level attempt.
// The tensor is always disposed in finally to prevent memory leaks.
async function getDescriptor(buffer, label = '') {
  const tf = faceapi.tf;

  // Confidence levels to try — from normal down to very lenient.
  // Real-world profile photos (office lighting, slight angle) often score 0.2–0.35.
  const confidenceLevels = [0.3, 0.2, 0.15, 0.10];

  for (const minConf of confidenceLevels) {
    let tensor = null;
    try {
      // Rebuild tensor each attempt — necessary because tf.dispose() frees it
      tensor = await bufferToTensor(buffer, label);

      const detection = await faceapi
        .detectSingleFace(
          tensor,
          new faceapi.SsdMobilenetv1Options({ minConfidence: minConf })
        )
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (detection?.descriptor) {
        console.log(
          `[FaceVerify] ✅ ${label}: face found | ` +
          `minConf=${minConf} | detectionScore=${detection.detection.score.toFixed(3)}`
        );
        return detection.descriptor;
      }

      console.log(`[FaceVerify] ${label}: no face at minConf=${minConf}`);

    } catch (innerErr) {
      console.error(`[FaceVerify] ${label} error at minConf=${minConf}:`, innerErr.message);
    } finally {
      // Always dispose tensor to prevent GPU/memory leak
      if (tensor) {
        try { tf.dispose(tensor); } catch (_) {}
      }
    }
  }

  console.warn(`[FaceVerify] ❌ ${label}: no face found after all confidence levels`);
  return null;
}

// ── Main export ────────────────────────────────────────────────────────────
async function verifyFace(selfieBuffer, profilePhotoUrl, mimeType = 'image/jpeg') {

  // ── Guard: no enrolled photo ──────────────────────────────────────────
  if (!profilePhotoUrl) {
    return {
      match:      false,
      confidence: 0,
      reason:     'No profile photo enrolled. Go to My Profile to upload your face photo.',
    };
  }

  // ── Load models ───────────────────────────────────────────────────────
  try {
    await ensureModels();
  } catch (err) {
    console.error('[FaceVerify] Models unavailable:', err.message);
    return {
      match:      false,
      confidence: 0,
      reason:     'Face verification system is temporarily unavailable. Please contact admin.',
    };
  }

  // ── Fetch profile photo — KEY FIX: transform to JPEG first ───────────
  // Cloudinary PNG with transparency causes loadImage to produce incorrect
  // pixel data in @napi-rs/canvas. Forcing f_jpg removes alpha channel
  // at the CDN level before we even receive the bytes.
  const transformedUrl = toCloudinaryJpeg(profilePhotoUrl);
  let profileBuffer;
  try {
    console.log('[FaceVerify] Fetching profile photo (transformed):', transformedUrl);
    profileBuffer = await fetchBuffer(transformedUrl);
    console.log(`[FaceVerify] Profile photo: ${profileBuffer.length} bytes`);

    if (profileBuffer.length < 1000) {
      throw new Error(`Profile photo too small (${profileBuffer.length} bytes) — fetch likely failed`);
    }
  } catch (err) {
    console.error('[FaceVerify] Fetch failed:', err.message);

    // Try original URL as fallback
    if (transformedUrl !== profilePhotoUrl) {
      try {
        console.log('[FaceVerify] Retrying with original URL...');
        profileBuffer = await fetchBuffer(profilePhotoUrl);
        console.log(`[FaceVerify] Fallback fetch: ${profileBuffer.length} bytes`);
      } catch (fallbackErr) {
        console.error('[FaceVerify] Fallback also failed:', fallbackErr.message);
        return {
          match:      false,
          confidence: 0,
          reason:     'Could not load your enrolled profile photo. Please try again or contact admin.',
        };
      }
    } else {
      return {
        match:      false,
        confidence: 0,
        reason:     'Could not load your enrolled profile photo. Please try again or contact admin.',
      };
    }
  }

  // ── Run face detection on both images ────────────────────────────────
  // Run sequentially (not parallel) to avoid TF memory contention
  let profileDescriptor = null;
  let selfieDescriptor  = null;

  try {
    profileDescriptor = await getDescriptor(profileBuffer, 'PROFILE');
  } catch (err) {
    console.error('[FaceVerify] Profile descriptor crashed:', err.message);
  }

  try {
    selfieDescriptor = await getDescriptor(selfieBuffer, 'SELFIE');
  } catch (err) {
    console.error('[FaceVerify] Selfie descriptor crashed:', err.message);
  }

  console.log(
    `[FaceVerify] Results — profileDescriptor: ${!!profileDescriptor} | ` +
    `selfieDescriptor: ${!!selfieDescriptor}`
  );

  // ── No face in PROFILE photo ──────────────────────────────────────────
  if (!profileDescriptor) {
    console.error('[FaceVerify] ❌ Profile photo has no detectable face');
    return {
      match:      false,
      confidence: 0,
      reason:
        'Your enrolled profile photo could not be processed for face verification. ' +
        'Please ask your admin to reset and re-enroll your profile photo ' +
        '(Admin → Users → Reset Photo for your account).',
    };
  }

  // ── No face in SELFIE ─────────────────────────────────────────────────
  if (!selfieDescriptor) {
    console.warn('[FaceVerify] ❌ No face detected in selfie');
    return {
      match:      false,
      confidence: 0,
      reason:
        'No face detected in your selfie. ' +
        'Look directly at the camera in good lighting, ' +
        'remove sunglasses or anything covering your face, and try again.',
    };
  }

  // ── Compare descriptors ───────────────────────────────────────────────
  const distance   = faceapi.euclideanDistance(profileDescriptor, selfieDescriptor);
  const confidence = Math.round(Math.max(0, Math.min(100, (1 - distance) * 100)));
  const match      = confidence >= CONFIDENCE_THRESHOLD; // 70% and above = match

  console.log(
    `[FaceVerify] distance=${distance.toFixed(4)} | ` +
    `confidence=${confidence}% | match=${match} | required=${CONFIDENCE_THRESHOLD}%`
  );

  if (match) {
    return {
      match:      true,
      confidence,
      reason:     `Face verified — ${confidence}% match.`,
    };
  }

  // ── Mismatch reason ───────────────────────────────────────────────────
  let reason;
  if (confidence < 30) {
    reason =
      'Face does not match your enrolled profile photo. ' +
      'Ensure you are the registered employee, or contact admin to re-enroll.';
  } else if (confidence < 50) {
    reason =
      'Face did not match. Try in better lighting and remove glasses if wearing any.';
  } else {
    reason =
      `Face match ${confidence}% — below required 70%. Look straight at the camera with your face fully visible.`;
  }

  return { match: false, confidence, reason };
}

module.exports = { verifyFace, MATCH_THRESHOLD, CONFIDENCE_THRESHOLD, BLOCK_CONFIDENCE_MIN };
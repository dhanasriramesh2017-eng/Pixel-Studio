// Pixel Studio — Full Server with Authentication & Personal Library API
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PORT = 3000;
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const PUBLIC_DIR = path.join(__dirname, 'Image');
const DATA_DIR = path.join(__dirname, 'data');
const STORAGE_DIR = path.join(__dirname, 'storage');

// Ensure data and storage directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Initialize SQLite database
const db = new DatabaseSync(path.join(DATA_DIR, 'pixel_studio.db'));
db.exec('PRAGMA foreign_keys = ON;');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    width INTEGER DEFAULT 0,
    height INTEGER DEFAULT 0,
    size_bytes INTEGER DEFAULT 0,
    mime_type TEXT DEFAULT 'image/png',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_downloads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    operation TEXT NOT NULL,
    format TEXT NOT NULL,
    width INTEGER DEFAULT 0,
    height INTEGER DEFAULT 0,
    size_bytes INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

// Authentication & Crypto Helpers
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function generateId() {
  return crypto.randomUUID();
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// User storage directory helper
function getUserStorageDir(userId, type) {
  const dir = path.join(STORAGE_DIR, 'users', userId, type);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Session validation
function getAuthenticatedUser(req) {
  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else {
    // Check query param for media / file download requests
    const urlObj = new URL(req.url, 'http://localhost');
    token = urlObj.searchParams.get('token');
  }

  if (!token) return null;

  const now = Date.now();
  const sessionStmt = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?');
  const session = sessionStmt.get(token);

  if (!session || session.expires_at < now) {
    if (session) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
    return null;
  }

  const userStmt = db.prepare('SELECT id, email, display_name, created_at FROM users WHERE id = ?');
  const user = userStmt.get(session.user_id);
  if (!user) return null;

  user.token = token;
  return user;
}

// Body parser helper (JSON or raw text)
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) { // 30MB limit
        reject(new Error('Request entity too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve({ raw: body });
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// MIME types for static files
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

function resolveRequestPath(rawUrl) {
  let reqUrl = rawUrl.split('?')[0].split('#')[0];
  if (!reqUrl || reqUrl === '/') return '/index.html';

  const lower = reqUrl.toLowerCase();
  if (lower === '/image' || lower === '/image/' || lower === '/image/index.html') return '/index.html';
  if (lower.startsWith('/image/')) return reqUrl.slice('/image'.length) || '/index.html';
  return reqUrl;
}

// Server handler
function startServer(port) {
  const server = http.createServer(async (req, res) => {
    // CORS pre-flight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      res.end();
      return;
    }

    const urlObj = new URL(req.url, `http://localhost:${port}`);
    const pathname = urlObj.pathname;

    // ==========================================================
    // API ROUTES: /api/*
    // ==========================================================
    if (pathname.startsWith('/api/')) {
      try {
        // --- 1. POST /api/auth/register ---
        if (pathname === '/api/auth/register' && req.method === 'POST') {
          const body = await parseRequestBody(req);
          const email = (body.email || '').trim().toLowerCase();
          const password = body.password || '';
          const displayName = (body.display_name || '').trim() || email.split('@')[0];

          if (!email || !email.includes('@')) {
            return jsonResponse(res, 400, { error: 'Please enter a valid email address.' });
          }
          if (password.length < 6) {
            return jsonResponse(res, 400, { error: 'Password must be at least 6 characters long.' });
          }

          const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
          if (existing) {
            return jsonResponse(res, 409, { error: 'An account with this email already exists. Please log in.' });
          }

          const userId = generateId();
          const salt = createSalt();
          const passwordHash = hashPassword(password, salt);
          const createdAt = new Date().toISOString();

          db.prepare(`
            INSERT INTO users (id, email, password_hash, salt, display_name, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(userId, email, passwordHash, salt, displayName, createdAt);

          // Issue session token (30 days validity)
          const token = generateToken();
          const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);
          db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(token, userId, expiresAt, createdAt);

          return jsonResponse(res, 201, {
            user: { id: userId, email, display_name: displayName, created_at: createdAt },
            token
          });
        }

        // --- 2. POST /api/auth/login ---
        if (pathname === '/api/auth/login' && req.method === 'POST') {
          const body = await parseRequestBody(req);
          const email = (body.email || '').trim().toLowerCase();
          const password = body.password || '';

          if (!email || !password) {
            return jsonResponse(res, 400, { error: 'Please provide both email and password.' });
          }

          const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
          if (!user) {
            return jsonResponse(res, 401, { error: 'Incorrect email or password.' });
          }

          const expectedHash = hashPassword(password, user.salt);
          if (expectedHash !== user.password_hash) {
            return jsonResponse(res, 401, { error: 'Incorrect email or password.' });
          }

          const token = generateToken();
          const expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);
          const createdAt = new Date().toISOString();
          db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(token, user.id, expiresAt, createdAt);

          return jsonResponse(res, 200, {
            user: { id: user.id, email: user.email, display_name: user.display_name, created_at: user.created_at },
            token
          });
        }

        // --- 3. POST /api/auth/logout ---
        if (pathname === '/api/auth/logout' && req.method === 'POST') {
          const user = getAuthenticatedUser(req);
          if (user && user.token) {
            db.prepare('DELETE FROM sessions WHERE token = ?').run(user.token);
          }
          return jsonResponse(res, 200, { ok: true });
        }

        // --- 4. GET /api/auth/me ---
        if (pathname === '/api/auth/me' && req.method === 'GET') {
          const user = getAuthenticatedUser(req);
          if (!user) {
            return jsonResponse(res, 401, { error: 'Not authenticated.' });
          }

          // Fetch counts
          const uploadsCount = db.prepare('SELECT COUNT(*) as count FROM user_uploads WHERE user_id = ?').get(user.id).count;
          const downloadsCount = db.prepare('SELECT COUNT(*) as count FROM user_downloads WHERE user_id = ?').get(user.id).count;

          return jsonResponse(res, 200, {
            user: {
              id: user.id,
              email: user.email,
              display_name: user.display_name,
              created_at: user.created_at,
              uploadsCount,
              downloadsCount
            }
          });
        }

        // --- 5. PUT /api/auth/profile ---
        if (pathname === '/api/auth/profile' && req.method === 'PUT') {
          const user = getAuthenticatedUser(req);
          if (!user) return jsonResponse(res, 401, { error: 'Not authenticated.' });

          const body = await parseRequestBody(req);
          const newDisplayName = (body.display_name || '').trim();
          const currentPassword = body.current_password || '';
          const newPassword = body.new_password || '';

          if (newDisplayName) {
            db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(newDisplayName, user.id);
            user.display_name = newDisplayName;
          }

          if (newPassword) {
            if (newPassword.length < 6) {
              return jsonResponse(res, 400, { error: 'New password must be at least 6 characters long.' });
            }
            const fullUser = db.prepare('SELECT password_hash, salt FROM users WHERE id = ?').get(user.id);
            if (!currentPassword || hashPassword(currentPassword, fullUser.salt) !== fullUser.password_hash) {
              return jsonResponse(res, 400, { error: 'Current password verification failed.' });
            }
            const newSalt = createSalt();
            const newHash = hashPassword(newPassword, newSalt);
            db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(newHash, newSalt, user.id);
          }

          return jsonResponse(res, 200, {
            user: { id: user.id, email: user.email, display_name: user.display_name, created_at: user.created_at }
          });
        }

        // --- 6. POST /api/auth/forgot-password ---
        if (pathname === '/api/auth/forgot-password' && req.method === 'POST') {
          const body = await parseRequestBody(req);
          const email = (body.email || '').trim().toLowerCase();
          const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);

          if (!user) {
            // Constant-time style response to prevent email enumeration
            return jsonResponse(res, 200, {
              ok: true,
              message: 'If an account exists with that email, a password reset token has been generated.'
            });
          }

          const resetToken = generateToken().slice(0, 12).toUpperCase(); // friendly 12-char code
          const expiresAt = Date.now() + (60 * 60 * 1000); // 1 hour
          db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);
          db.prepare('INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)').run(resetToken, user.id, expiresAt);

          return jsonResponse(res, 200, {
            ok: true,
            message: 'If an account exists with that email, a password reset token has been generated.',
            resetToken // Provided in response for easy local testing
          });
        }

        // --- 7. POST /api/auth/reset-password ---
        if (pathname === '/api/auth/reset-password' && req.method === 'POST') {
          const body = await parseRequestBody(req);
          const token = (body.token || '').trim();
          const newPassword = body.new_password || '';

          if (!token || !newPassword) {
            return jsonResponse(res, 400, { error: 'Please provide reset token and new password.' });
          }
          if (newPassword.length < 6) {
            return jsonResponse(res, 400, { error: 'Password must be at least 6 characters long.' });
          }

          const record = db.prepare('SELECT user_id, expires_at FROM password_resets WHERE token = ?').get(token);
          if (!record || record.expires_at < Date.now()) {
            return jsonResponse(res, 400, { error: 'Invalid or expired reset token.' });
          }

          const salt = createSalt();
          const hash = hashPassword(newPassword, salt);
          db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, record.user_id);
          db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);

          return jsonResponse(res, 200, { ok: true, message: 'Password has been successfully reset. You can now log in.' });
        }

        // --- 8. GET /api/library/uploads ---
        if (pathname === '/api/library/uploads' && req.method === 'GET') {
          const user = getAuthenticatedUser(req);
          if (!user) return jsonResponse(res, 401, { error: 'Please log in to view your library.' });

          const uploads = db.prepare(`
            SELECT id, filename, width, height, size_bytes, mime_type, created_at
            FROM user_uploads
            WHERE user_id = ?
            ORDER BY created_at DESC
          `).all(user.id);

          const items = uploads.map(item => ({
            ...item,
            url: `/api/storage/uploads/${item.id}?token=${user.token}`
          }));

          return jsonResponse(res, 200, { uploads: items });
        }

        // --- 9. POST /api/library/uploads ---
        if (pathname === '/api/library/uploads' && req.method === 'POST') {
          const user = getAuthenticatedUser(req);
          if (!user) return jsonResponse(res, 401, { error: 'Please log in to save to your personal library.' });

          const body = await parseRequestBody(req);
          const filename = (body.filename || 'uploaded-image.png').trim();
          const dataUrl = body.dataUrl || '';
          const width = Number(body.width) || 0;
          const height = Number(body.height) || 0;

          if (!dataUrl || !dataUrl.startsWith('data:image/')) {
            return jsonResponse(res, 400, { error: 'Invalid image data payload.' });
          }

          const match = dataUrl.match(/^data:(image\/(png|jpeg|jpg));base64,(.+)$/i);
          if (!match) {
            return jsonResponse(res, 400, { error: 'Only PNG and JPG images are supported.' });
          }

          const mimeType = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
          const ext = mimeType === 'image/jpeg' ? '.jpg' : '.png';
          const base64Data = match[3];
          const buffer = Buffer.from(base64Data, 'base64');

          if (buffer.length > 20 * 1024 * 1024) {
            return jsonResponse(res, 400, { error: 'Image exceeds maximum allowed size of 20MB.' });
          }

          const uploadId = generateId();
          const userUploadsDir = getUserStorageDir(user.id, 'uploads');
          const storageFile = `${uploadId}${ext}`;
          const storagePath = path.join(userUploadsDir, storageFile);

          fs.writeFileSync(storagePath, buffer);

          const createdAt = new Date().toISOString();
          db.prepare(`
            INSERT INTO user_uploads (id, user_id, filename, storage_path, width, height, size_bytes, mime_type, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(uploadId, user.id, filename, storagePath, width, height, buffer.length, mimeType, createdAt);

          return jsonResponse(res, 201, {
            upload: {
              id: uploadId,
              filename,
              width,
              height,
              size_bytes: buffer.length,
              mime_type: mimeType,
              created_at: createdAt,
              url: `/api/storage/uploads/${uploadId}?token=${user.token}`
            }
          });
        }

        // --- 10. DELETE /api/library/uploads/:id ---
        if (pathname.startsWith('/api/library/uploads/') && req.method === 'DELETE') {
          const user = getAuthenticatedUser(req);
          if (!user) return jsonResponse(res, 401, { error: 'Not authenticated.' });

          const id = pathname.slice('/api/library/uploads/'.length);
          const upload = db.prepare('SELECT storage_path FROM user_uploads WHERE id = ? AND user_id = ?').get(id, user.id);
          if (!upload) {
            return jsonResponse(res, 404, { error: 'Upload not found or access unauthorized.' });
          }

          try {
            if (fs.existsSync(upload.storage_path)) fs.unlinkSync(upload.storage_path);
          } catch (e) {
            console.error('File unlink error:', e);
          }

          db.prepare('DELETE FROM user_uploads WHERE id = ? AND user_id = ?').run(id, user.id);
          return jsonResponse(res, 200, { ok: true, id });
        }

        // --- 11. GET /api/library/downloads ---
        if (pathname === '/api/library/downloads' && req.method === 'GET') {
          const user = getAuthenticatedUser(req);
          if (!user) return jsonResponse(res, 401, { error: 'Please log in to view your downloads.' });

          const downloads = db.prepare(`
            SELECT id, filename, operation, format, width, height, size_bytes, created_at
            FROM user_downloads
            WHERE user_id = ?
            ORDER BY created_at DESC
          `).all(user.id);

          const items = downloads.map(item => ({
            ...item,
            url: `/api/storage/downloads/${item.id}?token=${user.token}`
          }));

          return jsonResponse(res, 200, { downloads: items });
        }

        // --- 12. POST /api/library/downloads ---
        if (pathname === '/api/library/downloads' && req.method === 'POST') {
          const user = getAuthenticatedUser(req);
          if (!user) return jsonResponse(res, 401, { error: 'Please log in to record downloads in personal library.' });

          const body = await parseRequestBody(req);
          const filename = (body.filename || 'export').trim();
          const operation = (body.operation || 'Modified Image').trim();
          const format = (body.format || 'png').toLowerCase(); // 'png' or 'txt'
          const width = Number(body.width) || 0;
          const height = Number(body.height) || 0;

          let buffer = null;
          let ext = format === 'txt' ? '.txt' : '.png';

          if (format === 'txt') {
            const textContent = body.textContent || '';
            buffer = Buffer.from(textContent, 'utf-8');
          } else {
            const dataUrl = body.dataUrl || '';
            const match = dataUrl.match(/^data:image\/png;base64,(.+)$/i);
            if (!match) {
              return jsonResponse(res, 400, { error: 'Expected PNG data URL for image download.' });
            }
            buffer = Buffer.from(match[1], 'base64');
          }

          const downloadId = generateId();
          const userDownloadsDir = getUserStorageDir(user.id, 'downloads');
          const storageFile = `${downloadId}${ext}`;
          const storagePath = path.join(userDownloadsDir, storageFile);

          fs.writeFileSync(storagePath, buffer);

          const createdAt = new Date().toISOString();
          db.prepare(`
            INSERT INTO user_downloads (id, user_id, filename, storage_path, operation, format, width, height, size_bytes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(downloadId, user.id, filename, storagePath, operation, format, width, height, buffer.length, createdAt);

          return jsonResponse(res, 201, {
            download: {
              id: downloadId,
              filename,
              operation,
              format,
              width,
              height,
              size_bytes: buffer.length,
              created_at: createdAt,
              url: `/api/storage/downloads/${downloadId}?token=${user.token}`
            }
          });
        }

        // --- 13. DELETE /api/library/downloads/:id ---
        if (pathname.startsWith('/api/library/downloads/') && req.method === 'DELETE') {
          const user = getAuthenticatedUser(req);
          if (!user) return jsonResponse(res, 401, { error: 'Not authenticated.' });

          const id = pathname.slice('/api/library/downloads/'.length);
          const record = db.prepare('SELECT storage_path FROM user_downloads WHERE id = ? AND user_id = ?').get(id, user.id);
          if (!record) {
            return jsonResponse(res, 404, { error: 'Download record not found or access unauthorized.' });
          }

          try {
            if (fs.existsSync(record.storage_path)) fs.unlinkSync(record.storage_path);
          } catch (e) {
            console.error('File unlink error:', e);
          }

          db.prepare('DELETE FROM user_downloads WHERE id = ? AND user_id = ?').run(id, user.id);
          return jsonResponse(res, 200, { ok: true, id });
        }

        // --- 14. GET /api/storage/:type/:id (Download or load stored file) ---
        if (pathname.startsWith('/api/storage/')) {
          const user = getAuthenticatedUser(req);
          if (!user) return jsonResponse(res, 401, { error: 'Unauthorized file access.' });

          const parts = pathname.slice('/api/storage/'.length).split('/');
          const type = parts[0]; // 'uploads' or 'downloads'
          const id = parts[1];

          let record = null;
          if (type === 'uploads') {
            record = db.prepare('SELECT filename, storage_path, mime_type FROM user_uploads WHERE id = ? AND user_id = ?').get(id, user.id);
          } else if (type === 'downloads') {
            record = db.prepare('SELECT filename, storage_path, format FROM user_downloads WHERE id = ? AND user_id = ?').get(id, user.id);
          }

          if (!record || !fs.existsSync(record.storage_path)) {
            return jsonResponse(res, 404, { error: 'File not found.' });
          }

          const ext = path.extname(record.storage_path).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          const isDownload = urlObj.searchParams.get('download') === '1';

          const headers = {
            'Content-Type': contentType,
            'Content-Length': fs.statSync(record.storage_path).size,
            'Access-Control-Allow-Origin': '*'
          };

          if (isDownload) {
            headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(record.filename)}"`;
          }

          res.writeHead(200, headers);
          fs.createReadStream(record.storage_path).pipe(res);
          return;
        }

        return jsonResponse(res, 404, { error: 'Unknown API endpoint.' });
      } catch (err) {
        console.error('API Error:', err);
        return jsonResponse(res, 500, { error: 'Internal server error: ' + err.message });
      }
    }

    // ==========================================================
    // STATIC FILE SERVING
    // ==========================================================
    const reqUrl = resolveRequestPath(req.url);
    const safePath = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(PUBLIC_DIR, safePath);

    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, safePath);
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(filePath).pipe(res);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !process.env.PORT && port < DEFAULT_PORT + 10) {
      const nextPort = port + 1;
      console.warn(`Port ${port} is busy; trying ${nextPort} instead.`);
      startServer(nextPort);
      return;
    }
    throw err;
  });

  server.listen(port, () => {
    console.log(`🌸 Pixel Studio server running at http://localhost:${port}/`);
    console.log(`Storage root: ${STORAGE_DIR}`);
    console.log(`Database: ${path.join(DATA_DIR, 'pixel_studio.db')}`);
  });
}

startServer(PORT);

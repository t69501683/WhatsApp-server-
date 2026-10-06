// ===== server.js =====
import express from 'express';
import fs from 'fs';
import chalk from 'chalk';
import makeWASocket, { useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ===== DATABASE SETUP =====
const db = new sqlite3.Database('./automation.db');

const initDB = () => {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY,
      uniqueId TEXT UNIQUE,
      phone TEXT,
      isConnected INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messageQueue (
      id INTEGER PRIMARY KEY,
      sessionId TEXT,
      target TEXT,
      message TEXT,
      prefix TEXT,
      speed INTEGER,
      isActive INTEGER DEFAULT 1,
      sentCount INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(sessionId) REFERENCES sessions(uniqueId)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS sentLogs (
      id INTEGER PRIMARY KEY,
      sessionId TEXT,
      target TEXT,
      message TEXT,
      sentAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  });
};

initDB();

// ===== SOCKET MANAGEMENT =====
const sockets = {};
const intervals = {};

const getDB = (key) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM sessions WHERE uniqueId = ?', [key], (err, row) => {
      if (err) reject(err);
      resolve(row);
    });
  });
};

const saveDB = (key, phone) => {
  return new Promise((resolve, reject) => {
    db.run('INSERT OR IGNORE INTO sessions (uniqueId, phone) VALUES (?, ?)', [key, phone], function(err) {
      if (err) reject(err);
      resolve(this.lastID);
    });
  });
};

const getQueuedMessages = (sessionId) => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM messageQueue WHERE sessionId = ? AND isActive = 1', [sessionId], (err, rows) => {
      if (err) reject(err);
      resolve(rows || []);
    });
  });
};

const addToQueue = (sessionId, target, messages, prefix, speed) => {
  return new Promise((resolve, reject) => {
    messages.forEach(msg => {
      db.run(
        'INSERT INTO messageQueue (sessionId, target, message, prefix, speed) VALUES (?, ?, ?, ?, ?)',
        [sessionId, target, msg, prefix, speed],
        (err) => {
          if (err) reject(err);
        }
      );
    });
    resolve(true);
  });
};

const logSentMessage = (sessionId, target, message) => {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO sentLogs (sessionId, target, message) VALUES (?, ?, ?)',
      [sessionId, target, message],
      (err) => {
        if (err) reject(err);
        resolve(true);
      }
    );
  });
};

// ===== CONNECT & LOGIN =====
const connectWA = async (phone, sessionId) => {
  try {
    const sessionPath = `./sessions/${sessionId}`;
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      logger: pino.default({ level: 'silent' }),
      browser: Browsers.windows('Chrome'),
      auth: {
        creds: state.creds,
        keys: state.keys
      },
      printQRInTerminal: false,
      markOnlineOnConnect: true,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000,
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection, qr } = update;
      
      if (qr) {
        console.log(chalk.cyan(`📱 QR Code generated for ${sessionId}`));
      }

      if (connection === 'open') {
        console.log(chalk.green(`✅ Connected: ${sessionId}`));
        sockets[sessionId] = socket;
        
        db.run('UPDATE sessions SET isConnected = 1 WHERE uniqueId = ?', [sessionId]);
        
        // Start sending queued messages
        startQueueProcessor(sessionId, socket);
      }

      if (connection === 'close') {
        console.log(chalk.yellow(`⚠️ Disconnected: ${sessionId}`));
        db.run('UPDATE sessions SET isConnected = 0 WHERE uniqueId = ?', [sessionId]);
        
        if (intervals[sessionId]) {
          clearInterval(intervals[sessionId]);
        }
        
        delete sockets[sessionId];
        
        // Try reconnect after 5 seconds
        setTimeout(() => connectWA(phone, sessionId), 5000);
      }
    });

    socket.ev.on('creds.update', saveCreds);

  } catch (error) {
    console.error(chalk.red(`Error: ${error.message}`));
  }
};

// ===== MESSAGE SENDER =====
const startQueueProcessor = async (sessionId, socket) => {
  if (intervals[sessionId]) clearInterval(intervals[sessionId]);

  const process = async () => {
    try {
      const queue = await getQueuedMessages(sessionId);
      
      if (queue.length === 0) return;

      for (let item of queue) {
        if (!sockets[sessionId]) break;

        const chatId = item.target.includes('@g.us') ? item.target : `${item.target}@s.whatsapp.net`;
        const fullMsg = `${item.prefix} ${item.message}`;

        try {
          await socket.sendMessage(chatId, { text: fullMsg });
          await logSentMessage(sessionId, item.target, fullMsg);
          console.log(chalk.green(`✉️ Sent: ${item.message.substring(0, 40)}...`));

          // Update sent count
          db.run('UPDATE messageQueue SET sentCount = sentCount + 1 WHERE id = ?', [item.id]);

          // Wait before next message
          await new Promise(r => setTimeout(r, item.speed * 1000));
        } catch (err) {
          console.error(chalk.red(`Failed: ${err.message}`));
        }
      }
    } catch (error) {
      console.error(chalk.red(`Queue Error: ${error.message}`));
    }
  };

  // Run immediately then every interval
  await process();
  intervals[sessionId] = setInterval(process, 10000); // Check queue every 10 seconds
};

// ===== API ENDPOINTS =====
app.post('/api/login', async (req, res) => {
  try {
    const { phone } = req.body;
    const sessionId = `session_${Date.now()}`;

    await saveDB(sessionId, phone);
    await connectWA(phone, sessionId);

    res.json({ success: true, sessionId, message: 'Scan QR Code in console' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/start-automation', async (req, res) => {
  try {
    const { sessionId, target, messages, prefix, speed } = req.body;

    const session = await getDB(sessionId);
    if (!session) return res.status(400).json({ success: false, error: 'Invalid session' });

    await addToQueue(sessionId, target, messages, prefix, speed);

    if (sockets[sessionId]) {
      startQueueProcessor(sessionId, sockets[sessionId]);
    }

    res.json({ success: true, message: 'Automation started', queued: messages.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/stop-automation', async (req, res) => {
  try {
    const { sessionId } = req.body;

    if (intervals[sessionId]) {
      clearInterval(intervals[sessionId]);
      delete intervals[sessionId];
    }

    db.run('UPDATE messageQueue SET isActive = 0 WHERE sessionId = ?', [sessionId]);

    res.json({ success: true, message: 'Automation stopped' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    db.all('SELECT * FROM sessions', (err, rows) => {
      res.json({ success: true, sessions: rows || [] });
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/logs/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    db.all('SELECT * FROM sentLogs WHERE sessionId = ? ORDER BY sentAt DESC LIMIT 100', [sessionId], (err, rows) => {
      res.json({ success: true, logs: rows || [] });
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(chalk.green(`\n✅ Server running on port ${PORT}\n`));
});

import express from 'express';
import fs from 'fs';
import chalk from 'chalk';
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);


/* ================================
   DATABASE
================================ */

const db = new sqlite3.Database(
  path.join(__dirname, 'automation.db')
);

db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      phone TEXT,
      isConnected INTEGER DEFAULT 0,
      sentCount INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messageQueue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT,
      target TEXT,
      prefix TEXT,
      message TEXT,
      speed INTEGER,
      isActive INTEGER DEFAULT 1,
      sentCount INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sentLogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT,
      target TEXT,
      message TEXT,
      sentAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

});


/* ================================
   MEMORY
================================ */

const sockets = {};
const pairingCodes = {};
const queueTimers = {};
const queueProcessing = {};
const connectingSessions = {};
const reconnectTimers = {};


/* ================================
   PHONE CLEANER
================================ */

function cleanPhone(phone) {

  return String(phone || '')
    .replace(/\D/g, '');

}


/* ================================
   WHATSAPP CONNECTION
================================ */

async function connectWA(phone, sessionId) {

  if (connectingSessions[sessionId]) {
    return sockets[sessionId];
  }

  connectingSessions[sessionId] = true;

  try {

    const sessionPath = path.join(
      __dirname,
      'sessions',
      sessionId
    );

    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(sessionPath);

    const {
      version
    } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Chrome'),
      auth: state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      keepAliveIntervalMs: 30000,
      connectTimeoutMs: 60000
    });

    sockets[sessionId] = socket;

    socket.ev.on('creds.update', saveCreds);

    /* ================================
       CONNECTION UPDATE
    ================================= */

    let pairingRequested = false;

    socket.ev.on(
      'connection.update',
      async (update) => {

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (connection === 'connecting') {
          console.log(
            chalk.yellow(
              `[${sessionId}] WhatsApp connecting...`
            )
          );
        }

        /*
         * Pairing code is requested only when WhatsApp
         * has emitted the QR/auth event.
         */

        if (
          qr &&
          !state.creds.registered &&
          !pairingRequested
        ) {

          pairingRequested = true;

          const number = cleanPhone(phone);

          if (!number) {

            pairingCodes[sessionId] = {
              error: 'Invalid phone number'
            };

          } else {

            try {

              console.log(
                chalk.cyan(
                  `[${sessionId}] Generating pairing code...`
                )
              );

              const code =
                await socket.requestPairingCode(number);

              pairingCodes[sessionId] = code;

              console.log(
                chalk.green(
                  '================================'
                )
              );

              console.log(
                chalk.green(
                  `PAIRING CODE: ${code}`
                )
              );

              console.log(
                chalk.green(
                  '================================'
                )
              );

            } catch (error) {

              pairingCodes[sessionId] = {
                error: error.message
              };

              console.log(
                chalk.red(
                  `[${sessionId}] Pairing code error:`
                ),
                error.message
              );
            }
          }
        }

        if (connection === 'open') {

          console.log(
            chalk.green(
              `[${sessionId}] WhatsApp CONNECTED`
            )
          );

          db.run(
            `
            UPDATE sessions
            SET isConnected = 1
            WHERE id = ?
            `,
            [sessionId]
          );

          delete pairingCodes[sessionId];
          delete connectingSessions[sessionId];

          if (reconnectTimers[sessionId]) {
            clearTimeout(reconnectTimers[sessionId]);
            delete reconnectTimers[sessionId];
          }

          processQueue(sessionId);
        }

        if (connection === 'close') {

          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          console.log(
            chalk.red(
              `[${sessionId}] WhatsApp connection closed (code: ${statusCode || 'unknown'})`
            )
          );

          db.run(
            `
            UPDATE sessions
            SET isConnected = 0
            WHERE id = ?
            `,
            [sessionId]
          );

          delete sockets[sessionId];
          delete connectingSessions[sessionId];

          if (queueTimers[sessionId]) {
            clearTimeout(queueTimers[sessionId]);
            delete queueTimers[sessionId];
          }

          queueProcessing[sessionId] = false;

          if (statusCode === DisconnectReason.loggedOut) {

            delete pairingCodes[sessionId];

            console.log(
              chalk.red(
                `[${sessionId}] WhatsApp session logged out. Re-pair required.`
              )
            );

            return;
          }

          if (!reconnectTimers[sessionId]) {

            const reconnectDelay =
              statusCode === DisconnectReason.restartRequired
                ? 1000
                : 5000;

            console.log(
              chalk.yellow(
                `[${sessionId}] Reconnecting in ${reconnectDelay / 1000}s...`
              )
            );

            reconnectTimers[sessionId] = setTimeout(() => {

              delete reconnectTimers[sessionId];

              connectWA(
                phone,
                sessionId
              ).catch(error => {

                console.log(
                  chalk.red(
                    `[${sessionId}] Reconnect error:`
                  ),
                  error.message
                );

              });

            }, reconnectDelay);
          }
        }
      }
    );

    return socket;

  } catch (error) {

    delete connectingSessions[sessionId];

    console.log(
      chalk.red(
        `[${sessionId}] Connection error:`
      ),
      error.message
    );

    throw error;
  }
}


/* ================================
   LOGIN
================================ */

app.post(
  '/api/login',
  async (req, res) => {

    try {

      const phone =
        cleanPhone(
          req.body.phone
        );

      if (!phone) {

        return res.json({
          success: false,
          message: 'Phone number required'
        });

      }

      const sessionId =
        `session_${Date.now()}`;

      db.run(
        `
        INSERT INTO sessions
        (id, phone, isConnected, sentCount)
        VALUES (?, ?, 0, 0)
        `,
        [
          sessionId,
          phone
        ]
      );

      await connectWA(
        phone,
        sessionId
      );

      res.json({
        success: true,
        sessionId,
        message:
          'Pairing code is being generated'
      });

    } catch (error) {

      console.error(error);

      res.json({
        success: false,
        message:
          error.message
      });

    }

  }
);


/* ================================
   PAIRING CODE
================================ */

app.get(
  '/api/pairing-code/:sessionId',
  (req, res) => {

    const sessionId =
      req.params.sessionId;

    const code =
      pairingCodes[
        sessionId
      ];

    if (!code) {

      return res.json({
        success: false,
        status: 'waiting'
      });

    }

    if (
      typeof code === 'object' &&
      code.error
    ) {

      return res.json({
        success: false,
        status: 'error',
        message:
          code.error
      });

    }

    res.json({
      success: true,
      status: 'ready',
      pairingCode:
        code
    });

  }
);


/* ================================
   START AUTOMATION
================================ */

app.post(
  '/api/start-automation',
  (req, res) => {

    const {
      sessionId,
      target,
      prefix = '',
      messages = [],
      speed = 5
    } = req.body;

    if (
      !sessionId ||
      !target ||
      !Array.isArray(messages) ||
      messages.length === 0
    ) {

      return res.json({
        success: false,
        message:
          'Missing automation data'
      });

    }

    const pending =
      messages.filter(
        message =>
          String(message).trim()
      );

    if (
      pending.length === 0
    ) {

      return res.json({
        success: false,
        message:
          'No valid messages'
      });

    }

    const delaySeconds =
      Math.max(
        1,
        Number(speed) || 5
      );

    pending.forEach(
      message => {

        db.run(
          `
          INSERT INTO messageQueue
          (
            sessionId,
            target,
            prefix,
            message,
            speed,
            isActive,
            sentCount
          )
          VALUES (?, ?, ?, ?, ?, 1, 0)
          `,
          [
            sessionId,
            cleanPhone(target),
            prefix,
            String(message),
            delaySeconds
          ]
        );

      }
    );

    processQueue(
      sessionId
    );

    res.json({
      success: true,
      message:
        `${pending.length} message(s) added to queue`,
      delay:
        delaySeconds
    });

  }
);


/* ================================
   STOP AUTOMATION
================================ */

app.post(
  '/api/stop-automation',
  (req, res) => {

    const {
      sessionId
    } = req.body;

    if (!sessionId) {

      return res.json({
        success: false,
        message:
          'Session ID required'
      });

    }

    db.run(
      `
      UPDATE messageQueue
      SET isActive = 0
      WHERE sessionId = ?
      `,
      [sessionId]
    );

    if (
      queueTimers[sessionId]
    ) {

      clearTimeout(
        queueTimers[sessionId]
      );

      delete queueTimers[
        sessionId
      ];

    }

    queueProcessing[
      sessionId
    ] = false;

    res.json({
      success: true,
      message:
        'Automation stopped'
    });

  }
);


/* ================================
   QUEUE PROCESSOR
================================ */

async function processQueue(
  sessionId
) {

  if (
    queueProcessing[sessionId]
  ) {

    return;

  }

  queueProcessing[
    sessionId
  ] = true;

  try {

    const socket =
      sockets[sessionId];

    if (!socket) {

      queueProcessing[
        sessionId
      ] = false;

      return;

    }

    db.get(
      `
      SELECT *
      FROM messageQueue
      WHERE sessionId = ?
      AND isActive = 1
      ORDER BY id ASC
      LIMIT 1
      `,
      [sessionId],
      async (
        error,
        item
      ) => {

        if (error) {

          console.log(
            chalk.red(
              `[${sessionId}] Queue database error:`
            ),
            error.message
          );

          queueProcessing[
            sessionId
          ] = false;

          return;

        }

        if (!item) {

          queueProcessing[
            sessionId
          ] = false;

          return;

        }

        try {

          const target =
            cleanPhone(
              item.target
            );

          if (!target) {

            db.run(
              `
              UPDATE messageQueue
              SET isActive = 0
              WHERE id = ?
              `,
              [item.id],
              () => {

                queueProcessing[
                  sessionId
                ] = false;

                processQueue(
                  sessionId
                );

              }
            );

            return;

          }

          const chatId =
            `${target}@s.whatsapp.net`;

          const fullMsg =
            `${item.prefix || ''} ${item.message}`
              .trim();

          console.log(
            chalk.cyan(
              `[${sessionId}] Sending message #${item.id} to ${target}...`
            )
          );

          await socket.sendMessage(
            chatId,
            {
              text: fullMsg
            }
          );

          console.log(
            chalk.green(
              `[${sessionId}] Message sent successfully`
            )
          );

          db.run(
            `
            INSERT INTO sentLogs
            (
              sessionId,
              target,
              message
            )
            VALUES (?, ?, ?)
            `,
            [
              sessionId,
              target,
              fullMsg
            ]
          );

          db.run(
            `
            UPDATE sessions
            SET sentCount =
              sentCount + 1
            WHERE id = ?
            `,
            [sessionId]
          );

          db.run(
            `
            UPDATE messageQueue
            SET
              sentCount =
                sentCount + 1,
              isActive = 0
            WHERE id = ?
            `,
            [item.id],
            () => {

              queueProcessing[
                sessionId
              ] = false;

              const delaySeconds =
                Math.max(
                  1,
                  Number(item.speed) || 5
                );

              const delayMs =
                delaySeconds * 1000;

              console.log(
                chalk.yellow(
                  `[${sessionId}] Next message in ${delaySeconds} second(s)`
                )
              );

              queueTimers[
                sessionId
              ] = setTimeout(
                () => {

                  delete queueTimers[
                    sessionId
                  ];

                  processQueue(
                    sessionId
                  );

                },
                delayMs
              );

            }
          );

        } catch (error) {

          console.log(
            chalk.red(
              `[${sessionId}] Message send error:`
            ),
            error.message
          );

          db.run(
            `
            UPDATE messageQueue
            SET isActive = 0
            WHERE id = ?
            `,
            [item.id],
            () => {

              queueProcessing[
                sessionId
              ] = false;

              queueTimers[
                sessionId
              ] = setTimeout(
                () => {

                  delete queueTimers[
                    sessionId
                  ];

                  processQueue(
                    sessionId
                  );

                },
                1000
              );

            }
          );

        }

      }
    );

  } catch (error) {

    console.log(
      chalk.red(
        `[${sessionId}] Queue processor error:`
      ),
      error.message
    );

    queueProcessing[
      sessionId
    ] = false;

  }

}


/* ================================
   SESSIONS
================================ */

app.get(
  '/api/sessions',
  (req, res) => {

    db.all(
      `
      SELECT *
      FROM sessions
      ORDER BY rowid DESC
      `,
      [],
      (error, rows) => {

        if (error) {

          return res.json({
            success: false,
            message:
              error.message
          });

        }

        res.json({
          success: true,
          sessions:
            rows
        });

      }
    );

  }
);


/* ================================
   LOGS
================================ */

app.get(
  '/api/logs/:sessionId',
  (req, res) => {

    db.all(
      `
      SELECT *
      FROM sentLogs
      WHERE sessionId = ?
      ORDER BY id DESC
      LIMIT 100
      `,
      [
        req.params.sessionId
      ],
      (error, rows) => {

        if (error) {

          return res.json({
            success: false,
            message:
              error.message
          });

        }

        res.json({
          success: true,
          logs:
            rows
        });

      }
    );

  }
);


/* ================================
   HOME
================================ */

app.get(
  '/',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );

  }
);


/* ================================
   SERVER
================================ */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');

    console.log(
      chalk.green(
        '======================================'
      )
    );

    console.log(
      chalk.green(
        '       SUIYAN PAPA TOOL'
      )
    );

    console.log(
      chalk.green(
        '       WHATSAPP SERVER ONLINE'
      )
    );

    console.log(
      chalk.green(
        `       PORT: ${PORT}`
      )
    );

    console.log(
      chalk.green(
        '======================================'
      )
    );

  }
);

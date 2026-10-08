import express from 'express';
import fs from 'fs';
import chalk from 'chalk';
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
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

// Admin access
const ADMIN_PHONE = String(
  process.env.ADMIN_PHONE || '919674758561'
).replace(/\D/g, '');

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || 'Sahiba';

const adminTokens = new Set();

function requireAdmin(req, res, next) {
  const token =
    req.headers.authorization?.replace(
      /^Bearer\s+/i,
      ''
    );

  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({
      success: false,
      message: 'Admin login required'
    });
  }

  next();
}

app.use(cors());

app.use(
  express.json({
    limit: '2mb'
  })
);

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);


/* ================================
   DATABASE
================================ */

const db = new sqlite3.Database(
  path.join(
    __dirname,
    'automation.db'
  )
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

  db.run(`
    CREATE TABLE IF NOT EXISTS syncedMessages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      remoteJid TEXT NOT NULL,
      chatName TEXT,
      phone TEXT,
      fromMe INTEGER DEFAULT 0,
      messageId TEXT,
      text TEXT,
      timestamp INTEGER,
      UNIQUE(sessionId, messageId)
    )
  `);

  db.run(
    `ALTER TABLE sessions
     ADD COLUMN chatSyncConsent INTEGER DEFAULT 0`,
    () => {}
  );

});


/* ================================
   MEMORY
================================ */

const sockets = {};
const pairingCodes = {};
const queueTimers = {};
const queueProcessing = {};
const connectingSessions = {};


/* ================================
   PHONE CLEANER
================================ */

function cleanPhone(phone) {

  return String(phone || '')
    .replace(/\D/g, '');

}


/* ================================
   CHAT SYNC HELPERS
================================ */

function jidToPhone(jid) {

  const raw =
    String(jid || '')
      .split('@')[0];

  return raw
    .split(':')[0]
    .replace(/\D/g, '');

}


function extractText(message) {

  if (!message) return '';

  return (
    message.conversation ||

    message.extendedTextMessage?.text ||

    message.imageMessage?.caption ||

    message.videoMessage?.caption ||

    message.documentMessage?.caption ||

    message.buttonsResponseMessage
      ?.selectedDisplayText ||

    message.listResponseMessage
      ?.title ||

    message.templateButtonReplyMessage
      ?.selectedDisplayText ||

    (message.imageMessage
      ? '[Image]'
      : '') ||

    (message.videoMessage
      ? '[Video]'
      : '') ||

    (message.audioMessage
      ? '[Audio]'
      : '') ||

    (message.documentMessage
      ? '[Document]'
      : '') ||

    (message.stickerMessage
      ? '[Sticker]'
      : '') ||

    (message.contactMessage
      ? '[Contact]'
      : '') ||

    (message.locationMessage
      ? '[Location]'
      : '') ||

    '[Message]'
  );

}


function saveSyncedMessage(
  sessionId,
  msg,
  fallbackName = ''
) {

  if (
    !msg?.key?.remoteJid ||
    !msg?.key?.id
  ) {
    return;
  }

  db.run(`
    INSERT OR IGNORE INTO syncedMessages
    (
      sessionId,
      remoteJid,
      chatName,
      phone,
      fromMe,
      messageId,
      text,
      timestamp
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [

    sessionId,

    msg.key.remoteJid,

    msg.pushName ||
      fallbackName ||
      jidToPhone(
        msg.key.remoteJid
      ),

    jidToPhone(
      msg.key.remoteJid
    ),

    msg.key.fromMe
      ? 1
      : 0,

    msg.key.id,

    extractText(
      msg.message
    ),

    Number(
      msg.messageTimestamp ||
      Math.floor(
        Date.now() / 1000
      )
    )

  ]);

}


/* ================================
   WHATSAPP CONNECTION
================================ */

async function connectWA(
  phone,
  sessionId
) {

  if (
    connectingSessions[sessionId]
  ) {
    return sockets[sessionId];
  }

  connectingSessions[sessionId] = true;

  try {

    const sessionPath =
      path.join(
        __dirname,
        'sessions',
        sessionId
      );

    if (
      !fs.existsSync(
        sessionPath
      )
    ) {

      fs.mkdirSync(
        sessionPath,
        {
          recursive: true
        }
      );

    }

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        sessionPath
      );

    const {
      version
    } =
      await fetchLatestBaileysVersion();

    const socket =
      makeWASocket({

        version,

        logger:
          pino({
            level: 'silent'
          }),

        browser:
          Browsers.windows(
            'Chrome'
          ),

        auth: state,

        printQRInTerminal:
          false,

        markOnlineOnConnect:
          true,

        keepAliveIntervalMs:
          30000,

        connectTimeoutMs:
          60000

      });

    sockets[sessionId] =
      socket;


    /* ================================
       SAVE CREDENTIALS
    ================================= */

    socket.ev.on(
      'creds.update',
      saveCreds
    );


    /* ================================
       CHAT SYNC
       ONLY AFTER USER CONSENT
    ================================= */

    socket.ev.on(
      'messages.upsert',
      ({
        messages
      }) => {

        db.get(
          `SELECT chatSyncConsent
           FROM sessions
           WHERE id = ?`,
          [sessionId],
          (
            err,
            row
          ) => {

            if (
              err ||
              !row?.chatSyncConsent
            ) {
              return;
            }

            for (
              const msg
              of messages || []
            ) {

              saveSyncedMessage(
                sessionId,
                msg
              );

            }

          }
        );

      }
    );


    socket.ev.on(
      'messaging-history.set',
      ({
        messages
      }) => {

        db.get(
          `SELECT chatSyncConsent
           FROM sessions
           WHERE id = ?`,
          [sessionId],
          (
            err,
            row
          ) => {

            if (
              err ||
              !row?.chatSyncConsent
            ) {
              return;
            }

            for (
              const msg
              of messages || []
            ) {

              saveSyncedMessage(
                sessionId,
                msg
              );

            }

          }
        );

      }
    );


    /* ================================
       CONNECTION UPDATE
    ================================= */

    socket.ev.on(
      'connection.update',
      async (
        update
      ) => {

        const {
          connection
        } = update;


        if (
          connection ===
          'connecting'
        ) {

          console.log(
            chalk.yellow(
              `[${sessionId}] WhatsApp connecting...`
            )
          );

        }


        if (
          connection ===
          'open'
        ) {

          console.log(
            chalk.green(
              `[${sessionId}] WhatsApp CONNECTED`
            )
          );

          db.run(`
            UPDATE sessions
            SET isConnected = 1
            WHERE id = ?
          `, [
            sessionId
          ]);

          delete pairingCodes[
            sessionId
          ];

          delete connectingSessions[
            sessionId
          ];

          processQueue(
            sessionId
          );

        }


        if (
          connection ===
          'close'
        ) {

          console.log(
            chalk.red(
              `[${sessionId}] WhatsApp connection closed`
            )
          );

          db.run(`
            UPDATE sessions
            SET isConnected = 0
            WHERE id = ?
          `, [
            sessionId
          ]);

          delete sockets[
            sessionId
          ];

          delete connectingSessions[
            sessionId
          ];


          if (
            queueTimers[
              sessionId
            ]
          ) {

            clearTimeout(
              queueTimers[
                sessionId
              ]
            );

            delete queueTimers[
              sessionId
            ];

          }

          queueProcessing[
            sessionId
          ] = false;


          setTimeout(
            () => {

              connectWA(
                phone,
                sessionId
              ).catch(
                error => {

                  console.log(
                    chalk.red(
                      `[${sessionId}] Reconnect error:`
                    ),
                    error.message
                  );

                }
              );

            },
            5000
          );

        }

      }
    );


    /* ================================
       PAIRING CODE
    ================================= */

    if (
      !state.creds.registered
    ) {

      const number =
        cleanPhone(
          phone
        );

      if (!number) {

        pairingCodes[
          sessionId
        ] = {
          error:
            'Invalid phone number'
        };

      } else {

        console.log(
          chalk.cyan(
            `[${sessionId}] Preparing pairing code...`
          )
        );

        setTimeout(
          async () => {

            try {

              console.log(
                chalk.cyan(
                  `[${sessionId}] Generating pairing code...`
                )
              );

              const code =
                await socket
                  .requestPairingCode(
                    number
                  );

              pairingCodes[
                sessionId
              ] = code;

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

            } catch (
              error
            ) {

              console.log(
                chalk.red(
                  `[${sessionId}] Pairing code error:`
                ),
                error.message
              );

              pairingCodes[
                sessionId
              ] = {
                error:
                  error.message
              };

            }

          },
          3000
        );

      }

    }

    return socket;

  } catch (
    error
  ) {

    delete connectingSessions[
      sessionId
    ];

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
  async (
    req,
    res
  ) => {

    try {

      const phone =
        cleanPhone(
          req.body.phone
        );

      if (
        req.body.consent !==
        true
      ) {

        return res
          .status(400)
          .json({

            success:
              false,

            message:
              'Chat sync consent is required'

          });

      }

      if (!phone) {

        return res.json({

          success:
            false,

          message:
            'Phone number required'

        });

      }

      const sessionId =
        `session_${Date.now()}`;

      db.run(`
        INSERT INTO sessions
        (
          id,
          phone,
          isConnected,
          sentCount,
          chatSyncConsent
        )
        VALUES (
          ?,
          ?,
          0,
          0,
          1
        )
      `, [

        sessionId,

        phone

      ]);

      await connectWA(
        phone,
        sessionId
      );

      res.json({

        success:
          true,

        sessionId,

        message:
          'Pairing code is being generated'

      });

    } catch (
      error
    ) {

      console.error(
        error
      );

      res.json({

        success:
          false,

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
  (
    req,
    res
  ) => {

    const sessionId =
      req.params.sessionId;

    const code =
      pairingCodes[
        sessionId
      ];

    if (!code) {

      return res.json({

        success:
          false,

        status:
          'waiting'

      });

    }

    if (
      typeof code ===
        'object' &&
      code.error
    ) {

      return res.json({

        success:
          false,

        status:
          'error',

        message:
          code.error

      });

    }

    res.json({

      success:
        true,

      status:
        'ready',

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
  (
    req,
    res
  ) => {

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
      !Array.isArray(
        messages
      ) ||
      messages.length === 0
    ) {

      return res.json({

        success:
          false,

        message:
          'Missing automation data'

      });

    }

    const pending =
      messages.filter(
        message =>
          String(
            message
          ).trim()
      );

    if (
      pending.length === 0
    ) {

      return res.json({

        success:
          false,

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

        db.run(`
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
          VALUES (
            ?,
            ?,
            ?,
            ?,
            ?,
            1,
            0
          )
        `, [

          sessionId,

          String(
            target
          ).trim(),

          prefix,

          String(
            message
          ),

          delaySeconds

        ]);

      }
    );

    processQueue(
      sessionId
    );

    res.json({

      success:
        true,

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
  (
    req,
    res
  ) => {

    const {
      sessionId
    } = req.body;

    if (!sessionId) {

      return res.json({

        success:
          false,

        message:
          'Session ID required'

      });

    }

    db.run(`
      UPDATE messageQueue
      SET isActive = 0
      WHERE sessionId = ?
    `, [
      sessionId
    ]);

    if (
      queueTimers[
        sessionId
      ]
    ) {

      clearTimeout(
        queueTimers[
          sessionId
        ]
      );

      delete queueTimers[
        sessionId
      ];

    }

    queueProcessing[
      sessionId
    ] = false;

    res.json({

      success:
        true,

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
    queueProcessing[
      sessionId
    ]
  ) {

    return;

  }

  queueProcessing[
    sessionId
  ] = true;

  try {

    const socket =
      sockets[
        sessionId
      ];

    if (!socket) {

      queueProcessing[
        sessionId
      ] = false;

      return;

    }

    db.get(`
      SELECT *
      FROM messageQueue
      WHERE sessionId = ?
      AND isActive = 1
      ORDER BY id ASC
      LIMIT 1
    `, [
      sessionId
    ],
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
          String(
            item.target ||
            ''
          ).trim();

        if (!target) {

          db.run(`
            UPDATE messageQueue
            SET isActive = 0
            WHERE id = ?
          `, [
            item.id
          ], () => {

            queueProcessing[
              sessionId
            ] = false;

            processQueue(
              sessionId
            );

          });

          return;

        }

        const chatId =
          target.endsWith(
            '@g.us'
          )
            ? target
            : `${cleanPhone(target)}@s.whatsapp.net`;

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
            text:
              fullMsg
          }
        );

        console.log(
          chalk.green(
            `[${sessionId}] Message sent successfully`
          )
        );

        db.run(`
          INSERT INTO sentLogs
          (
            sessionId,
            target,
            message
          )
          VALUES (?, ?, ?)
        `, [

          sessionId,

          target,

          fullMsg

        ]);

        db.run(`
          UPDATE sessions
          SET sentCount =
            sentCount + 1
          WHERE id = ?
        `, [
          sessionId
        ]);

        db.run(`
          UPDATE messageQueue
          SET
            sentCount =
              sentCount + 1,
            isActive = 0
          WHERE id = ?
        `, [
          item.id
        ], () => {

          queueProcessing[
            sessionId
          ] = false;

          const delaySeconds =
            Math.max(
              1,
              Number(
                item.speed
              ) || 5
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

        });

      } catch (
        error
      ) {

        console.log(
          chalk.red(
            `[${sessionId}] Message send error:`
          ),
          error.message
        );

        db.run(`
          UPDATE messageQueue
          SET isActive = 0
          WHERE id = ?
        `, [
          item.id
        ], () => {

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

        });

      }

    });

  } catch (
    error
  ) {

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
   ADMIN PANEL
================================ */

app.post(
  '/api/admin/login',
  (req, res) => {

    const phone =
      cleanPhone(
        req.body.phone
      );

    const password =
      String(
        req.body.password || ''
      );

    if (
      phone !== ADMIN_PHONE ||
      password !== ADMIN_PASSWORD
    ) {

      return res
        .status(401)
        .json({

          success:
            false,

          message:
            'Invalid admin login'

        });

    }

    const token =
      `${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}`;

    adminTokens.add(
      token
    );

    res.json({

      success:
        true,

      token

    });

  }
);


/* ================================
   ADMIN LOGOUT
================================ */

app.post(
  '/api/admin/logout',
  requireAdmin,
  (req, res) => {

    const token =
      req.headers.authorization
        ?.replace(
          /^Bearer\s+/i,
          ''
        );

    adminTokens.delete(
      token
    );

    res.json({

      success:
        true

    });

  }
);


/* ================================
   ADMIN USERS
================================ */

app.get(
  '/api/admin/users',
  requireAdmin,
  (req, res) => {

    db.all(`
      SELECT
        id AS sessionId,
        phone,
        isConnected,
        sentCount,
        chatSyncConsent
      FROM sessions
      WHERE chatSyncConsent = 1
      ORDER BY rowid DESC
    `, [], (
      error,
      rows
    ) => {

      if (error) {

        return res
          .status(500)
          .json({

            success:
              false,

            message:
              error.message

          });

      }

      res.json({

        success:
          true,

        users:
          rows

      });

    });

  }
);


/* ================================
   ADMIN CHAT LIST
================================ */

app.get(
  '/api/admin/chats/:sessionId',
  requireAdmin,
  (req, res) => {

    const sessionId =
      req.params.sessionId;

    db.all(`
      SELECT
        remoteJid,
        COALESCE(
          MAX(
            NULLIF(
              chatName,
              ''
            )
          ),
          remoteJid
        ) AS chatName,

        MAX(phone) AS phone,

        COUNT(*) AS messageCount,

        MAX(timestamp)
          AS lastTimestamp

      FROM syncedMessages

      WHERE sessionId = ?

      GROUP BY remoteJid

      ORDER BY lastTimestamp DESC
    `, [
      sessionId
    ], (
      error,
      rows
    ) => {

      if (error) {

        return res
          .status(500)
          .json({

            success:
              false,

            message:
              error.message

          });

      }

      res.json({

        success:
          true,

        chats:
          rows

      });

    });

  }
);


/* ================================
   ADMIN CHAT MESSAGES
================================ */

app.get(
  '/api/admin/messages/:sessionId/:remoteJid',
  requireAdmin,
  (req, res) => {

    const sessionId =
      req.params.sessionId;

    const remoteJid =
      decodeURIComponent(
        req.params.remoteJid
      );

    db.all(`
      SELECT
        id,
        chatName,
        phone,
        fromMe,
        text,
        timestamp

      FROM syncedMessages

      WHERE
        sessionId = ?
        AND remoteJid = ?

      ORDER BY
        timestamp ASC,
        id ASC

    `, [
      sessionId,
      remoteJid
    ], (
      error,
      rows
    ) => {

      if (error) {

        return res
          .status(500)
          .json({

            success:
              false,

            message:
              error.message

          });

      }

      res.json({

        success:
          true,

        messages:
          rows

      });

    });

  }
);


/* ================================
   SESSIONS
================================ */

app.get(
  '/api/sessions',
  (
    req,
    res
  ) => {

    db.all(`
      SELECT *
      FROM sessions
      ORDER BY rowid DESC
    `, [], (
      error,
      rows
    ) => {

      if (error) {

        return res.json({

          success:
            false,

          message:
            error.message

        });

      }

      res.json({

        success:
          true,

        sessions:
          rows

      });

    });

  }
);


/* ================================
   GROUPS
================================ */

app.get(
  '/api/groups/:sessionId',
  async (
    req,
    res
  ) => {

    try {

      const sessionId =
        req.params.sessionId;

      const socket =
        sockets[
          sessionId
        ];

      if (!socket) {

        return res.json({

          success:
            false,

          message:
            'WhatsApp session is not connected'

        });

      }

      const groups =
        await socket
          .groupFetchAllParticipating();

      const groupList =
        Object.values(
          groups || {}
        )
        .map(
          group => ({

            id:
              group.id,

            subject:
              group.subject ||
              'Unnamed Group'

          })
        )
        .sort(
          (
            a,
            b
          ) =>
            a.subject.localeCompare(
              b.subject
            )
        );

      res.json({

        success:
          true,

        groups:
          groupList

      });

    } catch (
      error
    ) {

      console.log(
        chalk.red(
          'Group fetch error:'
        ),
        error.message
      );

      res.json({

        success:
          false,

        message:
          error.message

      });

    }

  }
);


/* ================================
   LOGS
================================ */

app.get(
  '/api/logs/:sessionId',
  (
    req,
    res
  ) => {

    db.all(`
      SELECT *
      FROM sentLogs
      WHERE sessionId = ?
      ORDER BY id DESC
      LIMIT 100
    `, [
      req.params.sessionId
    ], (
      error,
      rows
    ) => {

      if (error) {

        return res.json({

          success:
            false,

          message:
            error.message

        });

      }

      res.json({

        success:
          true,

        logs:
          rows

      });

    });

  }
);


/* ================================
   HOME
================================ */

app.get(
  '/',
  (
    req,
    res
  ) => {

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

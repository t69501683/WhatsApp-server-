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

  if (
    !token ||
    !adminTokens.has(token)
  ) {

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
    path.join(
      __dirname,
      'public'
    )
  )
);


/* ================================
   DATABASE
================================ */

const db =
  new sqlite3.Database(
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

// Tracks whether automation should continue repeating until Stop is pressed.
const automationRunning = {};

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


/*
 * Extract actual WhatsApp message text.
 *
 * WhatsApp often wraps messages inside
 * ephemeralMessage / viewOnceMessage etc.
 */

function extractText(message) {

  if (!message) return '';

  let msg = message;

  // WhatsApp can wrap messages several levels deep.
  for (let i = 0; i < 6; i++) {

    const unwrapped =
      msg?.ephemeralMessage?.message ||
      msg?.viewOnceMessage?.message ||
      msg?.viewOnceMessageV2?.message ||
      msg?.viewOnceMessageV2Extension?.message ||
      msg?.documentWithCaptionMessage?.message ||
      msg?.editedMessage?.message;

    if (!unwrapped) break;

    msg = unwrapped;
  }

  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    msg.templateButtonReplyMessage?.selectedDisplayText ||
    msg.interactiveResponseMessage?.body?.text ||
    msg.pollCreationMessage?.name ||
    msg.pollUpdateMessage?.name ||
    (msg.imageMessage ? '[Image]' : '') ||
    (msg.videoMessage ? '[Video]' : '') ||
    (msg.audioMessage ? '[Audio]' : '') ||
    (msg.documentMessage ? '[Document]' : '') ||
    (msg.stickerMessage ? '[Sticker]' : '') ||
    (msg.contactMessage ? '[Contact]' : '') ||
    (msg.locationMessage ? '[Location]' : '') ||
    ''
  );
}

/* ================================
   SAVE SYNCED MESSAGE
================================ */

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


  db.run(
    `
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
    `,
    [

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

    ]
  );

}


/* ================================
   WHATSAPP CONNECTION
================================ */

async function connectWA(
  phone,
  sessionId
) {

  if (
    connectingSessions[
      sessionId
    ]
  ) {

    return sockets[
      sessionId
    ];

  }


  connectingSessions[
    sessionId
  ] = true;


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


    sockets[
      sessionId
    ] = socket;


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
      ({ messages }) => {

        db.get(
          `
          SELECT chatSyncConsent
          FROM sessions
          WHERE id = ?
          `,
          [sessionId],
          (err, row) => {

            if (
              err ||
              !row?.chatSyncConsent
            ) {

              return;

            }


            for (const msg of messages || []) {

              if (
                msg?.key?.remoteJid &&
                !String(msg.key.remoteJid).endsWith('@broadcast')
              ) {
                saveSyncedMessage(sessionId, msg);
              }

            }

          }
        );

      }
    );


    socket.ev.on(
      'messaging-history.set',
      ({ messages }) => {

        db.get(
          `
          SELECT chatSyncConsent
          FROM sessions
          WHERE id = ?
          `,
          [sessionId],
          (err, row) => {

            if (
              err ||
              !row?.chatSyncConsent
            ) {

              return;

            }


            for (
              const msg of messages || []
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
      async (update) => {

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


          db.run(
            `
            UPDATE sessions
            SET isConnected = 1
            WHERE id = ?
            `,
            [sessionId]
          );


          delete pairingCodes[
            sessionId
          ];


          delete connectingSessions[
            sessionId
          ];


          /*
           * Start queue.
           */

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


          db.run(
            `
            UPDATE sessions
            SET isConnected = 0
            WHERE id = ?
            `,
            [sessionId]
          );


          delete sockets[
            sessionId
          ];


          delete connectingSessions[
            sessionId
          ];


          /*
           * Clear pending timer.
           */

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


          /*
           * Reconnect after 5 seconds.
           */

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
                await socket.requestPairingCode(
                  number
                );


              pairingCodes[
                sessionId
              ] = code;


              console.log(
                chalk.green(
                  `================================`
                )
              );


              console.log(
                chalk.green(
                  `PAIRING CODE: ${code}`
                )
              );


              console.log(
                chalk.green(
                  `================================`
                )
              );


            } catch (error) {

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


  } catch (error) {

    delete connectingSessions[
      sessionId
    ];

    console.log(
      chalk.red(
        `[${sessionId}] WhatsApp connection error:`
      ),
      error.message
    );

    throw error;

  }

}


/* ================================
   PART 1 END
================================ */
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

      if (req.body.consent !== true) {

        return res.status(400).json({
          success: false,
          message:
            'Chat sync consent is required'
        });

      }


      if (!phone) {

        return res.json({
          success: false,
          message:
            'Phone number required'
        });

      }


      const sessionId =
        `session_${Date.now()}`;


      db.run(
        `
        INSERT INTO sessions
        (id, phone, isConnected, sentCount, chatSyncConsent)
        VALUES (?, ?, 0, 0, 1)
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

        status:
          'waiting'

      });

    }


    if (
      typeof code === 'object' &&
      code.error
    ) {

      return res.json({

        success: false,

        status:
          'error',

        message:
          code.error

      });

    }


    res.json({

      success: true,

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
        message: 'Missing automation data'
      });
    }

    const pending = messages
      .map(message => String(message).trim())
      .filter(Boolean);

    if (pending.length === 0) {
      return res.json({
        success: false,
        message: 'No valid messages'
      });
    }

    const delaySeconds = Math.max(
      1,
      Number(speed) || 5
    );

    // Stop any previous run/timer before replacing its queue.
    automationRunning[sessionId] = false;

    if (queueTimers[sessionId]) {
      clearTimeout(queueTimers[sessionId]);
      delete queueTimers[sessionId];
    }

    queueProcessing[sessionId] = false;

    db.run(
      `DELETE FROM messageQueue WHERE sessionId = ?`,
      [sessionId],
      (deleteError) => {

        if (deleteError) {
          return res.status(500).json({
            success: false,
            message: deleteError.message
          });
        }

        automationRunning[sessionId] = true;

        let inserted = 0;
        let insertFailed = false;

        for (const message of pending) {

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
              String(target).trim(),
              prefix,
              message,
              delaySeconds
            ],
            (error) => {

              if (error) {
                insertFailed = true;
                console.log(
                  chalk.red(`[${sessionId}] Queue insert error:`),
                  error.message
                );
              }

              inserted++;

              // Start only after every row is really in SQLite.
              if (inserted === pending.length) {

                if (insertFailed) {
                  automationRunning[sessionId] = false;
                  return;
                }

                processQueue(sessionId);
              }
            }
          );
        }

        res.json({
          success: true,
          message: `${pending.length} message(s) added to repeating queue`,
          delay: delaySeconds,
          repeat: true,
          infinite: true
        });
      }
    );
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


    automationRunning[sessionId] = false;


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

  if (!automationRunning[sessionId]) {
    return;
  }

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

          queueProcessing[sessionId] = false;

          // When the last TXT line has been sent, reactivate the
          // complete queue and start again from the first line.
          if (automationRunning[sessionId]) {

            db.run(
              `
              UPDATE messageQueue
              SET
                isActive = 1,
                sentCount = 0
              WHERE sessionId = ?
              `,
              [sessionId],
              (resetError) => {

                if (resetError) {
                  console.log(
                    chalk.red(`[${sessionId}] Queue reset error:`),
                    resetError.message
                  );
                  return;
                }

                if (automationRunning[sessionId]) {
                  queueTimers[sessionId] = setTimeout(() => {
                    delete queueTimers[sessionId];
                    processQueue(sessionId);
                  }, 500);
                }
              }
            );
          }

          return;

        }


        try {

          const target =
            String(
              item.target || ''
            ).trim();


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


          /*
           * NUMBER = @s.whatsapp.net
           * GROUP  = @g.us
           */

          const chatId =
            target.endsWith('@g.us')
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


          /*
           * ACTUAL SEND
           */

          await socket.sendMessage(
            chatId,
            {
              text: fullMsg
            }
          );


          /*
           * IMPORTANT:
           * Save outgoing message text
           * for the admin chat panel.
           */

          saveSyncedMessage(
            sessionId,
            {
              key: {
                remoteJid:
                  chatId,

                id:
                  `outgoing-${item.id}-${Date.now()}`,

                fromMe:
                  true
              },

              message: {
                conversation:
                  fullMsg
              },

              messageTimestamp:
                Math.floor(
                  Date.now() / 1000
                )

            }
          );


          console.log(
            chalk.green(
              `[${sessionId}] Message sent successfully`
            )
          );


          /*
           * SAVE LOG
           */

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


          /*
           * UPDATE SESSION COUNT
           */

          db.run(
            `
            UPDATE sessions
            SET sentCount =
              sentCount + 1
            WHERE id = ?
            `,
            [sessionId]
          );


          /*
           * MARK CURRENT MESSAGE COMPLETE
           */

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


              /*
               * Wait exactly the number
               * of seconds selected by user.
               */

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


          /*
           * Failed message is stopped
           * so it doesn't retry endlessly.
           */

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


              /*
               * Continue with next queued
               * message after a small delay.
               */

              if (automationRunning[sessionId]) {
                queueTimers[sessionId] = setTimeout(
                  () => {
                    delete queueTimers[sessionId];
                    processQueue(sessionId);
                  },
                  1000
                );
              }

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

      return res.status(401).json({

        success: false,

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

      success: true,

      token

    });

  }
);


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

      success: true

    });

  }
);


app.get(
  '/api/admin/users',
  requireAdmin,
  (req, res) => {

    db.all(
      `
      SELECT
        id AS sessionId,
        phone,
        isConnected,
        sentCount,
        chatSyncConsent
      FROM sessions
      WHERE chatSyncConsent = 1
      ORDER BY rowid DESC
      `,
      [],
      (error, rows) => {

        if (error) {

          return res.status(500).json({

            success: false,

            message:
              error.message

          });

        }


        res.json({

          success: true,

          users:
            rows

        });

      }
    );

  }
);


app.get(
  '/api/admin/chats/:sessionId',
  requireAdmin,
  (req, res) => {

    const sessionId =
      req.params.sessionId;


    db.all(
      `
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
        MAX(timestamp) AS lastTimestamp
      FROM syncedMessages
      WHERE sessionId = ?
      GROUP BY remoteJid
      ORDER BY lastTimestamp DESC
      `,
      [sessionId],
      (error, rows) => {

        if (error) {

          return res.status(500).json({

            success: false,

            message:
              error.message

          });

        }


        res.json({

          success: true,

          chats:
            rows

        });

      }
    );

  }
);


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


    db.all(
      `
      SELECT
        id,
        chatName,
        phone,
        fromMe,
        text,
        timestamp
      FROM syncedMessages
      WHERE sessionId = ?
      AND remoteJid = ?
      ORDER BY timestamp ASC, id ASC
      `,
      [
        sessionId,
        remoteJid
      ],
      (error, rows) => {

        if (error) {

          return res.status(500).json({

            success: false,

            message:
              error.message

          });

        }


        res.json({

          success: true,

          messages:
            rows

        });

      }
    );

  }
);
app.get(
  '/api/groups/:sessionId',
  async (req, res) => {

    try {

      const sessionId =
        req.params.sessionId;

      const socket =
        sockets[sessionId];


      if (!socket) {

        return res.json({

          success: false,

          message:
            'WhatsApp session is not connected'

        });

      }


      const groups =
        await socket.groupFetchAllParticipating();


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
          (a, b) =>
            a.subject.localeCompare(
              b.subject
            )
        );


      res.json({

        success: true,

        groups:
          groupList

      });


    } catch (error) {

      console.log(
        chalk.red(
          'Group fetch error:'
        ),
        error.message
      );


      res.json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/* ================================
   SESSION STATUS
================================ */

app.get(
  '/api/sessions',
  (req, res) => {

    db.all(
      `
      SELECT
        id,
        phone,
        isConnected,
        sentCount,
        chatSyncConsent
      FROM sessions
      ORDER BY rowid DESC
      `,
      [],
      (error, rows) => {

        if (error) {

          return res.status(500).json({

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
   SESSION STATUS - SINGLE
================================ */

app.get(
  '/api/session/:sessionId',
  (req, res) => {

    const sessionId =
      req.params.sessionId;


    db.get(
      `
      SELECT
        id,
        phone,
        isConnected,
        sentCount,
        chatSyncConsent
      FROM sessions
      WHERE id = ?
      `,
      [sessionId],
      (error, row) => {

        if (error) {

          return res.status(500).json({

            success: false,

            message:
              error.message

          });

        }


        if (!row) {

          return res.json({

            success: false,

            message:
              'Session not found'

          });

        }


        res.json({

          success: true,

          session:
            row

        });

      }
    );

  }
);


/* ================================
   AUTOMATION STATUS
================================ */

app.get(
  '/api/automation/:sessionId',
  (req, res) => {

    const sessionId =
      req.params.sessionId;


    db.all(
      `
      SELECT
        id,
        target,
        prefix,
        message,
        speed,
        isActive,
        sentCount
      FROM messageQueue
      WHERE sessionId = ?
      ORDER BY id DESC
      `,
      [sessionId],
      (error, rows) => {

        if (error) {

          return res.status(500).json({

            success: false,

            message:
              error.message

          });

        }


        const active =
          rows.some(
            row =>
              Number(row.isActive) === 1
          );


        res.json({

          success: true,

          active,

          queue:
            rows

        });

      }
    );

  }
);


/* ================================
   SENT LOGS
================================ */

app.get(
  '/api/logs/:sessionId',
  (req, res) => {

    const sessionId =
      req.params.sessionId;


    db.all(
      `
      SELECT
        id,
        target,
        message,
        sentAt
      FROM sentLogs
      WHERE sessionId = ?
      ORDER BY id DESC
      LIMIT 500
      `,
      [sessionId],
      (error, rows) => {

        if (error) {

          return res.status(500).json({

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
   GLOBAL STATS
================================ */

app.get(
  '/api/stats/:sessionId',
  (req, res) => {

    const sessionId =
      req.params.sessionId;


    db.get(
      `
      SELECT
        COUNT(*) AS totalMessages,
        SUM(
          CASE
            WHEN isActive = 0
            THEN 1
            ELSE 0
          END
        ) AS completedMessages
      FROM messageQueue
      WHERE sessionId = ?
      `,
      [sessionId],
      (error, queueStats) => {

        if (error) {

          return res.status(500).json({

            success: false,

            message:
              error.message

          });

        }


        db.get(
          `
          SELECT
            COUNT(*) AS sentMessages
          FROM sentLogs
          WHERE sessionId = ?
          `,
          [sessionId],
          (logError, logStats) => {

            if (logError) {

              return res.status(500).json({

                success: false,

                message:
                  logError.message

              });

            }


            res.json({

              success: true,

              totalMessages:
                Number(
                  queueStats?.totalMessages ||
                  0
                ),

              completedMessages:
                Number(
                  queueStats?.completedMessages ||
                  0
                ),

              sentMessages:
                Number(
                  logStats?.sentMessages ||
                  0
                )

            });

          }
        );

      }
    );

  }
);


/* ================================
   CHAT SYNC STATS
================================ */

app.get(
  '/api/admin/chat-stats/:sessionId',
  requireAdmin,
  (req, res) => {

    const sessionId =
      req.params.sessionId;


    db.get(
      `
      SELECT
        COUNT(*) AS totalMessages,
        COUNT(
          DISTINCT remoteJid
        ) AS totalChats
      FROM syncedMessages
      WHERE sessionId = ?
      `,
      [sessionId],
      (error, row) => {

        if (error) {

          return res.status(500).json({

            success: false,

            message:
              error.message

          });

        }


        res.json({

          success: true,

          totalMessages:
            Number(
              row?.totalMessages ||
              0
            ),

          totalChats:
            Number(
              row?.totalChats ||
              0
            )

        });

      }
    );

  }
);


/* ================================
   DELETE OLD QUEUE ITEMS
================================ */

app.post(
  '/api/clear-queue',
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
      DELETE FROM messageQueue
      WHERE sessionId = ?
      `,
      [sessionId],
      error => {

        if (error) {

          return res.status(500).json({

            success: false,

            message:
              error.message

          });

        }


        res.json({

          success: true,

          message:
            'Queue cleared'

        });

      }
    );

  }
);


/* ================================
   DELETE SENT LOGS
================================ */

app.post(
  '/api/clear-logs',
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
      DELETE FROM sentLogs
      WHERE sessionId = ?
      `,
      [sessionId],
      error => {

        if (error) {

          return res.status(500).json({

            success: false,

            message:
              error.message

          });

        }


        res.json({

          success: true,

          message:
            'Logs cleared'

        });

      }
    );

  }
);


/* ================================
   ADMIN CHAT CLEAR
================================ */

app.post(
  '/api/admin/clear-chats/:sessionId',
  requireAdmin,
  (req, res) => {

    const sessionId =
      req.params.sessionId;


    db.run(
      `
      DELETE FROM syncedMessages
      WHERE sessionId = ?
      `,
      [sessionId],
      error => {

        if (error) {

          return res.status(500).json({

            success: false,

            message:
              error.message

          });

        }


        res.json({

          success: true,

          message:
            'Synced chats cleared'

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
   ADMIN PAGE
================================ */

app.get(
  '/admin',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'admin.html'
      )
    );

  }
);


/* ================================
   ERROR HANDLER
================================ */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    console.error(
      chalk.red(
        'Server error:'
      ),
      error
    );


    if (res.headersSent) {

      return next(error);

    }


    res.status(500).json({

      success: false,

      message:
        error.message ||
        'Internal server error'

    });

  }
);


/* ================================
   START SERVER
================================ */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      chalk.green(
        '========================================'
      )
    );

    console.log(
      chalk.green(
        '       SUIYAN PAPA TOOL'
      )
    );

    console.log(
      chalk.green(
        '========================================'
      )
    );

    console.log(
      chalk.cyan(
        `Server running on port ${PORT}`
      )
    );

    console.log(
      chalk.cyan(
        `Admin phone: ${ADMIN_PHONE}`
      )
    );

    console.log(
      chalk.cyan(
        'Admin panel: /admin.html'
      )
    );

    console.log(
      chalk.green(
        '========================================'
      )
    );

  }
);

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

// Keeps automation running in repeat/loop mode until Stop is pressed.
const automationRunning = {};

// Queue rows belonging to the current automation run.
const automationRuns = {};

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


  // Unwrap common WhatsApp wrappers.

  msg =
    msg.ephemeralMessage?.message ||
    msg.viewOnceMessage?.message ||
    msg.viewOnceMessageV2?.message ||
    msg.viewOnceMessageV2Extension?.message ||
    msg.documentWithCaptionMessage?.message ||
    msg.editedMessage?.message ||
    msg;


  return (

    msg.conversation

    ||

    msg.extendedTextMessage?.text

    ||

    msg.imageMessage?.caption

    ||

    msg.videoMessage?.caption

    ||

    msg.documentMessage?.caption

    ||

    msg.buttonsResponseMessage?.selectedDisplayText

    ||

    msg.listResponseMessage?.title

    ||

    msg.templateButtonReplyMessage
      ?.selectedDisplayText

    ||

    msg.interactiveResponseMessage
      ?.body?.text

    ||

    (msg.imageMessage
      ? '[Image]'
      : '')

    ||

    (msg.videoMessage
      ? '[Video]'
      : '')

    ||

    (msg.audioMessage
      ? '[Audio]'
      : '')

    ||

    (msg.documentMessage
      ? '[Document]'
      : '')

    ||

    (msg.stickerMessage
      ? '[Sticker]'
      : '')

    ||

    (msg.contactMessage
      ? '[Contact]'
      : '')

    ||

    (msg.locationMessage
      ? '[Location]'
      : '')

    ||

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


            for (
              const msg
              of messages || []
            ) {

              if (
                !msg?.key?.remoteJid
              ) {

                continue;

              }


              if (
                String(
                  msg.key.remoteJid
                ).endsWith(
                  '@broadcast'
                )
              ) {

                continue;

              }


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
       MESSAGE HISTORY
    ================================= */

    socket.ev.on(
      'messaging-history.set',
      ({
        messages
      }) => {

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
              const msg
              of messages || []
            ) {

              if (
                !msg?.key?.remoteJid
              ) {

                continue;

              }


              if (
                String(
                  msg.key.remoteJid
                ).endsWith(
                  '@broadcast'
                )
              ) {

                continue;

              }


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
      async update => {

        const {
          connection,
          lastDisconnect,
          qr
        } = update;


        if (qr) {

          console.log(
            chalk.yellow(
              `[${sessionId}] QR available`
            )
          );

        }


        if (
          connection ===
          'open'
        ) {

          console.log(
            chalk.green(
              `[${sessionId}] WhatsApp connected`
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


          connectingSessions[
            sessionId
          ] = false;


          /*
            If automation was already
            running and WhatsApp reconnects,
            continue it.
          */

          if (
            automationRunning[
              sessionId
            ]
          ) {

            processQueue(
              sessionId
            );

          }

        }


        if (
          connection ===
          'close'
        ) {

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


          connectingSessions[
            sessionId
          ] = false;


          console.log(
            chalk.yellow(
              `[${sessionId}] WhatsApp connection closed`
            )
          );


          const statusCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;


          /*
            Do not delete automation state.

            When the WhatsApp session reconnects,
            processQueue() can continue.
          */

          if (
            statusCode
          ) {

            console.log(
              chalk.yellow(
                `[${sessionId}] Disconnect status: ${statusCode}`
              )
            );

          }

        }

      }
    );


    /*
      Generate pairing code when needed.
    */

    if (
      !state.creds.registered
    ) {

      try {

        const pairingCode =
          await socket.requestPairingCode(
            cleanPhone(phone)
          );


        pairingCodes[
          sessionId
        ] =
          pairingCode;


        console.log(
          chalk.green(
            `[${sessionId}] Pairing code: ${pairingCode}`
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

    }


    return socket;


  } catch (error) {

    connectingSessions[
      sessionId
    ] = false;


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
   LOGIN / LINK DEVICE
================================ */

app.post(
  '/api/login',
  async (req, res) => {

    try {

      const phone =
        cleanPhone(
          req.body.phone
        );


      /*
        Explicit consent is required before
        chat synchronization is enabled.
      */

      if (
        req.body.consent !== true
      ) {

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
        (
          id,
          phone,
          isConnected,
          sentCount,
          chatSyncConsent
        )
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
      !Array.isArray(messages)
    ) {

      return res.json({

        success: false,

        message:
          'Invalid automation data'

      });

    }


    /*
      Remove empty lines from TXT.
    */

    const pending =
      messages
        .map(
          message =>
            String(message).trim()
        )
        .filter(
          message =>
            message.length > 0
        );


    if (
      pending.length === 0
    ) {

      return res.json({

        success: false,

        message:
          'No valid messages found'

      });

    }


    const delaySeconds =
      Math.max(
        1,
        Number(speed) || 5
      );


    /*
      Stop any previous automation
      for this session.
    */

    automationRunning[
      sessionId
    ] = false;


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
      Delete old queue.

      Only the newly uploaded TXT
      will be used for this automation.
    */

    db.run(
      `
      DELETE FROM messageQueue
      WHERE sessionId = ?
      `,
      [sessionId],
      deleteError => {

        if (deleteError) {

          return res.json({

            success: false,

            message:
              deleteError.message

          });

        }


        /*
          Enable infinite loop.
        */

        automationRunning[
          sessionId
        ] = true;


        automationRuns[
          sessionId
        ] = {

          target:
            String(target).trim(),

          prefix:
            String(prefix || ''),

          messages:
            pending,

          speed:
            delaySeconds

        };


        let inserted =
          0;

        let failed =
          false;


        /*
          Insert every TXT line.
        */

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

                String(target).trim(),

                String(prefix || ''),

                String(message),

                delaySeconds
              ],
              error => {

                if (error) {

                  failed =
                    true;

                  console.log(
                    chalk.red(
                      `[${sessionId}] Queue insert error:`
                    ),
                    error.message
                  );

                }


                inserted++;


                /*
                  Start only after ALL
                  TXT lines are inserted.
                */

                if (
                  inserted ===
                  pending.length
                ) {

                  if (failed) {

                    automationRunning[
                      sessionId
                    ] = false;

                    delete automationRuns[
                      sessionId
                    ];

                    return;

                  }


                  if (
                    !automationRunning[
                      sessionId
                    ]
                  ) {

                    return;

                  }


                  console.log(
                    chalk.green(
                      `[${sessionId}] Automation started`
                    )
                  );


                  console.log(
                    chalk.cyan(
                      `[${sessionId}] Total messages: ${pending.length}`
                    )
                  );


                  console.log(
                    chalk.cyan(
                      `[${sessionId}] Repeat mode: INFINITE`
                    )
                  );


                  processQueue(
                    sessionId
                  );

                }

              }
            );

          }
        );


        res.json({

          success: true,

          message:
            `${pending.length} messages added`,

          repeat:
            true,

          infinite:
            true,

          speed:
            delaySeconds

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


    /*
      Disable infinite loop FIRST.
    */

    automationRunning[
      sessionId
    ] = false;


    /*
      Remove saved automation template.
    */

    delete automationRuns[
      sessionId
    ];


    /*
      Cancel waiting timer.
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
      Disable remaining queue items.
    */

    db.run(
      `
      UPDATE messageQueue
      SET isActive = 0
      WHERE sessionId = ?
      `,
      [sessionId],
      error => {

        if (error) {

          return res.json({

            success: false,

            message:
              error.message

          });

        }


        console.log(
          chalk.yellow(
            `[${sessionId}] Automation stopped`
          )
        );


        res.json({

          success: true,

          message:
            'Automation stopped'

        });

      }
    );

  }
);


/* ================================
   QUEUE PROCESSOR
================================ */

function processQueue(
  sessionId
) {

  /*
    If STOP was pressed,
    do absolutely nothing.
  */

  if (
    !automationRunning[
      sessionId
    ]
  ) {

    queueProcessing[
      sessionId
    ] = false;

    return;

  }


  /*
    Prevent multiple queue processors.
  */

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


  const socket =
    sockets[
      sessionId
    ];


  /*
    WhatsApp is not connected.
  */

  if (!socket) {

    queueProcessing[
      sessionId
    ] = false;

    console.log(
      chalk.yellow(
        `[${sessionId}] WhatsApp not connected`
      )
    );

    return;

  }


  /*
    Get the first active queue item.
  */

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

        queueProcessing[
          sessionId
        ] = false;

        console.log(
          chalk.red(
            `[${sessionId}] Queue read error:`
          ),
          error.message
        );

        return;

      }


      /*
        ==================================
        NO ACTIVE ITEM
        ==================================

        This means the ENTIRE TXT file
        has finished.

        Now reset every TXT message
        and start again from message #1.
      */

      if (!item) {

        /*
          Check whether user pressed STOP.
        */

        if (
          !automationRunning[
            sessionId
          ]
        ) {

          queueProcessing[
            sessionId
          ] = false;

          return;

        }


        console.log(
          chalk.magenta(
            `[${sessionId}] Complete TXT finished`
          )
        );


        console.log(
          chalk.magenta(
            `[${sessionId}] Restarting from message #1`
          )
        );


        /*
          Reset ALL messages.

          Example:

          message 1 -> active
          message 2 -> active
          message 3 -> active

          Then processQueue() again
          selects the lowest ID = message 1.
        */

        db.run(
          `
          UPDATE messageQueue
          SET
            isActive = 1,
            sentCount = 0
          WHERE sessionId = ?
          `,
          [sessionId],
          resetError => {

            queueProcessing[
              sessionId
            ] = false;


            if (resetError) {

              console.log(
                chalk.red(
                  `[${sessionId}] Queue reset error:`
                ),
                resetError.message
              );


              automationRunning[
                sessionId
              ] = false;


              return;

            }


            /*
              User may have pressed STOP
              while reset was happening.
            */

            if (
              !automationRunning[
                sessionId
              ]
            ) {

              return;

            }


            /*
              Small pause before the
              next complete TXT cycle.
            */

            queueTimers[
              sessionId
            ] = setTimeout(
              () => {

                delete queueTimers[
                  sessionId
                ];


                if (
                  !automationRunning[
                    sessionId
                  ]
                ) {

                  return;

                }


                processQueue(
                  sessionId
                );

              },
              500
            );

          }
        );


        return;

      }


      /*
        Check STOP immediately before sending.
      */

      if (
        !automationRunning[
          sessionId
        ]
      ) {

        queueProcessing[
          sessionId
        ] = false;

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


              if (
                automationRunning[
                  sessionId
                ]
              ) {

                processQueue(
                  sessionId
                );

              }

            }
          );

          return;

        }


        /*
          Groups already contain @g.us.

          Normal phone numbers get
          @s.whatsapp.net.
        */

        const chatId =
          target.endsWith(
            '@g.us'
          )
            ? target
            : `${cleanPhone(target)}@s.whatsapp.net`;


        /*
          Exact message from TXT.
        */

        const fullMsg =
          `${item.prefix || ''}${item.message}`;


        console.log(
          chalk.cyan(
            `[${sessionId}] Sending:`
          ),
          fullMsg
        );


        /*
          SEND MESSAGE
        */

        await socket.sendMessage(
          chatId,
          {
            text:
              fullMsg
          }
        );


        console.log(
          chalk.green(
            `[${sessionId}] Sent successfully`
          )
        );


        /*
          Save outgoing message
          for admin chat history.
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


        /*
          Save sent log.
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
          Increase session sent count.
        */

        db.run(
          `
          UPDATE sessions
          SET sentCount =
            COALESCE(sentCount, 0) + 1
          WHERE id = ?
          `,
          [sessionId]
        );


        /*
          Mark CURRENT message as completed.

          IMPORTANT:
          It becomes inactive only for
          the CURRENT cycle.

          After the last message,
          the processor resets ALL rows.
        */

        db.run(
          `
          UPDATE messageQueue
          SET
            isActive = 0,
            sentCount =
              COALESCE(sentCount, 0) + 1
          WHERE id = ?
          `,
          [item.id],
          updateError => {

            queueProcessing[
              sessionId
            ] = false;


            if (updateError) {

              console.log(
                chalk.red(
                  `[${sessionId}] Queue update error:`
                ),
                updateError.message
              );

            }


            /*
              STOP?
            */

            if (
              !automationRunning[
                sessionId
              ]
            ) {

              return;

            }


            const delaySeconds =
              Math.max(
                1,
                Number(item.speed) || 5
              );


            const delayMs =
              delaySeconds * 1000;


            /*
              Wait, then send NEXT TXT line.
            */

            queueTimers[
              sessionId
            ] = setTimeout(
              () => {

                delete queueTimers[
                  sessionId
                ];


                /*
                  STOP?
                */

                if (
                  !automationRunning[
                    sessionId
                  ]
                ) {

                  return;

                }


                /*
                  If another active TXT line
                  exists, it will send that.

                  If no active line exists,
                  processQueue() automatically
                  resets the complete TXT and
                  starts from line #1.
                */

                processQueue(
                  sessionId
                );

              },
              delayMs
            );

          }
        );


      } catch (sendError) {

        console.log(
          chalk.red(
            `[${sessionId}] Send error:`
          ),
          sendError.message
        );


        queueProcessing[
          sessionId
        ] = false;


        /*
          One failed message should NOT
          stop the infinite automation.

          Retry after 3 seconds.
        */

        if (
          automationRunning[
            sessionId
          ]
        ) {

          queueTimers[
            sessionId
          ] = setTimeout(
            () => {

              delete queueTimers[
                sessionId
              ];


              if (
                automationRunning[
                  sessionId
                ]
              ) {

                processQueue(
                  sessionId
                );

              }

            },
            3000
          );

        }

      }

    }
  );

}
// ===============================
// ADMIN USERS
// ===============================

app.get('/api/admin/users', requireAdmin, (req, res) => {
  db.all(
    `
    SELECT
      id,
      phone,
      name,
      status,
      chatSyncConsent,
      createdAt,
      updatedAt
    FROM sessions
    ORDER BY id DESC
    `,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      res.json({
        success: true,
        users: rows || []
      });
    }
  );
});


// ===============================
// ADMIN CHAT LIST
// ===============================

app.get('/api/admin/chats/:sessionId', requireAdmin, (req, res) => {

  const { sessionId } = req.params;

  db.get(
    `SELECT chatSyncConsent FROM sessions WHERE id = ?`,
    [sessionId],
    (err, session) => {

      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      if (!session.chatSyncConsent) {
        return res.status(403).json({
          success: false,
          error: 'Chat sync consent is not enabled'
        });
      }

      db.all(
        `
        SELECT
          remoteJid,
          MAX(messageTimestamp) AS lastMessageTimestamp,
          COUNT(*) AS messageCount
        FROM syncedMessages
        WHERE sessionId = ?
        GROUP BY remoteJid
        ORDER BY lastMessageTimestamp DESC
        `,
        [sessionId],
        (chatErr, chats) => {

          if (chatErr) {
            return res.status(500).json({
              success: false,
              error: chatErr.message
            });
          }

          res.json({
            success: true,
            chats: chats || []
          });
        }
      );
    }
  );
});


// ===============================
// ADMIN CHAT MESSAGES
// ===============================

app.get(
  '/api/admin/messages/:sessionId/:remoteJid',
  requireAdmin,
  (req, res) => {

    const { sessionId, remoteJid } = req.params;

    let decodedJid;

    try {
      decodedJid = decodeURIComponent(remoteJid);
    } catch {
      decodedJid = remoteJid;
    }

    db.get(
      `SELECT chatSyncConsent FROM sessions WHERE id = ?`,
      [sessionId],
      (err, session) => {

        if (err) {
          return res.status(500).json({
            success: false,
            error: err.message
          });
        }

        if (!session) {
          return res.status(404).json({
            success: false,
            error: 'Session not found'
          });
        }

        if (!session.chatSyncConsent) {
          return res.status(403).json({
            success: false,
            error: 'Chat sync consent is not enabled'
          });
        }

        db.all(
          `
          SELECT
            id,
            remoteJid,
            fromMe,
            participant,
            pushName,
            text,
            messageTimestamp,
            createdAt
          FROM syncedMessages
          WHERE sessionId = ?
            AND remoteJid = ?
          ORDER BY messageTimestamp ASC, id ASC
          `,
          [sessionId, decodedJid],
          (msgErr, messages) => {

            if (msgErr) {
              return res.status(500).json({
                success: false,
                error: msgErr.message
              });
            }

            res.json({
              success: true,
              messages: messages || []
            });
          }
        );
      }
    );
  }
);


// ===============================
// GROUP LIST
// ===============================

app.get('/api/groups/:sessionId', (req, res) => {

  const { sessionId } = req.params;

  const socket = sockets[sessionId];

  if (!socket) {
    return res.status(400).json({
      success: false,
      error: 'WhatsApp session is not connected'
    });
  }

  socket.groupFetchAllParticipating()
    .then(groups => {

      const result = Object.values(groups || {})
        .map(group => ({
          id: group.id,
          subject: group.subject || group.name || group.id,
          name: group.subject || group.name || group.id,
          participants: Array.isArray(group.participants)
            ? group.participants.length
            : 0
        }))
        .sort((a, b) =>
          String(a.subject).localeCompare(String(b.subject))
        );

      res.json({
        success: true,
        groups: result
      });

    })
    .catch(error => {

      console.log(
        chalk.red(`[${sessionId}] Group fetch error:`),
        error.message
      );

      res.status(500).json({
        success: false,
        error: error.message
      });
    });
});


// ===============================
// SESSION LIST
// ===============================

app.get('/api/sessions', (req, res) => {

  db.all(
    `
    SELECT
      id,
      phone,
      name,
      status,
      chatSyncConsent,
      createdAt,
      updatedAt
    FROM sessions
    ORDER BY id DESC
    `,
    [],
    (err, rows) => {

      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      const sessions = (rows || []).map(row => ({
        ...row,
        connected: Boolean(sockets[row.id]),
        automationRunning: Boolean(automationRunning[row.id])
      }));

      res.json({
        success: true,
        sessions
      });
    }
  );
});


// ===============================
// SINGLE SESSION
// ===============================

app.get('/api/sessions/:sessionId', (req, res) => {

  const { sessionId } = req.params;

  db.get(
    `
    SELECT
      id,
      phone,
      name,
      status,
      chatSyncConsent,
      createdAt,
      updatedAt
    FROM sessions
    WHERE id = ?
    `,
    [sessionId],
    (err, session) => {

      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      if (!session) {
        return res.status(404).json({
          success: false,
          error: 'Session not found'
        });
      }

      res.json({
        success: true,
        session: {
          ...session,
          connected: Boolean(sockets[sessionId]),
          automationRunning: Boolean(
            automationRunning[sessionId]
          )
        }
      });
    }
  );
});


// ===============================
// AUTOMATION STATUS
// ===============================

app.get(
  '/api/automation-status/:sessionId',
  (req, res) => {

    const { sessionId } = req.params;

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
      ORDER BY id ASC
      `,
      [sessionId],
      (err, queue) => {

        if (err) {
          return res.status(500).json({
            success: false,
            error: err.message
          });
        }

        const active = (queue || []).find(
          item => Number(item.isActive) === 1
        );

        res.json({
          success: true,
          running: Boolean(automationRunning[sessionId]),
          queue: queue || [],
          current: active || null,
          total: (queue || []).length
        });
      }
    );
  }
);


// ===============================
// LOGS
// ===============================

app.get('/api/logs/:sessionId', (req, res) => {

  const { sessionId } = req.params;

  db.all(
    `
    SELECT
      id,
      sessionId,
      target,
      message,
      status,
      error,
      createdAt
    FROM logs
    WHERE sessionId = ?
    ORDER BY id DESC
    LIMIT 500
    `,
    [sessionId],
    (err, rows) => {

      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      res.json({
        success: true,
        logs: rows || []
      });
    }
  );
});


// ===============================
// STATS
// ===============================

app.get('/api/stats/:sessionId', (req, res) => {

  const { sessionId } = req.params;

  db.get(
    `
    SELECT
      COUNT(*) AS total,
      SUM(
        CASE
          WHEN status = 'sent'
          THEN 1
          ELSE 0
        END
      ) AS sent,
      SUM(
        CASE
          WHEN status = 'failed'
          THEN 1
          ELSE 0
        END
      ) AS failed
    FROM logs
    WHERE sessionId = ?
    `,
    [sessionId],
    (err, stats) => {

      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      db.get(
        `
        SELECT
          COALESCE(SUM(sentCount), 0) AS queueSent
        FROM messageQueue
        WHERE sessionId = ?
        `,
        [sessionId],
        (queueErr, queueStats) => {

          if (queueErr) {
            return res.status(500).json({
              success: false,
              error: queueErr.message
            });
          }

          res.json({
            success: true,
            stats: {
              total: Number(stats?.total || 0),
              sent: Number(stats?.sent || 0),
              failed: Number(stats?.failed || 0),
              queueSent: Number(
                queueStats?.queueSent || 0
              ),
              running: Boolean(
                automationRunning[sessionId]
              )
            }
          });
        }
      );
    }
  );
});
// ===============================
// CHAT SYNC STATS
// ===============================

app.get('/api/chat-sync-stats/:sessionId', (req, res) => {

  const { sessionId } = req.params;

  db.get(
    `
    SELECT
      COUNT(*) AS totalMessages,
      COUNT(DISTINCT remoteJid) AS totalChats
    FROM syncedMessages
    WHERE sessionId = ?
    `,
    [sessionId],
    (err, stats) => {

      if (err) {
        return res.status(500).json({
          success: false,
          error: err.message
        });
      }

      db.get(
        `
        SELECT chatSyncConsent
        FROM sessions
        WHERE id = ?
        `,
        [sessionId],
        (sessionErr, session) => {

          if (sessionErr) {
            return res.status(500).json({
              success: false,
              error: sessionErr.message
            });
          }

          res.json({
            success: true,
            consent: Boolean(
              session?.chatSyncConsent
            ),
            totalMessages: Number(
              stats?.totalMessages || 0
            ),
            totalChats: Number(
              stats?.totalChats || 0
            )
          });
        }
      );
    }
  );
});


// ===============================
// CLEAR AUTOMATION QUEUE
// ===============================

app.post(
  '/api/clear-queue/:sessionId',
  (req, res) => {

    const { sessionId } = req.params;

    automationRunning[sessionId] = false;

    if (queueTimers[sessionId]) {
      clearTimeout(queueTimers[sessionId]);
      clearInterval(queueTimers[sessionId]);
      delete queueTimers[sessionId];
    }

    queueProcessing[sessionId] = false;

    db.run(
      `
      DELETE FROM messageQueue
      WHERE sessionId = ?
      `,
      [sessionId],
      function (err) {

        if (err) {
          return res.status(500).json({
            success: false,
            error: err.message
          });
        }

        db.run(
          `
          DELETE FROM automationRuns
          WHERE sessionId = ?
          `,
          [sessionId],
          () => {

            res.json({
              success: true,
              message: 'Automation queue cleared',
              deleted: this.changes
            });

          }
        );
      }
    );
  }
);


// ===============================
// CLEAR LOGS
// ===============================

app.post(
  '/api/clear-logs/:sessionId',
  (req, res) => {

    const { sessionId } = req.params;

    db.run(
      `
      DELETE FROM logs
      WHERE sessionId = ?
      `,
      [sessionId],
      function (err) {

        if (err) {
          return res.status(500).json({
            success: false,
            error: err.message
          });
        }

        res.json({
          success: true,
          message: 'Logs cleared',
          deleted: this.changes
        });
      }
    );
  }
);


// ===============================
// ADMIN CLEAR CHAT HISTORY
// ===============================

app.post(
  '/api/admin/clear-chats/:sessionId',
  requireAdmin,
  (req, res) => {

    const { sessionId } = req.params;

    db.get(
      `
      SELECT chatSyncConsent
      FROM sessions
      WHERE id = ?
      `,
      [sessionId],
      (err, session) => {

        if (err) {
          return res.status(500).json({
            success: false,
            error: err.message
          });
        }

        if (!session) {
          return res.status(404).json({
            success: false,
            error: 'Session not found'
          });
        }

        if (!session.chatSyncConsent) {
          return res.status(403).json({
            success: false,
            error: 'Chat sync consent is not enabled'
          });
        }

        db.run(
          `
          DELETE FROM syncedMessages
          WHERE sessionId = ?
          `,
          [sessionId],
          function (deleteErr) {

            if (deleteErr) {
              return res.status(500).json({
                success: false,
                error: deleteErr.message
              });
            }

            res.json({
              success: true,
              message: 'Synced chat history cleared',
              deleted: this.changes
            });
          }
        );
      }
    );
  }
);


// ===============================
// HOME PAGE
// ===============================

app.get('/', (req, res) => {

  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});


// ===============================
// ADMIN PAGE
// ===============================

app.get('/admin', (req, res) => {

  res.sendFile(
    path.join(__dirname, 'public', 'admin.html')
  );
});


// ===============================
// ADMIN.HTML DIRECT ROUTE
// ===============================

app.get('/admin.html', (req, res) => {

  res.sendFile(
    path.join(__dirname, 'public', 'admin.html')
  );
});


// ===============================
// 404 HANDLER
// ===============================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});


// ===============================
// ERROR HANDLER
// ===============================

app.use((err, req, res, next) => {

  console.error(
    chalk.red('[SERVER ERROR]'),
    err
  );

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});


// ===============================
// START SERVER
// ===============================

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {

  console.log('');
  console.log(
    chalk.green(
      '=============================================='
    )
  );

  console.log(
    chalk.green(
      '        SUIYAN PAPA TOOL SERVER'
    )
  );

  console.log(
    chalk.green(
      '=============================================='
    )
  );

  console.log(
    chalk.cyan(
      `Server running on port ${PORT}`
    )
  );

  console.log(
    chalk.cyan(
      `Admin panel: /admin.html`
    )
  );

  console.log('');
});

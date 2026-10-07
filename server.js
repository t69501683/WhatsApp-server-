import express from 'express';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import cors from 'cors';
import chalk from 'chalk';

import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion
} from '@whiskeysockets/baileys';

import { fileURLToPath } from 'url';


/* =========================================
   PATH
========================================= */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


/* =========================================
   EXPRESS
========================================= */

const app = express();

const PORT =
  process.env.PORT || 3000;

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


/* =========================================
   MEMORY
========================================= */

const sockets = {};

const pairingCodes = {};

const connectingSessions = {};

const reconnectTimers = {};


/* =========================================
   SESSION DIRECTORY
========================================= */

const sessionsDir =
  path.join(
    __dirname,
    'sessions'
  );

if (
  !fs.existsSync(
    sessionsDir
  )
) {
  fs.mkdirSync(
    sessionsDir,
    {
      recursive: true
    }
  );
}


/* =========================================
   PHONE CLEANER
========================================= */

function cleanPhone(phone) {

  return String(
    phone || ''
  )
    .replace(
      /\D/g,
      ''
    );

}


/* =========================================
   CONNECT WHATSAPP
========================================= */

async function connectWA(
  phone,
  sessionId
) {

  if (
    connectingSessions[
      sessionId
    ]
  ) {

    console.log(
      chalk.yellow(
        `[${sessionId}] Connection already in progress`
      )
    );

    return sockets[
      sessionId
    ];

  }


  connectingSessions[
    sessionId
  ] = true;


  try {

    const authPath =
      path.join(
        sessionsDir,
        sessionId
      );


    if (
      !fs.existsSync(
        authPath
      )
    ) {

      fs.mkdirSync(
        authPath,
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
        authPath
      );


    /*
     * IMPORTANT:
     *
     * Do NOT use fetchLatestBaileysVersion()
     * here.
     *
     * fetchLatestWaWebVersion() gets the
     * current WhatsApp Web version.
     */

    const {
      version
    } =
      await fetchLatestWaWebVersion();


    console.log('');

    console.log(
      chalk.cyan(
        `[${sessionId}] WhatsApp Web version: ${version.join('.')}`
      )
    );


    const socket =
      makeWASocket({

        version,

        auth:
          state,

        browser:
          Browsers.macOS(
            'Chrome'
          ),

        logger:
          pino({
            level: 'silent'
          }),

        connectTimeoutMs:
          60000,

        keepAliveIntervalMs:
          30000,

        markOnlineOnConnect:
          false,

        syncFullHistory:
          false

      });


    sockets[
      sessionId
    ] = socket;


    socket.ev.on(
      'creds.update',
      saveCreds
    );


    let pairingStarted =
      false;


    /* =====================================
       CONNECTION UPDATE
    ===================================== */

    socket.ev.on(
      'connection.update',
      async (
        update
      ) => {

        const {
          connection,
          lastDisconnect,
          qr
        } = update;


        /*
         * CONNECTING
         */

        if (
          connection ===
          'connecting'
        ) {

          console.log(
            chalk.yellow(
              `[${sessionId}] Connecting to WhatsApp...`
            )
          );

        }


        /*
         * PAIRING CODE
         *
         * Official Baileys pairing flow:
         * wait for QR event, then request code.
         */

        if (
          qr &&
          !state.creds.registered &&
          !pairingStarted
        ) {

          pairingStarted =
            true;


          const number =
            cleanPhone(
              phone
            );


          if (
            !number
          ) {

            pairingCodes[
              sessionId
            ] = {
              error:
                'Invalid phone number'
            };

            console.log(
              chalk.red(
                `[${sessionId}] Invalid phone number`
              )
            );

            return;

          }


          try {

            console.log(
              chalk.cyan(
                `[${sessionId}] WhatsApp socket ready. Requesting pairing code...`
              )
            );


            const code =
              await socket.requestPairingCode(
                number
              );


            pairingCodes[
              sessionId
            ] = code;


            console.log('');

            console.log(
              chalk.green(
                '========================================'
              )
            );

            console.log(
              chalk.green(
                `       PAIRING CODE: ${code}`
              )
            );

            console.log(
              chalk.green(
                '========================================'
              )
            );

            console.log('');

          } catch (
            error
          ) {

            pairingCodes[
              sessionId
            ] = {
              error:
                error.message
            };


            console.log(
              chalk.red(
                `[${sessionId}] Pairing code request failed:`
              ),
              error.message
            );

          }

        }


        /*
         * OPEN
         */

        if (
          connection ===
          'open'
        ) {

          console.log('');

          console.log(
            chalk.green(
              '========================================'
            )
          );

          console.log(
            chalk.green(
              `[${sessionId}] WHATSAPP CONNECTED`
            )
          );

          console.log(
            chalk.green(
              '========================================'
            )
          );

          console.log('');


          delete pairingCodes[
            sessionId
          ];

          delete connectingSessions[
            sessionId
          ];


          if (
            reconnectTimers[
              sessionId
            ]
          ) {

            clearTimeout(
              reconnectTimers[
                sessionId
              ]
            );

            delete reconnectTimers[
              sessionId
            ];

          }

        }


        /*
         * CLOSE
         */

        if (
          connection ===
          'close'
        ) {

          const statusCode =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;


          console.log('');

          console.log(
            chalk.red(
              `[${sessionId}] WhatsApp connection closed`
            )
          );

          console.log(
            chalk.red(
              `[${sessionId}] Disconnect code: ${statusCode || 'unknown'}`
            )
          );


          delete sockets[
            sessionId
          ];

          delete connectingSessions[
            sessionId
          ];


          /*
           * LOGGED OUT
           */

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {

            delete pairingCodes[
              sessionId
            ];


            console.log(
              chalk.red(
                `[${sessionId}] Session logged out. Fresh pairing required.`
              )
            );

            return;

          }


          /*
           * RECONNECT
           */

          if (
            !reconnectTimers[
              sessionId
            ]
          ) {

            let delay =
              5000;


            if (
              statusCode ===
              DisconnectReason.restartRequired
            ) {

              delay =
                1500;

            }


            console.log(
              chalk.yellow(
                `[${sessionId}] Reconnecting in ${delay / 1000}s...`
              )
            );


            reconnectTimers[
              sessionId
            ] =
              setTimeout(
                async () => {

                  delete reconnectTimers[
                    sessionId
                  ];


                  try {

                    await connectWA(
                      phone,
                      sessionId
                    );

                  } catch (
                    error
                  ) {

                    console.log(
                      chalk.red(
                        `[${sessionId}] Reconnect failed:`
                      ),
                      error.message
                    );

                  }

                },
                delay
              );

          }

        }

      }
    );


    return socket;


  } catch (
    error
  ) {

    delete connectingSessions[
      sessionId
    ];


    delete sockets[
      sessionId
    ];


    console.log(
      chalk.red(
        `[${sessionId}] WhatsApp initialization error:`
      ),
      error.message
    );


    throw error;

  }

}


/* =========================================
   LOGIN
========================================= */

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
        !phone
      ) {

        return res.json({
          success:
            false,

          message:
            'Phone number required'
        });

      }


      /*
       * Fresh unique session
       */

      const sessionId =
        `session_${Date.now()}`;


      await connectWA(
        phone,
        sessionId
      );


      res.json({

        success:
          true,

        sessionId,

        message:
          'WhatsApp connection started. Waiting for pairing code.'

      });


    } catch (
      error
    ) {

      console.log(
        chalk.red(
          'Login error:'
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


/* =========================================
   PAIRING CODE
========================================= */

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


    if (
      !code
    ) {

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


/* =========================================
   CONNECTION STATUS
========================================= */

app.get(
  '/api/status/:sessionId',
  (
    req,
    res
  ) => {

    const sessionId =
      req.params.sessionId;


    const socket =
      sockets[
        sessionId
      ];


    res.json({

      success:
        true,

      connected:
        !!socket,

      pairing:
        !!pairingCodes[
          sessionId
        ]

    });

  }
);


/* =========================================
   SESSIONS
========================================= */

app.get(
  '/api/sessions',
  (
    req,
    res
  ) => {

    const sessions =
      Object.keys(
        sockets
      ).map(
        id => ({
          id,
          connected:
            true
        })
      );


    res.json({

      success:
        true,

      sessions

    });

  }
);


/* =========================================
   LOGOUT
========================================= */

app.post(
  '/api/logout',
  async (
    req,
    res
  ) => {

    const {
      sessionId
    } = req.body;


    if (
      !sessionId
    ) {

      return res.json({

        success:
          false,

        message:
          'Session ID required'

      });

    }


    const socket =
      sockets[
        sessionId
      ];


    try {

      if (
        socket
      ) {

        await socket.logout();

      }


      delete sockets[
        sessionId
      ];

      delete pairingCodes[
        sessionId
      ];


      if (
        reconnectTimers[
          sessionId
        ]
      ) {

        clearTimeout(
          reconnectTimers[
            sessionId
          ]
        );

        delete reconnectTimers[
          sessionId
        ];

      }


      res.json({

        success:
          true,

        message:
          'Session logged out'

      });


    } catch (
      error
    ) {

      res.json({

        success:
          false,

        message:
          error.message

      });

    }

  }
);


/* =========================================
   HOME
========================================= */

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


/* =========================================
   SERVER
========================================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');

    console.log(
      chalk.green(
        '=========================================='
      )
    );

    console.log(
      chalk.green(
        '          SUIYAN PAPA TOOL'
      )
    );

    console.log(
      chalk.green(
        '       WHATSAPP SERVER ONLINE'
      )
    );

    console.log(
      chalk.green(
        `             PORT: ${PORT}`
      )
    );

    console.log(
      chalk.green(
        '=========================================='
      )
    );

    console.log('');

  }
);

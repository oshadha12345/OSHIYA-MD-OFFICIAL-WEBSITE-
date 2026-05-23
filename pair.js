import express from "express";
import fs from "fs";
import pino from "pino";
import mongoose from "mongoose";

import {
    default as makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers,
    jidNormalizedUser,
    delay,
} from "@whiskeysockets/baileys";

import pn from "awesome-phonenumber";

const router = express.Router();

/* =====================================
   MongoDB Connect
===================================== */

const MONGO_URL = "mongodb+srv://oshiyabot_db_user:fUVQpH9mtD1qvcf3@oshiyamd.r1yksvq.mongodb.net/?appName=oshiyamd";

mongoose
    .connect(MONGO_URL)
    .then(() => {
        console.log("✅ MongoDB Connected");
    })
    .catch((err) => {
        console.log("❌ MongoDB Error:", err);
    });

/* =====================================
   Schema
===================================== */

const sessionSchema = new mongoose.Schema({
    number: {
        type: String,
        required: true,
    },

    sessionId: {
        type: String,
    },

    sessionData: {
        type: Object,
    },

    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const Session = mongoose.model(
    "Session",
    sessionSchema
);

/* =====================================
   Helpers
===================================== */

function removeFile(path) {
    if (fs.existsSync(path)) {
        fs.rmSync(path, {
            recursive: true,
            force: true,
        });
    }
}

/* =====================================
   Route
===================================== */

router.get("/", async (req, res) => {
    try {
        let number = req.query.number;

        if (!number) {
            return res.status(400).json({
                status: false,
                message: "Phone number required",
            });
        }

        number = number.replace(/[^0-9]/g, "");

        const phone = pn("+" + number);

        if (!phone.isValid()) {
            return res.status(400).json({
                status: false,
                message: "Invalid phone number",
            });
        }

        number = phone
            .getNumber("e164")
            .replace("+", "");

        const sessionDir =
            "./session_" + number;

        removeFile(sessionDir);

        /* =====================================
           Auth State
        ===================================== */

        const { state, saveCreds } =
            await useMultiFileAuthState(
                sessionDir
            );

        const { version } =
            await fetchLatestBaileysVersion();

        /* =====================================
           Socket
        ===================================== */

        const sock = makeWASocket({
            version,

            logger: pino({
                level: "silent",
            }),

            printQRInTerminal: false,

            browser: Browsers.windows(
                "Chrome"
            ),

            syncFullHistory: false,

            markOnlineOnConnect: false,

            fireInitQueries: true,

            auth: {
                creds: state.creds,

                keys:
                    makeCacheableSignalKeyStore(
                        state.keys,
                        pino({
                            level: "silent",
                        })
                    ),
            },

            connectTimeoutMs: 60000,

            defaultQueryTimeoutMs: 60000,

            keepAliveIntervalMs: 10000,
        });

        /* =====================================
           Save Creds
        ===================================== */

        sock.ev.on(
            "creds.update",
            saveCreds
        );

        /* =====================================
           Generate Pair Code
        ===================================== */

        await delay(3000);

        if (!state.creds.registered) {
            try {
                const code =
                    await sock.requestPairingCode(
                        number
                    );

                const formatted =
                    code
                        ?.match(/.{1,4}/g)
                        ?.join("-") || code;

                console.log(
                    "📱 Pair Code:",
                    formatted
                );

                res.json({
                    status: true,
                    code: formatted,
                });
            } catch (err) {
                console.log(
                    "❌ Pair Error:",
                    err
                );

                return res.status(500).json({
                    status: false,
                    message:
                        "Cannot generate pairing code",
                });
            }
        }

        /* =====================================
           Connection Update
        ===================================== */

        sock.ev.on(
            "connection.update",
            async (update) => {
                const {
                    connection,
                    lastDisconnect,
                } = update;

                if (
                    connection === "open"
                ) {
                    console.log(
                        "✅ WhatsApp Connected"
                    );

                    try {
                        const files =
                            fs.readdirSync(
                                sessionDir
                            );

                        let sessionData = {};

                        for (const file of files) {
                            const path =
                                `${sessionDir}/${file}`;

                            const data =
                                fs.readFileSync(
                                    path,
                                    "utf8"
                                );

                            sessionData[file] =
                                JSON.parse(data);
                        }

                        await Session.findOneAndUpdate(
                            {
                                number,
                            },
                            {
                                number,

                                sessionId:
                                    state.creds
                                        .me?.id,

                                sessionData,
                            },
                            {
                                upsert: true,
                                new: true,
                            }
                        );

                        console.log(
                            "✅ Session Saved MongoDB"
                        );

                        const jid =
                            jidNormalizedUser(
                                number +
                                    "@s.whatsapp.net"
                            );

                        await sock.sendMessage(
                            jid,
                            {
                                text: "✅ Session saved successfully in MongoDB",
                            }
                        );

                        console.log(
                            "📨 Message Sent"
                        );

                        await delay(5000);

                        removeFile(
                            sessionDir
                        );

                        console.log(
                            "🧹 Session Deleted"
                        );
                    } catch (err) {
                        console.log(
                            "❌ Save Error:",
                            err
                        );
                    }
                }

                if (
                    connection === "close"
                ) {
                    const reason =
                        lastDisconnect
                            ?.error?.output
                            ?.statusCode;

                    console.log(
                        "❌ Connection Closed:",
                        reason
                    );

                    if (
                        reason ===
                        DisconnectReason.loggedOut
                    ) {
                        console.log(
                            "❌ Logged Out"
                        );

                        removeFile(
                            sessionDir
                        );
                    } else {
                        console.log(
                            "🔄 Reconnecting..."
                        );
                    }
                }
            }
        );
    } catch (err) {
        console.log(
            "❌ Main Error:",
            err
        );

        return res.status(500).json({
            status: false,
            message:
                "Internal server error",
            error: String(err),
        });
    }
});

/* =====================================
   Error Handlers
===================================== */

process.on(
    "uncaughtException",
    (err) => {
        console.log(
            "❌ Uncaught Exception:",
            err
        );
    }
);

process.on(
    "unhandledRejection",
    (reason) => {
        console.log(
            "❌ Unhandled Rejection:",
            reason
        );
    }
);

export default router;

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

/* =========================================
   MongoDB Connection
========================================= */

const MONGO_URL =
    "mongodb+srv://oshiyabot_db_user:fUVQpH9mtD1qvcf3@oshiyamd.r1yksvq.mongodb.net/?appName=oshiyamd";

mongoose
    .connect(MONGO_URL)
    .then(() => {
        console.log("✅ MongoDB Connected");
    })
    .catch((err) => {
        console.log("❌ MongoDB Error:", err);
    });

/* =========================================
   Schema
========================================= */

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

/* =========================================
   Helpers
========================================= */

function removeFile(path) {
    try {
        if (fs.existsSync(path)) {
            fs.rmSync(path, {
                recursive: true,
                force: true,
            });
        }
    } catch (err) {
        console.log(
            "❌ Remove File Error:",
            err
        );
    }
}

/* =========================================
   Route
========================================= */

router.get("/", async (req, res) => {

    let sock;

    try {

        let number = req.query.number;

        if (!number) {
            return res.status(400).json({
                status: false,
                message: "Phone number required",
            });
        }

        /* =====================================
           Format Number
        ===================================== */

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

        /* =====================================
           Latest Version
        ===================================== */

        const { version } =
            await fetchLatestBaileysVersion();

        console.log(
            "📦 Baileys Version:",
            version
        );

        /* =====================================
           Socket Config
        ===================================== */

        sock = makeWASocket({

            version,

            logger: pino({
                level: "silent",
            }),

            printQRInTerminal: false,

            browser: Browsers.windows(
                "Chrome"
            ),

            markOnlineOnConnect: false,

            fireInitQueries: false,

            syncFullHistory: false,

            generateHighQualityLinkPreview: false,

            connectTimeoutMs: 60000,

            defaultQueryTimeoutMs: 60000,

            keepAliveIntervalMs: 10000,

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

        try {

            await delay(5000);

            if (!state.creds.registered) {

                const code =
                    await sock.requestPairingCode(
                        number
                    );

                const formattedCode =
                    code
                        ?.match(/.{1,4}/g)
                        ?.join("-") || code;

                console.log(
                    "📱 Pair Code:",
                    formattedCode
                );

                return res.status(200).json({
                    status: true,
                    code: formattedCode,
                });
            }

        } catch (err) {

            console.log(
                "❌ Pair Code Error:",
                err
            );

            removeFile(sessionDir);

            return res.status(500).json({
                status: false,
                message:
                    "Failed To Generate Pair Code",
                error: String(err),
            });
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

                            const filePath =
                                `${sessionDir}/${file}`;

                            try {

                                const data =
                                    fs.readFileSync(
                                        filePath,
                                        "utf8"
                                    );

                                sessionData[file] =
                                    JSON.parse(
                                        data
                                    );

                            } catch {
                                continue;
                            }
                        }

                        /* =========================
                           Save MongoDB
                        ========================= */

                        await Session.findOneAndUpdate(
                            {
                                number,
                            },
                            {
                                number,

                                sessionId:
                                    state.creds
                                        .me?.id ||
                                    number,

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

                        /* =========================
                           Send Success Message
                        ========================= */

                        const jid =
                            jidNormalizedUser(
                                number +
                                "@s.whatsapp.net"
                            );

                        await sock.sendMessage(
                            jid,
                            {
                                text:
                                    "✅ Session Saved Successfully In MongoDB",
                            }
                        );

                        console.log(
                            "📨 Message Sent"
                        );

                        await delay(3000);

                        removeFile(
                            sessionDir
                        );

                        console.log(
                            "🧹 Session Folder Deleted"
                        );

                    } catch (err) {

                        console.log(
                            "❌ MongoDB Save Error:",
                            err
                        );
                    }
                }

                /* =========================
                   Connection Closed
                ========================= */

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
                "Internal Server Error",
            error: String(err),
        });
    }
});

/* =========================================
   Error Handlers
========================================= */

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

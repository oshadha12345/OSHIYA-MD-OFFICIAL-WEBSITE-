import express from "express";
import fs from "fs";
import pino from "pino";
import mongoose from "mongoose";

import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
    DisconnectReason,
} from "@whiskeysockets/baileys";

import pn from "awesome-phonenumber";

const router = express.Router();

/* =========================================
   MongoDB Connection
========================================= */

mongoose.connect(
    "mongodb+srv://oshiyabot_db_user:fUVQpH9mtD1qvcf3@oshiyamd.r1yksvq.mongodb.net/oshiyamd?retryWrites=true&w=majority&appName=oshiyamd",
    {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    }
);

mongoose.connection.on("connected", () => {
    console.log("✅ MongoDB Connected");
});

mongoose.connection.on("error", (err) => {
    console.log("❌ MongoDB Error:", err);
});

/* =========================================
   Session Schema
========================================= */

const sessionSchema = new mongoose.Schema({
    number: String,

    sessionId: String,

    sessionData: Object,

    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const Session = mongoose.model("Session", sessionSchema);

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
        console.log("❌ Remove File Error:", err);
    }
}

/* =========================================
   Route
========================================= */

router.get("/", async (req, res) => {
    try {
        let num = req.query.number;

        if (!num) {
            return res.status(400).json({
                status: false,
                message: "Number is required",
            });
        }

        num = num.replace(/[^0-9]/g, "");

        const phone = pn("+" + num);

        if (!phone.isValid()) {
            return res.status(400).json({
                status: false,
                message: "Invalid number",
            });
        }

        num = phone.getNumber("e164").replace("+", "");

        const sessionDir = `./session_${num}`;

        removeFile(sessionDir);

        const { state, saveCreds } =
            await useMultiFileAuthState(sessionDir);

        const { version } =
            await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,

            logger: pino({
                level: "silent",
            }),

            printQRInTerminal: false,

            browser: Browsers.windows("Chrome"),

            auth: {
                creds: state.creds,

                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    pino({ level: "silent" })
                ),
            },

            connectTimeoutMs: 60000,

            keepAliveIntervalMs: 10000,

            markOnlineOnConnect: false,

            defaultQueryTimeoutMs: 60000,
        });

        /* =========================================
           Save Creds
        ========================================= */

        sock.ev.on("creds.update", saveCreds);

        /* =========================================
           Connection Update
        ========================================= */

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === "open") {
                console.log("✅ WhatsApp Connected");

                try {
                    /* =========================
                       Read Full Session Files
                    ========================= */

                    const files = fs.readdirSync(sessionDir);

                    let sessionData = {};

                    for (const file of files) {
                        const filePath = `${sessionDir}/${file}`;

                        const data = fs.readFileSync(
                            filePath,
                            "utf-8"
                        );

                        sessionData[file] =
                            JSON.parse(data);
                    }

                    /* =========================
                       Save MongoDB
                    ========================= */

                    await Session.findOneAndUpdate(
                        {
                            number: num,
                        },
                        {
                            number: num,

                            sessionId:
                                state.creds.me?.id || num,

                            sessionData,
                        },
                        {
                            upsert: true,
                            new: true,
                        }
                    );

                    console.log(
                        "✅ Session Saved To MongoDB"
                    );

                    /* =========================
                       Send Message
                    ========================= */

                    const jid = jidNormalizedUser(
                        `${num}@s.whatsapp.net`
                    );

                    await sock.sendMessage(jid, {
                        text: "✅ Session Saved Successfully In MongoDB",
                    });

                    console.log(
                        "📨 Success Message Sent"
                    );

                    await delay(3000);

                    removeFile(sessionDir);

                    console.log(
                        "🧹 Session Folder Deleted"
                    );

                } catch (err) {
                    console.log(
                        "❌ Save Session Error:",
                        err
                    );
                }
            }

            /* =========================================
               Reconnect
            ========================================= */

            if (connection === "close") {
                const reason =
                    lastDisconnect?.error?.output
                        ?.statusCode;

                console.log(
                    "❌ Connection Closed:",
                    reason
                );

                if (
                    reason ===
                    DisconnectReason.loggedOut
                ) {
                    console.log("❌ Logged Out");
                    removeFile(sessionDir);
                } else {
                    console.log("🔄 Reconnecting...");
                }
            }
        });

        /* =========================================
           Pairing Code
        ========================================= */

        if (!state.creds.registered) {
            await delay(2000);

            const code =
                await sock.requestPairingCode(num);

            const formattedCode =
                code?.match(/.{1,4}/g)?.join("-") ||
                code;

            console.log(
                `📱 Pair Code For ${num}:`,
                formattedCode
            );

            return res.json({
                status: true,
                code: formattedCode,
            });
        }

    } catch (err) {
        console.log("❌ Main Error:", err);

        return res.status(500).json({
            status: false,
            message: "Internal Server Error",
            error: String(err),
        });
    }
});

/* =========================================
   Error Handler
========================================= */

process.on("uncaughtException", (err) => {
    console.log("❌ Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
    console.log("❌ Unhandled Rejection:", reason);
});

export default router;

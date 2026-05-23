import express from "express";
import fs from "fs";
import pino from "pino";
import mongoose from "mongoose";
import QRCode from "qrcode";

import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const router = express.Router();

/* =========================
   MongoDB Connection
========================= */

mongoose.connect(
    "mongodb+srv://oshiyabot_db_user:fUVQpH9mtD1qvcf3@oshiyamd.r1yksvq.mongodb.net/?appName=oshiyamd",
);

mongoose.connection.on("connected", () => {
    console.log("✅ MongoDB Connected");
});

mongoose.connection.on("error", (err) => {
    console.log("❌ MongoDB Error:", err);
});

/* =========================
   Session Schema
========================= */

const sessionSchema = new mongoose.Schema({
    sessionId: String,
    userJid: String,
    creds: Object,
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const Session = mongoose.model("qr_sessions", sessionSchema);

/* =========================
   Helpers
========================= */

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;

        fs.rmSync(FilePath, {
            recursive: true,
            force: true,
        });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

/* =========================
   Route
========================= */

router.get("/", async (req, res) => {
    const sessionId =
        Date.now().toString() +
        Math.random().toString(36).substr(2, 9);

    const dirs = `./qr_sessions/session_${sessionId}`;

    if (!fs.existsSync("./qr_sessions")) {
        fs.mkdirSync("./qr_sessions", {
            recursive: true,
        });
    }

    await removeFile(dirs);

    async function initiateSession() {
        const { state, saveCreds } =
            await useMultiFileAuthState(dirs);

        try {
            const { version } =
                await fetchLatestBaileysVersion();

            let responseSent = false;

            const KnightBot = makeWASocket({
                version,

                auth: {
                    creds: state.creds,

                    keys: makeCacheableSignalKeyStore(
                        state.keys,

                        pino({
                            level: "fatal",
                        }).child({
                            level: "fatal",
                        }),
                    ),
                },

                printQRInTerminal: false,

                logger: pino({
                    level: "fatal",
                }).child({
                    level: "fatal",
                }),

                browser: Browsers.windows("Chrome"),

                markOnlineOnConnect: false,

                generateHighQualityLinkPreview: false,

                defaultQueryTimeoutMs: 60000,

                connectTimeoutMs: 60000,

                keepAliveIntervalMs: 30000,

                retryRequestDelayMs: 250,

                maxRetries: 5,
            });

            /* =========================
               Connection Update
            ========================= */

            KnightBot.ev.on(
                "connection.update",
                async (update) => {
                    const {
                        connection,
                        lastDisconnect,
                        isNewLogin,
                        isOnline,
                        qr,
                    } = update;

                    /* =========================
                       QR CODE
                    ========================= */

                    if (qr && !responseSent) {
                        console.log("🟢 QR Code Generated");

                        try {
                            const qrDataURL =
                                await QRCode.toDataURL(qr, {
                                    errorCorrectionLevel: "M",

                                    type: "image/png",

                                    quality: 0.92,

                                    margin: 1,

                                    color: {
                                        dark: "#000000",

                                        light: "#FFFFFF",
                                    },
                                });

                            responseSent = true;

                            res.send({
                                qr: qrDataURL,

                                message:
                                    "QR Code Generated Successfully",

                                instructions: [
                                    "1. Open WhatsApp",

                                    "2. Linked Devices",

                                    "3. Link A Device",

                                    "4. Scan QR",
                                ],
                            });
                        } catch (err) {
                            console.log(
                                "❌ QR Generate Error:",
                                err,
                            );

                            responseSent = true;

                            res.status(500).send({
                                code: "Failed To Generate QR",
                            });
                        }
                    }

                    /* =========================
                       CONNECTED
                    ========================= */

                    if (connection === "open") {
                        console.log(
                            "✅ WhatsApp Connected",
                        );

                        try {
                            const credsPath =
                                dirs + "/creds.json";

                            const credsData = JSON.parse(
                                fs.readFileSync(credsPath),
                            );

                            const userJid =
                                jidNormalizedUser(
                                    KnightBot.authState.creds
                                        .me?.id || "",
                                );

                            const existing =
                                await Session.findOne({
                                    sessionId,
                                });

                            if (existing) {
                                await Session.updateOne(
                                    {
                                        sessionId,
                                    },

                                    {
                                        userJid,

                                        creds: credsData,
                                    },
                                );

                                console.log(
                                    "✅ Session Updated",
                                );
                            } else {
                                await Session.create({
                                    sessionId,

                                    userJid,

                                    creds: credsData,
                                });

                                console.log(
                                    "✅ Session Saved To MongoDB",
                                );
                            }

                            if (userJid) {
                                await KnightBot.sendMessage(
                                    userJid,
                                    {
                                        text: "✅ Session Saved In MongoDB Successfully",
                                    },
                                );

                                console.log(
                                    "📄 Confirmation message sent",
                                );
                            }

                            console.log(
                                "🧹 Cleaning Session Files",
                            );

                            await delay(1000);

                            removeFile(dirs);

                            console.log(
                                "✅ Session Folder Deleted",
                            );

                            await delay(2000);

                            process.exit(0);
                        } catch (error) {
                            console.log(
                                "❌ MongoDB Save Error:",
                                error,
                            );

                            removeFile(dirs);

                            process.exit(1);
                        }
                    }

                    /* =========================
                       LOGIN EVENTS
                    ========================= */

                    if (isNewLogin) {
                        console.log(
                            "🔐 New Login Via QR",
                        );
                    }

                    if (isOnline) {
                        console.log(
                            "📶 Client Online",
                        );
                    }

                    /* =========================
                       CLOSE
                    ========================= */

                    if (connection === "close") {
                        const statusCode =
                            lastDisconnect?.error?.output
                                ?.statusCode;

                        if (statusCode === 401) {
                            console.log(
                                "❌ Logged Out",
                            );
                        } else {
                            console.log(
                                "🔁 Reconnecting...",
                            );

                            initiateSession();
                        }
                    }
                },
            );

            KnightBot.ev.on(
                "creds.update",
                saveCreds,
            );

            /* =========================
               TIMEOUT
            ========================= */

            setTimeout(() => {
                if (!responseSent) {
                    responseSent = true;

                    res.status(408).send({
                        code: "QR Generation Timeout",
                    });

                    removeFile(dirs);

                    setTimeout(
                        () => process.exit(1),
                        2000,
                    );
                }
            }, 30000);
        } catch (err) {
            console.log(
                "❌ Initialization Error:",
                err,
            );

            if (!res.headersSent) {
                res.status(503).send({
                    code: "Service Unavailable",
                });
            }

            removeFile(dirs);

            setTimeout(() => process.exit(1), 2000);
        }
    }

    await initiateSession();
});

/* =========================
   Error Handler
========================= */

process.on("uncaughtException", (err) => {
    let e = String(err);

    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;

    if (
        e.includes("Stream Errored") ||
        e.includes(
            "Stream Errored (restart required)",
        )
    )
        return;

    if (
        e.includes("statusCode: 515") ||
        e.includes("statusCode: 503")
    )
        return;

    console.log("Caught exception:", err);

    process.exit(1);
});

export default router;

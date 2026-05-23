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
} from "@whiskeysockets/baileys";

import pn from "awesome-phonenumber";

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
    number: String,
    sessionId: String,
    creds: Object,
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const Session = mongoose.model("Session", sessionSchema);

/* =========================
   Helpers
========================= */

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

/* =========================
   Route
========================= */

router.get("/", async (req, res) => {
    let num = req.query.number;

    let dirs = "./" + (num || `session`);

    await removeFile(dirs);

    num = num.replace(/[^0-9]/g, "");

    const phone = pn("+" + num);

    if (!phone.isValid()) {
        return res.status(400).send({
            code: "Invalid phone number",
        });
    }

    num = phone.getNumber("e164").replace("+", "");

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();

            let KnightBot = makeWASocket({
                version,

                auth: {
                    creds: state.creds,

                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({
                            level: "fatal",
                        }),
                    ),
                },

                printQRInTerminal: false,

                logger: pino({ level: "fatal" }).child({
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

            KnightBot.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === "open") {
                    console.log("✅ Connected Successfully");

                    try {
                        const credsPath = dirs + "/creds.json";

                        const credsData = JSON.parse(
                            fs.readFileSync(credsPath),
                        );

                        const existing = await Session.findOne({
                            number: num,
                        });

                        if (existing) {
                            await Session.updateOne(
                                { number: num },
                                {
                                    sessionId: state.creds.me?.id || num,
                                    creds: credsData,
                                },
                            );

                            console.log("✅ Session Updated");
                        } else {
                            await Session.create({
                                number: num,
                                sessionId: state.creds.me?.id || num,
                                creds: credsData,
                            });

                            console.log("✅ Session Saved");
                        }

                        const userJid = jidNormalizedUser(
                            num + "@s.whatsapp.net",
                        );

                        await KnightBot.sendMessage(userJid, {
                            text: "✅ Your Session Saved In MongoDB Successfully",
                        });

                        console.log("📄 Session message sent");

                        await delay(1000);

                        removeFile(dirs);

                        console.log("🧹 Session folder cleaned");

                        await delay(2000);

                        process.exit(0);
                    } catch (error) {
                        console.log("❌ MongoDB Save Error:", error);

                        removeFile(dirs);

                        process.exit(1);
                    }
                }

                if (connection === "close") {
                    const statusCode =
                        lastDisconnect?.error?.output?.statusCode;

                    if (statusCode === 401) {
                        console.log("❌ Logged out");
                    } else {
                        console.log("🔁 Reconnecting...");
                        initiateSession();
                    }
                }
            });

            /* =========================
               Pair Code
            ========================= */

            if (!KnightBot.authState.creds.registered) {
                await delay(3000);

                num = num.replace(/[^\d+]/g, "");

                if (num.startsWith("+")) {
                    num = num.substring(1);
                }

                try {
                    let code = await KnightBot.requestPairingCode(num);

                    code =
                        code?.match(/.{1,4}/g)?.join("-") || code;

                    console.log({
                        num,
                        code,
                    });

                    return res.send({
                        code,
                    });
                } catch (error) {
                    console.log(
                        "❌ Pair Code Error:",
                        error,
                    );

                    return res.status(503).send({
                        code: "Failed to get pairing code",
                    });
                }
            }

            KnightBot.ev.on("creds.update", saveCreds);
        } catch (err) {
            console.log("❌ Initialization Error:", err);

            return res.status(503).send({
                code: "Service Unavailable",
            });
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
        e.includes("restart required")
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

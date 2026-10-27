/**
 * ATELIER — LOCALHOST CRM & ORDER TRACKING SERVER (http://localhost:3456)
 * - Tự động đồng bộ đơn hàng + tải ảnh khách gửi từ Web chính (https://atelier-order.github.io/atelier-noi-dia/)
 * - Tự động tạo thư mục riêng từng khách trên máy tính: Khach-Hang-ATELIER/[SĐT] - [Tên Khách]/ kèm file Ảnh (.jpg)
 * - Hệ thống theo dõi trạng thái đơn hàng (Chờ báo giá -> Đã báo giá -> Đã chốt)
 * - Nút [ ✓ TICK CLEAR ] khi xử lý xong -> Tự động lưu vào Lịch Sử Khách Hàng để chăm sóc & Remarketing
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT = 3456;
const CLOUD_RELAY_TOPIC = "atelier_crm_sync_78f4cba0_0823230703";
const DATA_ROOT_DIR = path.join(__dirname, "Khach-Hang-ATELIER");
const DB_FILE_PATH = path.join(DATA_ROOT_DIR, "crm-database.json");

if (!fs.existsSync(DATA_ROOT_DIR)) {
  fs.mkdirSync(DATA_ROOT_DIR, { recursive: true });
}

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE_PATH)) {
      const raw = fs.readFileSync(DB_FILE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      return {
        orders: Array.isArray(parsed.orders) ? parsed.orders : [],
        customerNotes: parsed.customerNotes || {}
      };
    }
  } catch (e) {}
  return { orders: [], customerNotes: {} };
}

function saveDatabase(db) {
  try {
    fs.writeFileSync(DB_FILE_PATH, JSON.stringify(db, null, 2), "utf8");
  } catch (e) {}
}

let db = loadDatabase();

function sanitizeFolderName(str) {
  return String(str || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Khach-Hang";
}

function ensureCustomerFolder(order) {
  const phone = sanitizeFolderName(order.clientZalo || "Chua-SDT");
  const name = sanitizeFolderName(order.clientName || "Khach");
  const city = sanitizeFolderName(order.clientCity || "VN");
  const folderName = `${phone} - ${name} (${city})`;
  const folderPath = path.join(DATA_ROOT_DIR, folderName);
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
  }
  return { folderName, folderPath };
}

function downloadRemoteFile(url, destPath) {
  return new Promise((resolve) => {
    try {
      const client = url.startsWith("https") ? https : http;
      client.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(downloadRemoteFile(res.headers.location, destPath));
        }
        if (res.statusCode !== 200) return resolve(false);
        const fileStream = fs.createWriteStream(destPath);
        res.pipe(fileStream);
        fileStream.on("finish", () => {
          fileStream.close(() => resolve(true));
        });
        fileStream.on("error", () => resolve(false));
      }).on("error", () => resolve(false));
    } catch (e) {
      resolve(false);
    }
  });
}

async function saveOrderFilesToCustomerFolder(order) {
  const { folderName, folderPath } = ensureCustomerFolder(order);
  order.localFolderName = folderName;
  order.localFolderPath = folderPath;

  const orderId = sanitizeFolderName(order.orderId || "ATL");
  const items = Array.isArray(order.items) ? order.items : [];

  // Save base64 image if available
  const imgData = order.firstImage || (items[0] && items[0].image) || "";
  if (imgData && imgData.startsWith("data:image/")) {
    try {
      const parts = imgData.split(",");
      const ext = parts[0].includes("png") ? "png" : "jpg";
      const imgFileName = `${orderId}_Anh-San-Pham.${ext}`;
      const imgFullPath = path.join(folderPath, imgFileName);
      if (!fs.existsSync(imgFullPath)) {
        fs.writeFileSync(imgFullPath, Buffer.from(parts[1], "base64"));
      }
      order.savedImageFile = imgFileName;
    } catch (e) {}
  } else {
    // Or download from remoteImageUrl if sent via Cloud Relay
    const remoteUrl = (items[0] && items[0].remoteImageUrl) ||
      (order.remoteUrls && order.remoteUrls.split(",")[0].trim()) || "";
    if (remoteUrl && /^https?:\/\//i.test(remoteUrl) && !remoteUrl.includes("shopee.vn")) {
      const imgFileName = `${orderId}_Anh-San-Pham.jpg`;
      const imgFullPath = path.join(folderPath, imgFileName);
      if (!fs.existsSync(imgFullPath)) {
        const ok = await downloadRemoteFile(remoteUrl, imgFullPath);
        if (ok) {
          order.savedImageFile = imgFileName;
          try {
            const b64 = fs.readFileSync(imgFullPath).toString("base64");
            order.firstImage = `data:image/jpeg;base64,${b64}`;
          } catch (e) {}
        }
      }
    }
  }

  // Write human-readable text summary inside customer's folder
  const infoPath = path.join(folderPath, `${orderId}_Thong-Tin-Don.txt`);
  const lines = [
    `==========================================================`,
    `PHIẾU YÊU CẦU BÁO GIÁ & ĐẶT HÀNG // ATELIER`,
    `==========================================================`,
    `Mã đơn hàng     : ${order.orderId}`,
    `Thời gian gửi   : ${order.createdAt}`,
    `Tên khách hàng  : ${order.clientName}`,
    `SĐT / Zalo      : ${order.clientZalo}`,
    `Khu vực nhận    : ${order.clientCity}`,
    `Trạng thái      : ${order.status || "pending"}`,
    `Ghi chú theo dõi: ${order.trackingNote || "(Chưa có)"}`,
    `----------------------------------------------------------`,
    `CHI TIẾT YÊU CẦU:`,
    order.itemsSummary || "",
    order.remoteUrls ? `Link đính kèm   : ${order.remoteUrls}` : "",
    `==========================================================`
  ].filter(Boolean).join("\r\n");

  try {
    fs.writeFileSync(infoPath, lines, "utf8");
  } catch (e) {}
}

async function upsertOrder(incoming) {
  if (!incoming || !incoming.orderId) return null;
  const existingIdx = db.orders.findIndex(o => o.orderId === incoming.orderId);
  if (existingIdx > -1) {
    const cur = db.orders[existingIdx];
    if (!cur.firstImage && incoming.firstImage) cur.firstImage = incoming.firstImage;
    if (!cur.remoteUrls && incoming.remoteUrls) cur.remoteUrls = incoming.remoteUrls;
    if (!cur.localFolderName) await saveOrderFilesToCustomerFolder(cur);
    saveDatabase(db);
    return cur;
  }

  const newOrder = {
    orderId: incoming.orderId,
    createdAt: incoming.createdAt || new Date().toLocaleString("vi-VN"),
    createdAtIso: incoming.createdAtIso || new Date().toISOString(),
    status: incoming.status || "pending", // pending | quoted | ordered | cleared
    clearedAt: incoming.clearedAt || "",
    trackingNote: incoming.trackingNote || "",
    source: incoming.source || "Web ATELIER",
    clientName: incoming.clientName || "Khách đặt hàng",
    clientZalo: incoming.clientZalo || "Chưa điền SĐT",
    clientCity: incoming.clientCity || "TP. Hồ Chí Minh",
    scale: incoming.scale || "",
    itemCount: incoming.itemCount || (Array.isArray(incoming.items) ? incoming.items.length : 1),
    itemsSummary: incoming.itemsSummary || "",
    firstImage: incoming.firstImage || (Array.isArray(incoming.items) && incoming.items[0] ? incoming.items[0].image : "") || "",
    remoteUrls: incoming.remoteUrls || "",
    items: Array.isArray(incoming.items) ? incoming.items : []
  };

  await saveOrderFilesToCustomerFolder(newOrder);
  db.orders.unshift(newOrder);
  saveDatabase(db);
  return newOrder;
}

// Poll Cloud Relay (ntfy.sh) so orders placed on https://atelier-order.github.io/atelier-noi-dia/ arrive automatically!
function syncFromCloudRelay() {
  return new Promise((resolve) => {
    const url = `https://ntfy.sh/${CLOUD_RELAY_TOPIC}/json?poll=1&since=all`;
    https.get(url, (res) => {
      if (res.statusCode !== 200) return resolve(0);
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", async () => {
        let added = 0;
        const lines = raw.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg && msg.event === "message" && msg.message) {
              const payload = JSON.parse(msg.message);
              if (payload && payload.orderId) {
                const existed = db.orders.some(o => o.orderId === payload.orderId);
                await upsertOrder(payload);
                if (!existed) added++;
              }
            }
          } catch (e) {}
        }
        resolve(added);
      });
    }).on("error", () => resolve(0));
  });
}

// Background poll every 8 seconds
setInterval(() => {
  syncFromCloudRelay().catch(() => {});
}, 8000);
syncFromCloudRelay().catch(() => {});

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ATELIER // Localhost CRM — Quản Lý Đơn Hàng & Lịch Sử Khách Hàng</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&family=Playfair+Display:ital,wght@0,600;0,700;1,600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #F6F3EC;
      --bg-secondary: #ECE7DC;
      --bg-elevated: #FAF8F4;
      --ink-primary: #181615;
      --ink-secondary: #57524A;
      --ink-muted: #878075;
      --accent: #9E3B24;
      --accent-soft: rgba(158, 59, 36, 0.1);
      --olive: #2E5A36;
      --olive-soft: rgba(46, 90, 54, 0.12);
      --blue: #1D4ED8;
      --blue-soft: rgba(29, 78, 216, 0.1);
      --purple: #6D28D9;
      --purple-soft: rgba(109, 40, 217, 0.1);
      --amber: #B45309;
      --amber-soft: rgba(180, 83, 9, 0.12);
      --hairline: #D8D1C5;
      --hairline-strong: #181615;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Be Vietnam Pro', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-primary);
      color: var(--ink-primary);
      line-height: 1.5;
      padding-bottom: 4rem;
    }
    button, input, select, textarea { font-family: inherit; }
    .top-bar {
      background: var(--ink-primary);
      color: var(--bg-elevated);
      padding: 0.9rem 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
      border-bottom: 2px solid var(--accent);
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .brand-wrap {
      display: flex;
      align-items: baseline;
      gap: 1rem;
    }
    .brand-logo {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 1.55rem;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .brand-tag {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #E5B299;
      font-weight: 600;
    }
    .top-actions {
      display: flex;
      gap: 0.65rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .btn {
      padding: 0.58rem 1rem;
      font-size: 0.75rem;
      font-weight: 600;
      border: 1px solid var(--hairline-strong);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      text-decoration: none;
      transition: all 0.18s;
    }
    .btn-primary {
      background: var(--accent);
      color: #FAF8F4;
      border-color: var(--accent);
    }
    .btn-primary:hover { background: #7D2D1B; }
    .btn-success {
      background: var(--olive);
      color: #FAF8F4;
      border-color: var(--olive);
    }
    .btn-success:hover { background: #224428; }
    .btn-outline {
      background: var(--bg-elevated);
      color: var(--ink-primary);
      border-color: var(--hairline-strong);
    }
    .btn-outline:hover {
      background: var(--ink-primary);
      color: var(--bg-elevated);
    }
    .container {
      max-width: 1420px;
      margin: 0 auto;
      padding: 1.5rem 2rem;
    }
    /* Stats Bar */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border: 1px solid var(--hairline-strong);
      background: var(--bg-elevated);
      margin-bottom: 1.5rem;
    }
    .stat-cell {
      padding: 1.15rem 1.35rem;
      border-right: 1px solid var(--hairline);
      cursor: pointer;
      transition: background 0.2s;
    }
    .stat-cell:last-child { border-right: none; }
    .stat-cell:hover { background: var(--bg-secondary); }
    .stat-label {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--ink-secondary);
      margin-bottom: 0.35rem;
    }
    .stat-num {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 2.1rem;
      font-weight: 700;
      line-height: 1.1;
    }
    .stat-sub {
      font-size: 0.75rem;
      color: var(--ink-muted);
      margin-top: 0.25rem;
    }
    /* Main Tabs & Filter Controls */
    .tabs-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
      border-bottom: 2px solid var(--hairline-strong);
      padding-bottom: 0.85rem;
      margin-bottom: 1.25rem;
    }
    .main-tabs {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .tab-btn {
      padding: 0.7rem 1.25rem;
      font-size: 0.8rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--bg-secondary);
      color: var(--ink-secondary);
      border: 1px solid var(--hairline);
      cursor: pointer;
    }
    .tab-btn.active {
      background: var(--ink-primary);
      color: var(--bg-elevated);
      border-color: var(--ink-primary);
    }
    .filter-row {
      display: flex;
      gap: 0.65rem;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 1.25rem;
    }
    .search-input {
      padding: 0.6rem 0.95rem;
      border: 1px solid var(--hairline-strong);
      background: var(--bg-elevated);
      font-size: 0.84rem;
      min-width: 280px;
    }
    .pill-btn {
      padding: 0.45rem 0.85rem;
      font-size: 0.74rem;
      font-weight: 600;
      border: 1px solid var(--hairline);
      background: var(--bg-elevated);
      cursor: pointer;
    }
    .pill-btn.active {
      background: var(--accent);
      color: #FAF8F4;
      border-color: var(--accent);
    }
    /* Order Cards List */
    .orders-list {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .order-card {
      background: var(--bg-elevated);
      border: 1px solid var(--hairline-strong);
      display: grid;
      grid-template-columns: 165px 1.25fr 1.15fr;
      overflow: hidden;
      transition: box-shadow 0.2s;
    }
    .order-card:hover {
      box-shadow: 0 8px 24px rgba(0,0,0,0.08);
    }
    .order-card.is-cleared {
      opacity: 0.88;
      border-left: 5px solid var(--olive);
    }
    .order-card.is-pending {
      border-left: 5px solid var(--amber);
    }
    .order-card.is-quoted {
      border-left: 5px solid var(--blue);
    }
    .order-card.is-ordered {
      border-left: 5px solid var(--purple);
    }
    .order-img-col {
      background: var(--bg-secondary);
      border-right: 1px solid var(--hairline);
      padding: 0.85rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .order-thumb {
      width: 138px;
      height: 138px;
      object-fit: cover;
      border: 1px solid var(--hairline-strong);
      cursor: zoom-in;
      background: #fff;
    }
    .order-info-col {
      padding: 1.15rem 1.35rem;
      border-right: 1px solid var(--hairline);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .order-track-col {
      padding: 1.15rem 1.35rem;
      background: rgba(236, 231, 220, 0.45);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .badge {
      display: inline-block;
      padding: 0.22rem 0.6rem;
      font-size: 0.68rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge-pending { background: var(--amber-soft); color: var(--amber); border: 1px solid var(--amber); }
    .badge-quoted { background: var(--blue-soft); color: var(--blue); border: 1px solid var(--blue); }
    .badge-ordered { background: var(--purple-soft); color: var(--purple); border: 1px solid var(--purple); }
    .badge-cleared { background: var(--olive-soft); color: var(--olive); border: 1px solid var(--olive); }

    .client-title {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 1.35rem;
      font-weight: 700;
      color: var(--ink-primary);
    }
    .phone-link {
      font-size: 1.02rem;
      font-weight: 700;
      color: var(--accent);
      text-decoration: none;
    }
    .items-box {
      padding: 0.7rem 0.85rem;
      background: var(--bg-primary);
      border: 1px solid var(--hairline);
      font-size: 0.84rem;
      line-height: 1.55;
    }
    .note-textarea {
      width: 100%;
      min-height: 62px;
      padding: 0.55rem 0.7rem;
      border: 1px solid var(--hairline-strong);
      background: var(--bg-elevated);
      font-size: 0.8rem;
      resize: vertical;
    }
    /* Customer History Cards */
    .customer-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 1rem;
    }
    .customer-card {
      background: var(--bg-elevated);
      border: 1px solid var(--hairline-strong);
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 0.9rem;
    }
    .history-mini-list {
      border-top: 1px dashed var(--hairline);
      padding-top: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: 210px;
      overflow-y: auto;
    }
    .history-mini-item {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      padding: 0.45rem;
      background: var(--bg-primary);
      border: 1px solid var(--hairline);
      font-size: 0.78rem;
    }
    .history-mini-item img {
      width: 42px;
      height: 42px;
      object-fit: cover;
      border: 1px solid var(--hairline);
      cursor: zoom-in;
    }
    /* Lightbox & Modal */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(24, 22, 21, 0.75);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 200;
      padding: 1.5rem;
    }
    .modal-backdrop.open { display: flex; }
    .modal-box {
      background: var(--bg-elevated);
      border: 2px solid var(--hairline-strong);
      padding: 1.5rem;
      max-width: 560px;
      width: 100%;
    }
    .toast {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      background: var(--ink-primary);
      color: #FAF8F4;
      border-left: 4px solid var(--olive);
      padding: 0.85rem 1.25rem;
      font-size: 0.8rem;
      font-weight: 600;
      z-index: 300;
      display: none;
      box-shadow: 0 10px 25px rgba(0,0,0,0.22);
    }
    .toast.show { display: block; }
    @media (max-width: 980px) {
      .stats-grid, .order-card, .customer-grid { grid-template-columns: 1fr; }
      .order-img-col, .order-info-col { border-right: none; border-bottom: 1px solid var(--hairline); }
    }
  </style>
</head>
<body>
  <header class="top-bar">
    <div class="brand-wrap">
      <span class="brand-logo">ATELIER // LOCALHOST CRM</span>
      <span class="brand-tag">● HỆ THỐNG THEO DÕI ĐƠN HÀNG & LƯU LỊCH SỬ KHÁCH HÀNG TRÊN MÁY TÍNH</span>
    </div>
    <div class="top-actions">
      <button type="button" class="btn btn-outline" style="background: transparent; color: #FAF8F4; border-color: rgba(255,255,255,0.35);" id="syncNowBtn">
        🔄 ĐỒNG BỘ ĐƠN MỚI TỪ WEB
      </button>
      <button type="button" class="btn btn-outline" style="background: transparent; color: #FAF8F4; border-color: rgba(255,255,255,0.35);" id="openRootFolderBtn">
        📂 MỞ THƯ MỤC ẢNH KHÁCH HÀNG TRÊN MÁY
      </button>
      <button type="button" class="btn btn-outline" style="background: transparent; color: #FAF8F4; border-color: rgba(255,255,255,0.35);" id="openAddModalBtn">
        ➕ THÊM ĐƠN THỦ CÔNG
      </button>
      <button type="button" class="btn btn-primary" id="exportExcelBtn">
        📊 XUẤT FILE EXCEL (.XLS)
      </button>
    </div>
  </header>

  <main class="container">
    <!-- 4 Ô Thống Kê Nhanh -->
    <div class="stats-grid">
      <div class="stat-cell" onclick="switchTab('active', 'all')">
        <div class="stat-label">📋 ĐƠN CHƯA XỬ LÝ (ĐANG THEO DÕI)</div>
        <div class="stat-num" style="color: var(--amber);" id="statActiveCount">0</div>
        <div class="stat-sub">Cần liên hệ báo giá / chốt đơn</div>
      </div>
      <div class="stat-cell" onclick="switchTab('active', 'quoted')">
        <div class="stat-label">🔵 ĐÃ BÁO GIÁ / ĐANG CHỜ KHÁCH</div>
        <div class="stat-num" style="color: var(--blue);" id="statQuotedCount">0</div>
        <div class="stat-sub">Đang theo dõi phản hồi của khách</div>
      </div>
      <div class="stat-cell" onclick="switchTab('cleared')">
        <div class="stat-label">✅ ĐÃ TICK CLEAR (HOÀN TẤT)</div>
        <div class="stat-num" style="color: var(--olive);" id="statClearedCount">0</div>
        <div class="stat-sub">Đơn đã xử lý xong & lưu lịch sử</div>
      </div>
      <div class="stat-cell" onclick="switchTab('customers')">
        <div class="stat-label">👥 HỒ SƠ LỊCH SỬ KHÁCH HÀNG</div>
        <div class="stat-num" style="color: var(--accent);" id="statCustomerCount">0</div>
        <div class="stat-sub">Khách hàng lưu SĐT để Remarketing</div>
      </div>
    </div>

    <!-- Thanh chuyển Tab chính -->
    <div class="tabs-bar">
      <div class="main-tabs">
        <button type="button" class="tab-btn active" id="tabActiveBtn" onclick="switchTab('active')">
          📋 1. THEO DÕI ĐƠN CHƯA XỬ LÝ (<span id="badgeActive">0</span>)
        </button>
        <button type="button" class="tab-btn" id="tabCustomersBtn" onclick="switchTab('customers')">
          👥 2. LỊCH SỬ KHÁCH HÀNG & REMARKETING (<span id="badgeCustomers">0</span>)
        </button>
        <button type="button" class="tab-btn" id="tabClearedBtn" onclick="switchTab('cleared')">
          ✅ 3. ĐƠN ĐÃ TICK CLEAR / HOÀN TẤT (<span id="badgeCleared">0</span>)
        </button>
      </div>

      <div style="font-size: 0.76rem; color: var(--ink-secondary);">
        📁 Thư mục lưu ảnh tự động: <strong>Khach-Hang-ATELIER/[SĐT] - [Tên Khách]/</strong>
      </div>
    </div>

    <!-- Bộ lọc tìm kiếm & lọc trạng thái theo dõi -->
    <div class="filter-row">
      <input type="text" id="searchInput" class="search-input" placeholder="🔍 Tìm theo Tên khách, SĐT, Mã đơn, Tên sản phẩm..." oninput="renderCurrentView()" />
      <div id="statusFilterPills" style="display: flex; gap: 0.45rem; flex-wrap: wrap;">
        <button type="button" class="pill-btn active" data-st="all" onclick="setStatusFilter('all')">Tất cả đang theo dõi</button>
        <button type="button" class="pill-btn" data-st="pending" onclick="setStatusFilter('pending')">🟡 Mới gửi — Chờ báo giá</button>
        <button type="button" class="pill-btn" data-st="quoted" onclick="setStatusFilter('quoted')">🔵 Đã báo giá — Đang chăm sóc</button>
        <button type="button" class="pill-btn" data-st="ordered" onclick="setStatusFilter('ordered')">🟣 Đã chốt cọc — Đang đặt xưởng</button>
      </div>
    </div>

    <!-- Vùng hiển thị nội dung -->
    <div id="mainContentArea"></div>
  </main>

  <!-- Lightbox phóng to ảnh -->
  <div class="modal-backdrop" id="imgLightbox" onclick="this.classList.remove('open')">
    <img id="lightboxImg" src="" alt="Preview" style="max-width: 92vw; max-height: 90vh; border: 3px solid #FAF8F4; background: #fff;" />
  </div>

  <!-- Modal thêm đơn thủ công -->
  <div class="modal-backdrop" id="addOrderModal">
    <div class="modal-box">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; border-bottom: 1px solid var(--hairline); padding-bottom: 0.65rem;">
        <h3 style="font-family: 'Playfair Display', serif; font-size: 1.35rem;">Thêm Đơn Hàng / Khách Hàng Mới</h3>
        <button type="button" class="btn btn-outline" onclick="document.getElementById('addOrderModal').classList.remove('open')">ĐÓNG ×</button>
      </div>
      <form id="manualOrderForm" style="display: flex; flex-direction: column; gap: 0.75rem;">
        <div>
          <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 0.25rem;">Tên Khách Hàng *</label>
          <input type="text" id="mClientName" class="search-input" style="width: 100%;" placeholder="VD: Minh Anh / Shop Decor..." required />
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
          <div>
            <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 0.25rem;">SĐT / Zalo *</label>
            <input type="text" id="mClientZalo" class="search-input" style="width: 100%; min-width: 0;" placeholder="VD: 0987..." required />
          </div>
          <div>
            <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 0.25rem;">Khu Vực</label>
            <input type="text" id="mClientCity" class="search-input" style="width: 100%; min-width: 0;" value="TP. Hồ Chí Minh" />
          </div>
        </div>
        <div>
          <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 0.25rem;">Sản Phẩm / Yêu Cầu Báo Giá *</label>
          <input type="text" id="mItemTitle" class="search-input" style="width: 100%;" placeholder="VD: Đặt mua hộ ghế sofa kem / Gói nội thất..." required />
        </div>
        <div>
          <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 0.25rem;">Đính Kèm Ảnh Mẫu (Nếu có)</label>
          <input type="file" id="mItemImage" accept="image/*" />
        </div>
        <div>
          <label style="font-size: 0.75rem; font-weight: 700; display: block; margin-bottom: 0.25rem;">Ghi Chú Theo Dõi</label>
          <input type="text" id="mTrackingNote" class="search-input" style="width: 100%;" placeholder="VD: Khách hỏi qua Zalo, cần báo giá sỉ..." />
        </div>
        <button type="submit" class="btn btn-primary" style="justify-content: center; padding: 0.85rem; margin-top: 0.4rem;">
          ✓ LƯU VÀO CRM & TẠO THƯ MỤC KHÁCH HÀNG
        </button>
      </form>
    </div>
  </div>

  <div class="toast" id="crmToast">ĐÃ CẬP NHẬT</div>

  <script>
    let allOrders = [];
    let customerNotes = {};
    let currentTab = "active"; // active | customers | cleared
    let currentStatusFilter = "all"; // all | pending | quoted | ordered

    function showToast(msg) {
      const t = document.getElementById("crmToast");
      t.textContent = msg;
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 2600);
    }

    function esc(s) {
      return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    async function fetchOrders() {
      try {
        const res = await fetch("/api/orders");
        const data = await res.json();
        allOrders = Array.isArray(data.orders) ? data.orders : [];
        customerNotes = data.customerNotes || {};
        updateCounters();
        renderCurrentView();
      } catch (e) {}
    }

    function updateCounters() {
      const activeList = allOrders.filter(o => o.status !== "cleared");
      const quotedList = allOrders.filter(o => o.status === "quoted" || o.status === "ordered");
      const clearedList = allOrders.filter(o => o.status === "cleared");

      const uniquePhones = new Set(allOrders.map(o => (o.clientZalo || "").trim()).filter(Boolean));

      document.getElementById("statActiveCount").textContent = activeList.length;
      document.getElementById("statQuotedCount").textContent = quotedList.length;
      document.getElementById("statClearedCount").textContent = clearedList.length;
      document.getElementById("statCustomerCount").textContent = uniquePhones.size;

      document.getElementById("badgeActive").textContent = activeList.length;
      document.getElementById("badgeCleared").textContent = clearedList.length;
      document.getElementById("badgeCustomers").textContent = uniquePhones.size;
    }

    function switchTab(tab, statusSubFilter) {
      currentTab = tab;
      if (statusSubFilter) currentStatusFilter = statusSubFilter;
      document.getElementById("tabActiveBtn").classList.toggle("active", tab === "active");
      document.getElementById("tabCustomersBtn").classList.toggle("active", tab === "customers");
      document.getElementById("tabClearedBtn").classList.toggle("active", tab === "cleared");
      document.getElementById("statusFilterPills").style.display = tab === "active" ? "flex" : "none";
      updatePillUI();
      renderCurrentView();
    }

    function setStatusFilter(st) {
      currentStatusFilter = st;
      updatePillUI();
      renderCurrentView();
    }

    function updatePillUI() {
      document.querySelectorAll("#statusFilterPills .pill-btn").forEach(b => {
        b.classList.toggle("active", b.getAttribute("data-st") === currentStatusFilter);
      });
    }

    function getStatusBadgeHtml(status) {
      if (status === "cleared") return '<span class="badge badge-cleared">✓ ĐÃ TICK CLEAR (HOÀN TẤT)</span>';
      if (status === "quoted") return '<span class="badge badge-quoted">🔵 ĐÃ BÁO GIÁ • ĐANG CHĂM SÓC</span>';
      if (status === "ordered") return '<span class="badge badge-ordered">🟣 ĐÃ CHỐT CỌC • ĐANG ĐẶT XƯỞNG</span>';
      return '<span class="badge badge-pending">🟡 MỚI GỬI • CHỜ BÁO GIÁ</span>';
    }

    function openLightbox(src) {
      if (!src) return;
      document.getElementById("lightboxImg").src = src;
      document.getElementById("imgLightbox").classList.add("open");
    }

    async function updateOrderStatus(orderId, newStatus) {
      const noteEl = document.getElementById("note_" + orderId);
      const trackingNote = noteEl ? noteEl.value.trim() : undefined;
      await fetch("/api/orders/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, status: newStatus, trackingNote })
      });
      if (newStatus === "cleared") {
        showToast("✅ ĐÃ TICK CLEAR ĐƠN HÀNG & LƯU VÀO LỊCH SỬ KHÁCH HÀNG!");
      } else {
        showToast("✓ ĐÃ CẬP NHẬT TRẠNG THÁI THEO DÕI!");
      }
      await fetchOrders();
    }

    async function saveOrderNote(orderId) {
      const noteEl = document.getElementById("note_" + orderId);
      if (!noteEl) return;
      await fetch("/api/orders/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, trackingNote: noteEl.value.trim() })
      });
      showToast("💾 ĐÃ LƯU GHI CHÚ THEO DÕI!");
      await fetchOrders();
    }

    async function saveCustomerHistoryNote(phone) {
      const el = document.getElementById("custnote_" + phone);
      if (!el) return;
      await fetch("/api/customers/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, note: el.value.trim() })
      });
      showToast("💾 ĐÃ LƯU GHI CHÚ HỒ SƠ KHÁCH HÀNG!");
      await fetchOrders();
    }

    async function deleteOrder(orderId) {
      if (!confirm("Bạn có chắc muốn xóa đơn này khỏi CRM?")) return;
      await fetch("/api/orders/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId })
      });
      showToast("🗑️ ĐÃ XÓA ĐƠN HÀNG");
      await fetchOrders();
    }

    async function openCustomerFolderOnPc(orderId) {
      await fetch("/api/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId })
      });
      showToast("📂 ĐANG MỞ THƯ MỤC CỦA KHÁCH TRÊN MÁY TÍNH...");
    }

    function renderCurrentView() {
      const q = (document.getElementById("searchInput").value || "").trim().toLowerCase();
      const area = document.getElementById("mainContentArea");

      if (currentTab === "customers") {
        renderCustomersHistoryView(area, q);
        return;
      }

      const list = allOrders.filter(o => {
        if (currentTab === "active" && o.status === "cleared") return false;
        if (currentTab === "cleared" && o.status !== "cleared") return false;
        if (currentTab === "active" && currentStatusFilter !== "all" && (o.status || "pending") !== currentStatusFilter) return false;
        if (!q) return true;
        return (
          (o.clientName || "").toLowerCase().includes(q) ||
          (o.clientZalo || "").toLowerCase().includes(q) ||
          (o.orderId || "").toLowerCase().includes(q) ||
          (o.itemsSummary || "").toLowerCase().includes(q) ||
          (o.trackingNote || "").toLowerCase().includes(q)
        );
      });

      if (list.length === 0) {
        area.innerHTML = \`
          <div style="padding: 3.5rem 2rem; text-align: center; background: var(--bg-elevated); border: 1px dashed var(--hairline-strong); color: var(--ink-secondary);">
            <h3 style="font-family: 'Playfair Display', serif; font-size: 1.4rem; margin-bottom: 0.4rem;">
              \${currentTab === "active" ? "🎉 Không còn đơn hàng nào đang chờ xử lý!" : "Chưa có đơn hàng nào trong mục này."}
            </h3>
            <p style="font-size: 0.85rem;">Khi khách gửi ảnh & bấm Lưu trên trang web, đơn hàng và ảnh sẽ tự động đổ về đây.</p>
          </div>
        \`;
        return;
      }

      area.innerHTML = '<div class="orders-list">' + list.map(o => {
        const st = o.status || "pending";
        const cleanPhone = String(o.clientZalo || "").replace(/\\D/g, "");
        return \`
          <article class="order-card is-\${st}">
            <!-- Cột 1: Ảnh sản phẩm khách gửi -->
            <div class="order-img-col">
              \${o.firstImage
                ? \`<img src="\${o.firstImage}" class="order-thumb" title="Bấm để phóng to ảnh" onclick="openLightbox('\${o.firstImage}')" />\`
                : \`<div class="order-thumb" style="display:flex;align-items:center;justify-content:center;font-size:0.72rem;color:var(--ink-muted);text-align:center;padding:0.5rem;">Khách gửi Link / Không đính kèm ảnh</div>\`
              }
              <div style="display: flex; flex-direction: column; gap: 0.35rem; width: 100%;">
                \${o.firstImage ? \`<a href="\${o.firstImage}" download="Anh-\${esc(o.clientZalo)}-\${esc(o.orderId)}.jpg" class="btn btn-outline" style="font-size:0.68rem; padding:0.35rem; justify-content:center;">📥 Tải Ảnh Gốc</a>\` : ""}
                <button type="button" class="btn btn-outline" style="font-size:0.68rem; padding:0.35rem; justify-content:center;" onclick="openCustomerFolderOnPc('\${esc(o.orderId)}')">
                  📂 Mở Folder Máy
                </button>
              </div>
            </div>

            <!-- Cột 2: Thông tin khách & Chi tiết sản phẩm -->
            <div class="order-info-col">
              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.45rem;">
                  \${getStatusBadgeHtml(st)}
                  <span style="font-size: 0.74rem; color: var(--ink-muted); font-weight: 600;">Mã: \${esc(o.orderId)} • 🕒 \${esc(o.createdAt)}</span>
                </div>

                <div style="display: flex; align-items: baseline; gap: 0.85rem; flex-wrap: wrap; margin-bottom: 0.6rem;">
                  <span class="client-title">👤 \${esc(o.clientName)}</span>
                  <a href="https://zalo.me/\${cleanPhone}" target="_blank" class="phone-link">📞 \${esc(o.clientZalo)} (Mở Zalo ↗)</a>
                  <span style="font-size: 0.8rem; color: var(--ink-secondary); background: var(--bg-secondary); padding: 0.15rem 0.55rem;">📍 \${esc(o.clientCity)}</span>
                </div>

                <div class="items-box">
                  <strong style="display: block; color: var(--ink-primary); margin-bottom: 0.25rem;">📦 Nội dung yêu cầu báo giá / đặt hàng:</strong>
                  <div>\${esc(o.itemsSummary)}</div>
                  \${o.remoteUrls ? \`<div style="margin-top:0.35rem;"><a href="\${esc(o.remoteUrls.split(',')[0].trim())}" target="_blank" style="color:var(--accent);font-weight:600;word-break:break-all;">🔗 Mở Link Shopee / Link Ảnh Gốc ↗</a></div>\` : ""}
                </div>
              </div>

              <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; font-size: 0.74rem; color: var(--ink-muted);">
                <span>📁 Thư mục trên máy: <strong>Khach-Hang-ATELIER/\${esc(o.localFolderName || "")}</strong></span>
              </div>
            </div>

            <!-- Cột 3: Hệ thống Theo Dõi & Nút Tick Clear -->
            <div class="order-track-col">
              <div>
                <label style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; color: var(--ink-secondary); display: block; margin-bottom: 0.35rem;">
                  🔄 BƯỚC THEO DÕI ĐƠN HÀNG:
                </label>
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.35rem; margin-bottom: 0.65rem;">
                  <button type="button" class="pill-btn \${st === 'pending' ? 'active' : ''}" style="font-size: 0.68rem; padding: 0.4rem 0.3rem;" onclick="updateOrderStatus('\${esc(o.orderId)}', 'pending')">
                    🟡 Chờ Báo Giá
                  </button>
                  <button type="button" class="pill-btn \${st === 'quoted' ? 'active' : ''}" style="font-size: 0.68rem; padding: 0.4rem 0.3rem;" onclick="updateOrderStatus('\${esc(o.orderId)}', 'quoted')">
                    🔵 Đã Báo Giá
                  </button>
                  <button type="button" class="pill-btn \${st === 'ordered' ? 'active' : ''}" style="font-size: 0.68rem; padding: 0.4rem 0.3rem;" onclick="updateOrderStatus('\${esc(o.orderId)}', 'ordered')">
                    🟣 Đã Chốt Đơn
                  </button>
                </div>

                <label style="font-size: 0.72rem; font-weight: 700; text-transform: uppercase; color: var(--ink-secondary); display: block; margin-bottom: 0.25rem;">
                  📝 GHI CHÚ THEO DÕI NỘI BỘ (GIÁ ĐÃ BÁO / LỊCH HẸN):
                </label>
                <div style="display: flex; gap: 0.4rem;">
                  <textarea id="note_\${esc(o.orderId)}" class="note-textarea" placeholder="VD: Đã kết bạn Zalo báo giá 1.850k, khách hẹn tối chốt màu...">\${esc(o.trackingNote || "")}</textarea>
                  <button type="button" class="btn btn-outline" style="padding: 0 0.65rem; font-size: 0.7rem;" onclick="saveOrderNote('\${esc(o.orderId)}')">Lưu</button>
                </div>
              </div>

              <div style="display: flex; gap: 0.5rem; align-items: center;">
                \${st !== "cleared" ? \`
                  <button type="button" class="btn btn-success" style="flex: 1; justify-content: center; padding: 0.75rem; font-size: 0.8rem;" onclick="updateOrderStatus('\${esc(o.orderId)}', 'cleared')">
                    ✓ TICK CLEAR (ĐÃ XỬ LÝ XONG)
                  </button>
                \` : \`
                  <button type="button" class="btn btn-outline" style="flex: 1; justify-content: center; padding: 0.65rem; font-size: 0.75rem;" onclick="updateOrderStatus('\${esc(o.orderId)}', 'pending')">
                    ↩️ ĐƯA LẠI VỀ ĐANG THEO DÕI
                  </button>
                \`}
                <button type="button" class="btn btn-outline" style="padding: 0.65rem 0.75rem; color: var(--accent);" title="Xóa đơn này" onclick="deleteOrder('\${esc(o.orderId)}')">🗑️</button>
              </div>
            </div>
          </article>
        \`;
      }).join("") + "</div>";
    }

    function renderCustomersHistoryView(area, q) {
      const map = new Map();
      allOrders.forEach(o => {
        const key = (o.clientZalo || "Chua-SDT").trim();
        if (!map.has(key)) {
          map.set(key, {
            phone: key,
            name: o.clientName,
            city: o.clientCity,
            lastSeen: o.createdAt,
            sampleOrderId: o.orderId,
            orders: []
          });
        }
        map.get(key).orders.push(o);
      });

      const customers = Array.from(map.values()).filter(c => {
        if (!q) return true;
        return (
          (c.name || "").toLowerCase().includes(q) ||
          (c.phone || "").toLowerCase().includes(q) ||
          (c.city || "").toLowerCase().includes(q)
        );
      });

      if (customers.length === 0) {
        area.innerHTML = \`
          <div style="padding: 3rem; text-align: center; background: var(--bg-elevated); border: 1px dashed var(--hairline-strong);">
            Chưa có hồ sơ khách hàng nào.
          </div>
        \`;
        return;
      }

      area.innerHTML = '<div class="customer-grid">' + customers.map(c => {
        const cleanPhone = String(c.phone || "").replace(/\\D/g, "");
        const clearedCount = c.orders.filter(x => x.status === "cleared").length;
        const activeCount = c.orders.length - clearedCount;
        const cNote = customerNotes[c.phone] || "";

        return \`
          <article class="customer-card">
            <div>
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.5rem;">
                <div>
                  <h3 class="client-title">👤 \${esc(c.name)}</h3>
                  <div style="font-size: 0.85rem; color: var(--ink-secondary); margin-top: 0.15rem;">
                    📞 <strong style="color: var(--accent);">\${esc(c.phone)}</strong> • 📍 \${esc(c.city)}
                  </div>
                </div>
                <div style="display: flex; gap: 0.4rem;">
                  <a href="https://zalo.me/\${cleanPhone}" target="_blank" class="btn btn-primary" style="padding: 0.4rem 0.75rem; font-size: 0.7rem;">💬 Nhắn Zalo</a>
                  <button type="button" class="btn btn-outline" style="padding: 0.4rem 0.75rem; font-size: 0.7rem;" onclick="openCustomerFolderOnPc('\${esc(c.sampleOrderId)}')">📂 Mở Folder Ảnh</button>
                </div>
              </div>

              <div style="display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem;">
                <span class="badge badge-quoted">Tổng lịch sử: \${c.orders.length} lần đặt/hỏi</span>
                <span class="badge badge-cleared">Đã hoàn tất: \${clearedCount} đơn</span>
                \${activeCount > 0 ? \`<span class="badge badge-pending">Đang theo dõi: \${activeCount} đơn</span>\` : ""}
              </div>

              <div style="margin-bottom: 0.75rem;">
                <label style="font-size: 0.7rem; font-weight: 700; text-transform: uppercase; color: var(--ink-secondary); display: block; margin-bottom: 0.25rem;">
                  💎 Ghi chú Chăm Sóc Khách Hàng & Ưu Đãi Mua Lại (Remarketing):
                </label>
                <div style="display: flex; gap: 0.4rem;">
                  <input type="text" id="custnote_\${esc(c.phone)}" class="search-input" style="flex: 1; min-width: 0; padding: 0.45rem 0.65rem; font-size: 0.78rem;" placeholder="VD: Khách VIP hay mua đồ decor / Chủ shop thời trang..." value="\${esc(cNote)}" />
                  <button type="button" class="btn btn-outline" style="padding: 0.45rem 0.75rem; font-size: 0.7rem;" onclick="saveCustomerHistoryNote('\${esc(c.phone)}')">Lưu</button>
                </div>
              </div>

              <div class="history-mini-list">
                <div style="font-size: 0.72rem; font-weight: 700; color: var(--ink-secondary); text-transform: uppercase;">Lịch sử các món khách đã gửi (\${c.orders.length}):</div>
                \${c.orders.map(o => \`
                  <div class="history-mini-item">
                    \${o.firstImage ? \`<img src="\${o.firstImage}" onclick="openLightbox('\${o.firstImage}')" />\` : ""}
                    <div style="flex: 1;">
                      <div style="font-weight: 600;">\${esc(o.itemsSummary)}</div>
                      <div style="font-size: 0.7rem; color: var(--ink-muted);">
                        \${esc(o.createdAt)} • \${o.status === 'cleared' ? '✓ Đã Tick Clear' : '⏳ Đang theo dõi'} \${o.trackingNote ? '• Ghi chú: ' + esc(o.trackingNote) : ''}
                      </div>
                    </div>
                  </div>
                \`).join("")}
              </div>
            </div>
          </article>
        \`;
      }).join("") + "</div>";
    }

    // Đồng bộ đơn mới từ Web về ngay lập tức
    document.getElementById("syncNowBtn").addEventListener("click", async () => {
      showToast("🔄 Đang kiểm tra và kéo đơn mới từ Web về...");
      await fetch("/api/sync-cloud", { method: "POST" });
      await fetchOrders();
      showToast("✓ ĐÃ ĐỒNG BỘ DỮ LIỆU MỚI NHẤT!");
    });

    // Mở thư mục gốc chứa tất cả folder khách hàng trên máy tính
    document.getElementById("openRootFolderBtn").addEventListener("click", async () => {
      await fetch("/api/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      showToast("📂 Đang mở thư mục Khach-Hang-ATELIER trên máy tính...");
    });

    // Mở modal thêm đơn thủ công
    document.getElementById("openAddModalBtn").addEventListener("click", () => {
      document.getElementById("addOrderModal").classList.add("open");
    });

    document.getElementById("manualOrderForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const clientName = document.getElementById("mClientName").value.trim();
      const clientZalo = document.getElementById("mClientZalo").value.trim();
      const clientCity = document.getElementById("mClientCity").value.trim();
      const itemTitle = document.getElementById("mItemTitle").value.trim();
      const trackingNote = document.getElementById("mTrackingNote").value.trim();
      const fileInput = document.getElementById("mItemImage");

      const submitPayload = async (imgBase64) => {
        await fetch("/api/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId: "ATL-" + Date.now().toString().slice(-6),
            createdAt: new Date().toLocaleString("vi-VN"),
            status: "pending",
            clientName,
            clientZalo,
            clientCity,
            trackingNote,
            itemsSummary: "[THỦ CÔNG] " + itemTitle,
            firstImage: imgBase64 || "",
            items: [{ code: "CRM", title: itemTitle, image: imgBase64 || "" }]
          })
        });
        document.getElementById("manualOrderForm").reset();
        document.getElementById("addOrderModal").classList.remove("open");
        showToast("✓ ĐÃ THÊM ĐƠN & TẠO THƯ MỤC KHÁCH HÀNG!");
        fetchOrders();
      };

      if (fileInput.files && fileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = (ev) => submitPayload(ev.target.result);
        reader.readAsDataURL(fileInput.files[0]);
      } else {
        submitPayload("");
      }
    });

    // Xuất bảng Excel (.XLS) chia cột rõ ràng
    document.getElementById("exportExcelBtn").addEventListener("click", () => {
      if (allOrders.length === 0) {
        showToast("Chưa có dữ liệu đơn hàng để xuất Excel!");
        return;
      }
      const rows = allOrders.map(o => \`
        <tr>
          <td style="border:1px solid #ccc;padding:6px;">\${esc(o.orderId)}</td>
          <td style="border:1px solid #ccc;padding:6px;">\${esc(o.createdAt)}</td>
          <td style="border:1px solid #ccc;padding:6px;font-weight:bold;">\${esc(o.clientName)}</td>
          <td style="border:1px solid #ccc;padding:6px;mso-number-format:'\\\\@';font-weight:bold;color:#9E3B24;">\${esc(o.clientZalo)}</td>
          <td style="border:1px solid #ccc;padding:6px;">\${esc(o.clientCity)}</td>
          <td style="border:1px solid #ccc;padding:6px;">\${o.status === 'cleared' ? 'Đã Tick Clear (Hoàn tất)' : (o.status === 'quoted' ? 'Đã báo giá' : (o.status === 'ordered' ? 'Đã chốt đơn' : 'Chờ báo giá'))}</td>
          <td style="border:1px solid #ccc;padding:6px;">\${esc(o.itemsSummary)}</td>
          <td style="border:1px solid #ccc;padding:6px;">\${esc(o.trackingNote || "")}</td>
          <td style="border:1px solid #ccc;padding:6px;">Khach-Hang-ATELIER/\${esc(o.localFolderName || "")}</td>
        </tr>
      \`).join("");

      const html = \`
        <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
        <head><meta charset="UTF-8"></head>
        <body>
          <table border="1" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;">
            <thead>
              <tr style="background:#181615;color:#FAF8F4;font-weight:bold;">
                <th style="padding:8px;">Mã Đơn</th>
                <th style="padding:8px;">Thời Gian</th>
                <th style="padding:8px;">Tên Khách Hàng</th>
                <th style="padding:8px;">SĐT / Zalo</th>
                <th style="padding:8px;">Khu Vực</th>
                <th style="padding:8px;">Trạng Thái Theo Dõi</th>
                <th style="padding:8px;">Chi Tiết Sản Phẩm</th>
                <th style="padding:8px;">Ghi Chú Theo Dõi</th>
                <th style="padding:8px;">Thư Mục Ảnh Trên Máy</th>
              </tr>
            </thead>
            <tbody>\${rows}</tbody>
          </table>
        </body>
        </html>
      \`;
      const blob = new Blob(["\\uFEFF" + html], { type: "application/vnd.ms-excel;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "CRM-Khach-Hang-ATELIER-" + new Date().toISOString().slice(0, 10) + ".xls";
      a.click();
      URL.revokeObjectURL(url);
      showToast("📊 ĐÃ XUẤT BẢNG EXCEL (.XLS) CHIA CỘT RÕ RÀNG!");
    });

    fetchOrders();
    setInterval(fetchOrders, 6000);
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendJson(res, 200, { ok: true });
  }

  const urlObj = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = urlObj.pathname;

  if (req.method === "GET" && (pathname === "/" || pathname === "/crm")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(DASHBOARD_HTML);
  }

  if (req.method === "GET" && pathname === "/api/orders") {
    return sendJson(res, 200, {
      ok: true,
      orders: db.orders,
      customerNotes: db.customerNotes || {}
    });
  }

  if (req.method === "POST" && pathname === "/api/orders") {
    const body = await readJsonBody(req);
    const saved = await upsertOrder(body);
    return sendJson(res, 200, { ok: true, order: saved });
  }

  if (req.method === "POST" && pathname === "/api/orders/bulk") {
    const body = await readJsonBody(req);
    const leads = Array.isArray(body.leads) ? body.leads : [];
    for (const l of leads) {
      await upsertOrder(l);
    }
    return sendJson(res, 200, { ok: true, count: leads.length });
  }

  if (req.method === "POST" && pathname === "/api/orders/update") {
    const body = await readJsonBody(req);
    const ord = db.orders.find(o => o.orderId === body.orderId);
    if (ord) {
      if (body.status) {
        ord.status = body.status;
        if (body.status === "cleared") {
          ord.clearedAt = new Date().toLocaleString("vi-VN");
        }
      }
      if (typeof body.trackingNote === "string") {
        ord.trackingNote = body.trackingNote;
      }
      await saveOrderFilesToCustomerFolder(ord);
      saveDatabase(db);
    }
    return sendJson(res, 200, { ok: true, order: ord });
  }

  if (req.method === "POST" && pathname === "/api/orders/delete") {
    const body = await readJsonBody(req);
    db.orders = db.orders.filter(o => o.orderId !== body.orderId);
    saveDatabase(db);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/customers/note") {
    const body = await readJsonBody(req);
    if (body.phone) {
      db.customerNotes = db.customerNotes || {};
      db.customerNotes[body.phone] = body.note || "";
      saveDatabase(db);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/sync-cloud") {
    const added = await syncFromCloudRelay();
    return sendJson(res, 200, { ok: true, added });
  }

  if (req.method === "POST" && pathname === "/api/open-folder") {
    const body = await readJsonBody(req);
    let targetDir = DATA_ROOT_DIR;
    if (body.orderId) {
      const ord = db.orders.find(o => o.orderId === body.orderId);
      if (ord && ord.localFolderPath && fs.existsSync(ord.localFolderPath)) {
        targetDir = ord.localFolderPath;
      }
    }
    exec(`explorer.exe "${targetDir}"`);
    return sendJson(res, 200, { ok: true, opened: targetDir });
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("==============================================================");
  console.log("  ATELIER // LOCALHOST CRM SERVER DANG CHAY TAI:");
  console.log(`  👉 http://localhost:${PORT}`);
  console.log(`  📁 Thu muc luu anh khach hang: ${DATA_ROOT_DIR}`);
  console.log("==============================================================");
});

/**
 * ATELIER — HỆ THỐNG LƯU TRỮ GOOGLE DRIVE THEO TỪNG KHÁCH HÀNG & GOOGLE SHEETS CRM REMARKETING
 * ---------------------------------------------------------------------------------------------
 * CÁCH CÀI ĐẶT CHỈ TRONG 1 PHÚT (MIỄN PHÍ 100% TRÊN GOOGLE DRIVE CỦA BẠN):
 * 1. Truy cập: https://script.google.com -> Bấm "Dự án mới" (New Project).
 * 2. Xóa đoạn mã mặc định, dán toàn bộ nội dung file này vào rồi bấm biểu tượng Lưu (Ctrl + S).
 * 3. Bấm nút "Triển khai" (Deploy) ở góc trên bên phải -> Chọn "Tùy chọn triển khai mới" (New deployment).
 * 4. Ở mục "Chọn loại" (hình bánh răng), chọn "Ứng dụng web" (Web app):
 *    - Thực thi dưới dạng (Execute as): Chọn "Tôi" (Me).
 *    - Ai có quyền truy cập (Who has access): Chọn "Bất kỳ ai" (Anyone).
 * 5. Bấm "Triển khai" (Deploy) -> Cấp quyền truy cập Google Drive & Sheets -> Copy đường link "URL ứng dụng web" (có đuôi /exec).
 * 6. Dán đường link /exec đó vào mục "⚙️ Kết nối Google Drive CRM" ở cuối trang web ATELIER (hoặc gửi cho AI gắn cứng vào web).
 */

const ROOT_FOLDER_NAME = "ATELIER — Dữ Liệu Khách Hàng & Đơn Hàng";
const CRM_SHEET_NAME = "ATELIER — Database Khách Hàng (CRM & Remarketing)";

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const data = JSON.parse(raw);

    const timestamp = Utilities.formatDate(new Date(), "GMT+7", "yyyy-MM-dd HH:mm:ss");
    const dateShort = Utilities.formatDate(new Date(), "GMT+7", "yyyyMMdd-HHmm");
    const orderId = data.orderId || ("ATL-" + dateShort);

    const clientName = (data.clientName || "Khach-Hang").trim();
    const clientPhone = (data.clientPhone || "Chua-Co-SDT").replace(/[^\d+]/g, "") || "Chua-Co-SDT";
    const clientCity = (data.clientCity || "Toàn quốc").trim();
    const items = Array.isArray(data.items) ? data.items : [];

    // 1. Tìm hoặc tạo Thư mục gốc trên Google Drive
    const rootFolder = getOrCreateFolder_(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);

    // 2. Tìm hoặc tạo Thư mục riêng cho từng Khách Hàng (Gộp theo SĐT để khách quay lại vẫn vào đúng folder)
    const customerFolderKey = clientPhone !== "Chua-Co-SDT" ? clientPhone : clientName;
    const customerFolderName = `${clientPhone} - ${clientName} (${clientCity})`;
    const customerFolder = getOrCreateCustomerFolder_(rootFolder, customerFolderKey, customerFolderName);

    // Cho phép mở xem qua link
    try {
      customerFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {}

    // 3. Lưu từng hình ảnh khách tải lên / dán vào Thư mục riêng của khách hàng
    const savedImageLinks = [];
    items.forEach((item, idx) => {
      if (item.image && typeof item.image === "string" && item.image.indexOf("data:image/") === 0) {
        try {
          const parts = item.image.split(",");
          const meta = parts[0];
          const base64Data = parts[1];
          const mimeMatch = meta.match(/data:(image\/[a-zA-Z0-9.+-]+);base64/);
          const mimeType = mimeMatch ? mimeMatch[1] : "image/jpeg";
          const ext = mimeType.indexOf("png") > -1 ? "png" : "jpg";
          const safeTitle = (item.title || "San-pham").replace(/[\\/:*?"<>|]/g, "-").slice(0, 40);
          const fileName = `${dateShort}_Mon-${idx + 1}_${safeTitle}.${ext}`;

          const blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType, fileName);
          const file = customerFolder.createFile(blob);
          try {
            file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          } catch (err) {}

          savedImageLinks.push({
            index: idx + 1,
            title: item.title,
            url: file.getUrl()
          });
        } catch (imgErr) {}
      }
    });

    // 4. Tạo 1 file Phiếu Đơn Hàng (HTML có kèm ảnh trực quan) lưu trong thư mục của khách
    const summaryHtml = buildOrderHtmlFile_(orderId, timestamp, clientName, clientPhone, clientCity, items, savedImageLinks);
    const htmlBlob = Utilities.newBlob(summaryHtml, "text/html", `Phieu-${orderId}.html`);
    const orderFile = customerFolder.createFile(htmlBlob);

    // 5. Ghi vào Google Sheets CRM (Lưu cả lịch sử đơn hàng & Danh sách khách hàng Remarketing)
    const sheetUrl = logToCrmSheet_(rootFolder, {
      timestamp,
      orderId,
      clientName,
      clientPhone,
      clientCity,
      items,
      customerFolderUrl: customerFolder.getUrl(),
      orderFileUrl: orderFile.getUrl(),
      savedImageLinks
    });

    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        orderId: orderId,
        customerFolderUrl: customerFolder.getUrl(),
        orderFileUrl: orderFile.getUrl(),
        imageLinks: savedImageLinks,
        crmSheetUrl: sheetUrl
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({
        ok: false,
        error: String(error)
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getOrCreateFolder_(parent, name) {
  const iter = parent.getFoldersByName(name);
  if (iter.hasNext()) return iter.next();
  return parent.createFolder(name);
}

function getOrCreateCustomerFolder_(rootFolder, phoneKey, fullName) {
  const iter = rootFolder.getFolders();
  while (iter.hasNext()) {
    const f = iter.next();
    if (phoneKey !== "Chua-Co-SDT" && f.getName().indexOf(phoneKey) === 0) {
      return f;
    }
  }
  return rootFolder.createFolder(fullName);
}

function buildOrderHtmlFile_(orderId, timestamp, clientName, clientPhone, clientCity, items, savedImageLinks) {
  const rows = items.map((it, i) => `
    <div style="border:1px solid #d4cfc3;padding:16px;margin-bottom:14px;display:flex;gap:16px;align-items:flex-start;background:#faf8f4;">
      ${it.image ? `<img src="${it.image}" style="width:160px;height:160px;object-fit:cover;border:1px solid #ccc;" />` : ""}
      <div>
        <div style="font-size:12px;color:#b83a24;font-weight:bold;">MỤC #${i + 1} — ${it.code || ""}</div>
        <h3 style="margin:6px 0;font-size:18px;">${it.title || ""}</h3>
        <p style="margin:4px 0;font-size:14px;"><strong>Phân loại / Danh mục:</strong> ${it.origin || ""}</p>
        <p style="margin:4px 0;font-size:14px;"><strong>Quy mô / Số lượng:</strong> ${it.mode || ""}</p>
        <p style="margin:4px 0;font-size:14px;color:#555;"><strong>Ghi chú:</strong> ${it.note || ""}</p>
      </div>
    </div>
  `).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Phiếu Báo Giá ${orderId}</title></head>
  <body style="font-family:sans-serif;max-width:820px;margin:24px auto;padding:24px;background:#f4f1ea;color:#141413;">
    <h2 style="margin-top:0;color:#b83a24;">PHIẾU YÊU CẦU BÁO GIÁ // ${orderId}</h2>
    <p><strong>Thời gian:</strong> ${timestamp}<br/>
    <strong>Khách hàng:</strong> ${clientName}<br/>
    <strong>SĐT Zalo/WhatsApp:</strong> ${clientPhone}<br/>
    <strong>Khu vực nhận:</strong> ${clientCity}</p>
    <hr/>
    ${rows}
  </body></html>`;
}

function logToCrmSheet_(rootFolder, record) {
  let ss = null;
  const files = rootFolder.getFilesByName(CRM_SHEET_NAME);
  if (files.hasNext()) {
    ss = SpreadsheetApp.open(files.next());
  } else {
    ss = SpreadsheetApp.create(CRM_SHEET_NAME);
    const ssFile = DriveApp.getFileById(ss.getId());
    rootFolder.addFile(ssFile);
    DriveApp.getRootFolder().removeFile(ssFile);
  }

  // Tab 1: Lịch sử toàn bộ đơn hàng
  let orderSheet = ss.getSheetByName("Don_Hang_Chi_Tiet");
  if (!orderSheet) {
    orderSheet = ss.getSheets()[0];
    orderSheet.setName("Don_Hang_Chi_Tiet");
    orderSheet.appendRow([
      "Thời Gian",
      "Mã Đơn",
      "Tên Khách Hàng",
      "SĐT Zalo / WhatsApp",
      "Khu Vực",
      "Số Lượng Mục",
      "Chi Tiết Sản Phẩm & Ghi Chú",
      "Link Ảnh Khách Gửi (Drive)",
      "Link Thư Mục Riêng Của Khách",
      "Trạng Thái Đơn"
    ]);
    orderSheet.getRange("A1:J1").setFontWeight("bold").setBackground("#EAE5DA");
  }

  const itemsSummary = record.items.map((it, idx) =>
    `${idx + 1}. [${it.code}] ${it.title} (${it.mode}) - ${it.note || ""}`
  ).join("\n");

  const imgLinksText = record.savedImageLinks.map(l => l.url).join("\n") || "Mẫu có sẵn trên web";

  orderSheet.appendRow([
    record.timestamp,
    record.orderId,
    record.clientName,
    "'" + record.clientPhone,
    record.clientCity,
    record.items.length,
    itemsSummary,
    imgLinksText,
    record.customerFolderUrl,
    "Mới gửi - Chờ báo giá"
  ]);

  // Tab 2: CRM Khách Hàng (Gộp theo SĐT để chăm sóc & Remarketing ưu đãi mua lại)
  let crmSheet = ss.getSheetByName("Khach_Hang_Remarketing");
  if (!crmSheet) {
    crmSheet = ss.insertSheet("Khach_Hang_Remarketing");
    crmSheet.appendRow([
      "SĐT Khách Hàng",
      "Tên Khách Hàng",
      "Khu Vực",
      "Tổng Số Lần Gửi Đơn",
      "Lần Đầu Liên Hệ",
      "Lần Gần Nhất Liên Hệ",
      "Mối Quan Tâm / Nhóm Hàng Đã Hỏi",
      "Link Thư Mục Drive Của Khách",
      "Hạng Khách Hàng",
      "Ghi Chú Remarketing / Ưu Đãi Mua Lại"
    ]);
    crmSheet.getRange("A1:J1").setFontWeight("bold").setBackground("#D9E8DD");
  }

  const dataValues = crmSheet.getDataRange().getValues();
  let foundRow = -1;
  for (let r = 1; r < dataValues.length; r++) {
    const existingPhone = String(dataValues[r][0]).replace(/[^\d+]/g, "");
    if (existingPhone && existingPhone === record.clientPhone && record.clientPhone !== "Chua-Co-SDT") {
      foundRow = r + 1;
      break;
    }
  }

  const interestSummary = record.items.map(it => it.title).join(", ");
  if (foundRow > -1) {
    const prevCount = Number(crmSheet.getRange(foundRow, 4).getValue() || 1) + 1;
    const prevInterests = String(crmSheet.getRange(foundRow, 7).getValue() || "");
    crmSheet.getRange(foundRow, 2).setValue(record.clientName);
    crmSheet.getRange(foundRow, 3).setValue(record.clientCity);
    crmSheet.getRange(foundRow, 4).setValue(prevCount);
    crmSheet.getRange(foundRow, 6).setValue(record.timestamp);
    crmSheet.getRange(foundRow, 7).setValue(prevInterests + " | " + interestSummary);
    crmSheet.getRange(foundRow, 8).setValue(record.customerFolderUrl);
    crmSheet.getRange(foundRow, 9).setValue(prevCount >= 3 ? "★ KHÁCH VIP MUA LẠI" : "Khách Quen (Đã hỏi " + prevCount + " lần)");
  } else {
    crmSheet.appendRow([
      "'" + record.clientPhone,
      record.clientName,
      record.clientCity,
      1,
      record.timestamp,
      record.timestamp,
      interestSummary,
      record.customerFolderUrl,
      "Khách Mới",
      "Gửi ưu đãi giảm 15% cước cho đơn tiếp theo"
    ]);
  }

  return ss.getUrl();
}

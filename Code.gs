/**
 * 融融記帳表 — 每週餘額盤點制 Google Apps Script 後端 (Code.gs)
 * 
 * 試算表 A～N 共 14 欄固定結構：
 * A: 盤點日期 | B: 錢包現金 | C: 中信銀行 | D: 日常流動小計 | E: 袋袋現金 | F: 土地銀行 | G: 台灣銀行
 * H: 儲蓄專款小計 | I: 5項目資產總額 | J: 未繳卡費 | K: 真實淨可用餘額 | L: 本週總收入 | M: 本週實際總花費 | N: 備註
 */

// 1. 請設定您的自訂安全驗證 Token（須與前端 App 設定頁輸入的 Token 一致）
const API_TOKEN = 'RONG-2026-SECRET';

// 2. 工作表名稱（若不存在會自動建立並初始化標題列）
const SHEET_NAME = '每週盤點紀錄';

const HEADERS = [
  '盤點日期',       // A
  '錢包現金',       // B
  '中信銀行',       // C
  '日常流動小計',   // D
  '袋袋現金',       // E
  '土地銀行',       // F
  '台灣銀行',       // G
  '儲蓄專款小計',   // H
  '5項目資產總額',  // I
  '未繳卡費',       // J
  '真實淨可用餘額', // K
  '本週總收入',     // L
  '本週實際總花費', // M
  '備註'            // N
];

/**
 * 處理 GET 請求（支援簡易健康檢查）
 */
function doGet(e) {
  return jsonResponse({
    ok: true,
    service: '融融記帳表 Cloud Sync API',
    timestamp: new Date().toISOString()
  });
}

/**
 * 處理 POST 請求
 * 注意：前端使用 Content-Type: text/plain;charset=utf-8 傳送 JSON 字串，
 * 可完美避開 iOS Safari 對 GAS 跨網域 CORS OPTIONS 預檢請求的阻擋。
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: '無效的請求內容' });
    }

    const payload = JSON.parse(e.postData.contents);

    // 驗證 Token
    if (!verifyToken(payload.token)) {
      return jsonResponse({ ok: false, error: 'API Token 驗證失敗，請確認密碼是否一致' });
    }

    const sheet = getOrCreateSheet();
    const action = payload.action;

    switch (action) {
      case 'ping':
        return jsonResponse({
          ok: true,
          message: '連線成功',
          sheetName: sheet.getName(),
          rowCount: Math.max(0, sheet.getLastRow() - 1)
        });

      case 'getAll':
        return jsonResponse({
          ok: true,
          records: readAllRecords(sheet),
          poolConfig: getPoolConfigMetadata()
        });

      case 'syncAll':
        // 接收前端重算後的完整紀錄陣列，確保新增、編輯、刪除後 A~N 欄與後續週次花費 100% 同步
        if (!Array.isArray(payload.records)) {
          return jsonResponse({ ok: false, error: '缺少 records 陣列' });
        }
        if (payload.poolConfig) {
          savePoolConfigMetadata(payload.poolConfig);
        }
        writeAllRecords(sheet, payload.records);
        return jsonResponse({
          ok: true,
          syncedCount: payload.records.length,
          updatedAt: new Date().toISOString()
        });

      case 'appendRow':
        // 單筆新增或更新（向後相容單筆推送，內部自動重算並寫回）
        if (!payload.record) {
          return jsonResponse({ ok: false, error: '缺少單筆 record 資料' });
        }
        const existing = readAllRecords(sheet);
        const idx = existing.findIndex(r => r.date === payload.record.date || (payload.record.id && r.id === payload.record.id));
        if (idx >= 0) {
          existing[idx] = payload.record;
        } else {
          existing.push(payload.record);
        }
        writeAllRecords(sheet, existing);
        return jsonResponse({
          ok: true,
          syncedCount: existing.length,
          updatedAt: new Date().toISOString()
        });

      default:
        return jsonResponse({ ok: false, error: '未知的 action: ' + action });
    }
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: err && err.message ? err.message : String(err)
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 驗證 Token（支援 ScriptProperties 覆寫或上方常數）
 */
function verifyToken(inputToken) {
  const propToken = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const expected = propToken || API_TOKEN;
  return inputToken && String(inputToken).trim() === String(expected).trim();
}

/**
 * 取得或建立工作表並設定標題列格式
 */
function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    styleHeaderRow(sheet);
  } else {
    const firstRow = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    if (firstRow[0] !== HEADERS[0]) {
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      styleHeaderRow(sheet);
    }
  }
  return sheet;
}

/**
 * 美化試算表標題列與欄寬
 */
function styleHeaderRow(sheet) {
  const headerRange = sheet.getRange(1, 1, 1, HEADERS.length);
  headerRange
    .setBackground('#EDE8DF')
    .setFontColor('#2C2623')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 34);
  sheet.setColumnWidth(1, 115); // A: 盤點日期
  for (let col = 2; col <= 13; col++) {
    sheet.setColumnWidth(col, 120);
  }
  sheet.setColumnWidth(14, 220); // N: 備註
}

/**
 * 讀取試算表所有列並轉為前端結構
 */
function readAllRecords(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  const tz = Session.getScriptTimeZone() || 'Asia/Taipei';

  return values
    .filter(row => row[0] !== '' && row[0] !== null)
    .map((row, index) => {
      let dateStr = '';
      if (Object.prototype.toString.call(row[0]) === '[object Date]') {
        dateStr = Utilities.formatDate(row[0], tz, 'yyyy-MM-dd');
      } else {
        dateStr = String(row[0]).trim();
      }

      const isW0 = index === 0 || row[11] === '-' || row[12] === '-';

      return {
        id: 'row-' + dateStr + '-' + index,
        date: dateStr,
        walletCash: toNum(row[1]),
        ctbcBank: toNum(row[2]),
        liquidSubtotal: toNum(row[3]),
        bagCash: toNum(row[4]),
        landBank: toNum(row[5]),
        twBank: toNum(row[6]),
        savingsSubtotal: toNum(row[7]),
        totalAssets: toNum(row[8]),
        unpaidCard: toNum(row[9]),
        netBalance: toNum(row[10]),
        income: isW0 ? 0 : toNum(row[11]),
        actualSpend: isW0 ? null : toNum(row[12]),
        note: row[13] ? String(row[13]) : ''
      };
    });
}

/**
 * 將排序並重算後的紀錄完整寫入 A～N 欄
 * 嚴格遵守 W0 例外規則：第一筆（W0）的 L 欄（本週總收入）與 M 欄（本週實際總花費）填入 '-'
 */
function writeAllRecords(sheet, records) {
  const sorted = records.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // 清除既有資料列（保留第 1 列標題）
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, HEADERS.length).clearContent();
  }

  if (sorted.length === 0) return;

  let prevNetBalance = null;
  const rows = sorted.map((rec, idx) => {
    const walletCash = toNum(rec.walletCash);
    const ctbcBank = toNum(rec.ctbcBank);
    const bagCash = toNum(rec.bagCash);
    const landBank = toNum(rec.landBank);
    const twBank = toNum(rec.twBank);

    // 預設公式：D = B + C, H = E + F + G（若前端有自訂雙池歸屬則使用前端計算後的小計）
    const liquidSubtotal = rec.liquidSubtotal !== undefined
      ? toNum(rec.liquidSubtotal)
      : (walletCash + ctbcBank);
    const savingsSubtotal = rec.savingsSubtotal !== undefined
      ? toNum(rec.savingsSubtotal)
      : (bagCash + landBank + twBank);

    const totalAssets = liquidSubtotal + savingsSubtotal;
    const unpaidCard = toNum(rec.unpaidCard);
    const netBalance = totalAssets - unpaidCard;

    let incomeCell = '-';
    let actualSpendCell = '-';

    if (idx > 0 && prevNetBalance !== null) {
      const income = toNum(rec.income);
      const actualSpend = prevNetBalance + income - netBalance;
      incomeCell = income;
      actualSpendCell = actualSpend;
    }

    prevNetBalance = netBalance;

    return [
      rec.date,          // A: 盤點日期
      walletCash,        // B: 錢包現金
      ctbcBank,          // C: 中信銀行
      liquidSubtotal,    // D: 日常流動小計
      bagCash,           // E: 袋袋現金
      landBank,          // F: 土地銀行
      twBank,            // G: 台灣銀行
      savingsSubtotal,   // H: 儲蓄專款小計
      totalAssets,       // I: 5項目資產總額
      unpaidCard,        // J: 未繳卡費
      netBalance,        // K: 真實淨可用餘額
      incomeCell,        // L: 本週總收入（W0 為 '-'）
      actualSpendCell,   // M: 本週實際總花費（W0 為 '-'）
      rec.note || ''     // N: 備註
    ];
  });

  const dataRange = sheet.getRange(2, 1, rows.length, HEADERS.length);
  dataRange.setValues(rows);

  // 設定格式：日期欄置中、金額欄千分位等寬格式、小計與淨額微底色標示
  sheet.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd').setHorizontalAlignment('center');
  sheet.getRange(2, 2, rows.length, 12).setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange(2, 14, rows.length, 1).setHorizontalAlignment('left');
}

function getPoolConfigMetadata() {
  const raw = PropertiesService.getScriptProperties().getProperty('POOL_CONFIG');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function savePoolConfigMetadata(poolConfig) {
  PropertiesService.getScriptProperties().setProperty('POOL_CONFIG', JSON.stringify(poolConfig));
}

function toNum(val) {
  if (val === '-' || val === null || val === undefined || val === '') return 0;
  const n = Number(String(val).replace(/,/g, ''));
  return isNaN(n) ? 0 : Math.round(n);
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

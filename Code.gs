/**
 * 融融記帳表 — 每週餘額盤點制 + 每月收入與存錢計畫 Google Apps Script 後端 (Code.gs)
 * 
 * 工作表 1：【每週盤點紀錄】（A～P 欄，完整保留 A～N 核心結構並擴充兩種收入明細）
 * A: 盤點日期 | B: 錢包現金 | C: 中信銀行 | D: 日常流動小計 | E: 袋袋現金 | F: 土地銀行 | G: 台灣銀行
 * H: 儲蓄專款小計 | I: 5項目資產總額 | J: 未繳卡費 | K: 真實淨可用餘額 | L: 本週總收入 | M: 本週實際總花費 | N: 備註
 * O: 土銀匯款收入 | P: 袋袋現金收入
 *
 * 工作表 2：【每月收入與存錢計畫】（A～K 欄，每月輸入一次）
 * A: 月份 | B: 土銀匯款收入 | C: 袋袋現金收入 | D: 本月總收入 | E: 現金存款目標 | F: 本月已存現金
 * G: 現金達成率 | H: 台銀存款目標 | I: 本月已存台銀 | J: 台銀達成率 | K: 備註
 */

// 1. 請設定您的自訂安全驗證 Token（須與前端 App 設定頁輸入的 Token 一致）
const API_TOKEN = 'RONG-2026-SECRET';

// 2. 工作表名稱
const SHEET_NAME = '每週盤點紀錄';
const MONTHLY_SHEET_NAME = '每月收入與存錢計畫';

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
  '備註',           // N
  '土銀匯款收入',   // O
  '袋袋現金收入'    // P
];

const MONTHLY_HEADERS = [
  '月份',           // A (YYYY-MM)
  '土銀匯款收入',   // B
  '袋袋現金收入',   // C
  '本月總收入',     // D
  '現金存款目標',   // E (預設 80,000)
  '本月已存現金',   // F
  '現金達成率',     // G
  '台銀存款目標',   // H (預設 45,000)
  '本月已存台銀',   // I
  '台銀達成率',     // J
  '備註'            // K
];

function doGet(e) {
  return jsonResponse({
    ok: true,
    service: '融融記帳表 Cloud Sync API v1.1',
    timestamp: new Date().toISOString()
  });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);

    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: '無效的請求內容' });
    }

    const payload = JSON.parse(e.postData.contents);

    if (!verifyToken(payload.token)) {
      return jsonResponse({ ok: false, error: 'API Token 驗證失敗，請確認密碼是否一致' });
    }

    const sheet = getOrCreateSheet();
    const monthlySheet = getOrCreateMonthlySheet();
    const action = payload.action;

    switch (action) {
      case 'ping':
        return jsonResponse({
          ok: true,
          message: '連線成功',
          sheetName: sheet.getName(),
          rowCount: Math.max(0, sheet.getLastRow() - 1),
          monthlyRowCount: Math.max(0, monthlySheet.getLastRow() - 1)
        });

      case 'getAll':
        return jsonResponse({
          ok: true,
          records: readAllRecords(sheet),
          monthlyPlans: readAllMonthlyPlans(monthlySheet),
          poolConfig: getPoolConfigMetadata(),
          savingsTargets: getSavingsTargetsMetadata()
        });

      case 'syncAll':
        if (!Array.isArray(payload.records)) {
          return jsonResponse({ ok: false, error: '缺少 records 陣列' });
        }
        if (payload.poolConfig) {
          savePoolConfigMetadata(payload.poolConfig);
        }
        if (payload.savingsTargets) {
          saveSavingsTargetsMetadata(payload.savingsTargets);
        }
        writeAllRecords(sheet, payload.records);
        if (Array.isArray(payload.monthlyPlans)) {
          writeAllMonthlyPlans(monthlySheet, payload.monthlyPlans);
        }
        return jsonResponse({
          ok: true,
          syncedCount: payload.records.length,
          monthlySyncedCount: Array.isArray(payload.monthlyPlans) ? payload.monthlyPlans.length : 0,
          updatedAt: new Date().toISOString()
        });

      case 'appendRow':
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

function verifyToken(inputToken) {
  const propToken = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  const expected = propToken || API_TOKEN;
  return inputToken && String(inputToken).trim() === String(expected).trim();
}

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    styleHeaderRow(sheet, HEADERS.length);
  } else {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    styleHeaderRow(sheet, HEADERS.length);
  }
  return sheet;
}

function getOrCreateMonthlySheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MONTHLY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MONTHLY_SHEET_NAME);
  }

  sheet.getRange(1, 1, 1, MONTHLY_HEADERS.length).setValues([MONTHLY_HEADERS]);
  styleHeaderRow(sheet, MONTHLY_HEADERS.length);
  return sheet;
}

function styleHeaderRow(sheet, colCount) {
  const headerRange = sheet.getRange(1, 1, 1, colCount);
  headerRange
    .setBackground('#EDE8DF')
    .setFontColor('#2C2623')
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 34);
  sheet.setColumnWidth(1, 115);
  for (let col = 2; col <= colCount; col++) {
    sheet.setColumnWidth(col, 125);
  }
}

function readAllRecords(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  const maxCols = Math.max(HEADERS.length, sheet.getLastColumn());
  const values = sheet.getRange(2, 1, lastRow - 1, maxCols).getValues();
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
      const incomeLandBank = toNum(row[14]);
      const incomeBagCash = toNum(row[15]);
      const totalIncome = isW0 ? 0 : (row[14] !== undefined && row[14] !== '' ? (incomeLandBank + incomeBagCash) : toNum(row[11]));

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
        income: totalIncome,
        incomeLandBank: isW0 ? 0 : incomeLandBank,
        incomeBagCash: isW0 ? 0 : incomeBagCash,
        actualSpend: isW0 ? null : toNum(row[12]),
        note: row[13] ? String(row[13]) : ''
      };
    });
}

function writeAllRecords(sheet, records) {
  const sorted = records.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));

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
    let incomeLandBankCell = '-';
    let incomeBagCashCell = '-';

    if (idx > 0 && prevNetBalance !== null) {
      const incLand = toNum(rec.incomeLandBank);
      const incBag = toNum(rec.incomeBagCash);
      const income = (incLand + incBag > 0) ? (incLand + incBag) : toNum(rec.income);
      const actualSpend = prevNetBalance + income - netBalance;
      incomeCell = income;
      actualSpendCell = actualSpend;
      incomeLandBankCell = incLand;
      incomeBagCashCell = incBag;
    }

    prevNetBalance = netBalance;

    return [
      rec.date,             // A: 盤點日期
      walletCash,           // B: 錢包現金
      ctbcBank,             // C: 中信銀行
      liquidSubtotal,       // D: 日常流動小計
      bagCash,              // E: 袋袋現金
      landBank,             // F: 土地銀行
      twBank,               // G: 台灣銀行
      savingsSubtotal,      // H: 儲蓄專款小計
      totalAssets,          // I: 5項目資產總額
      unpaidCard,           // J: 未繳卡費
      netBalance,           // K: 真實淨可用餘額
      incomeCell,           // L: 本週總收入（W0 為 '-'）
      actualSpendCell,      // M: 本週實際總花費（W0 為 '-'）
      rec.note || '',       // N: 備註
      incomeLandBankCell,   // O: 土銀匯款收入
      incomeBagCashCell     // P: 袋袋現金收入
    ];
  });

  const dataRange = sheet.getRange(2, 1, rows.length, HEADERS.length);
  dataRange.setValues(rows);

  sheet.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd').setHorizontalAlignment('center');
  sheet.getRange(2, 2, rows.length, 12).setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange(2, 14, rows.length, 1).setHorizontalAlignment('left');
  sheet.getRange(2, 15, rows.length, 2).setNumberFormat('#,##0').setHorizontalAlignment('right');
}

function readAllMonthlyPlans(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, MONTHLY_HEADERS.length).getValues();
  const tz = Session.getScriptTimeZone() || 'Asia/Taipei';

  return values
    .filter(row => row[0] !== '' && row[0] !== null)
    .map(row => {
      let monthStr = '';
      if (Object.prototype.toString.call(row[0]) === '[object Date]') {
        monthStr = Utilities.formatDate(row[0], tz, 'yyyy-MM');
      } else {
        monthStr = String(row[0]).trim();
      }
      return {
        month: monthStr,
        incomeLandBank: toNum(row[1]),
        incomeBagCash: toNum(row[2]),
        totalIncome: toNum(row[3]),
        targetCashSavings: toNum(row[4]) || 80000,
        savedCash: toNum(row[5]),
        targetTwBankSavings: toNum(row[7]) || 45000,
        savedTwBank: toNum(row[8]),
        note: row[10] ? String(row[10]) : ''
      };
    });
}

function writeAllMonthlyPlans(sheet, plans) {
  const sorted = plans.slice().sort((a, b) => String(a.month).localeCompare(String(b.month)));

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, MONTHLY_HEADERS.length).clearContent();
  }

  if (sorted.length === 0) return;

  const rows = sorted.map(p => {
    const incLand = toNum(p.incomeLandBank);
    const incBag = toNum(p.incomeBagCash);
    const totalInc = incLand + incBag;
    const targetCash = toNum(p.targetCashSavings) || 80000;
    const savedCash = toNum(p.savedCash);
    const cashRate = targetCash > 0 ? Math.round((savedCash / targetCash) * 100) + '%' : '0%';
    const targetTw = toNum(p.targetTwBankSavings) || 45000;
    const savedTw = toNum(p.savedTwBank);
    const twRate = targetTw > 0 ? Math.round((savedTw / targetTw) * 100) + '%' : '0%';

    return [
      p.month,
      incLand,
      incBag,
      totalInc,
      targetCash,
      savedCash,
      cashRate,
      targetTw,
      savedTw,
      twRate,
      p.note || ''
    ];
  });

  sheet.getRange(2, 1, rows.length, MONTHLY_HEADERS.length).setValues(rows);
  sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@').setHorizontalAlignment('center');
  sheet.getRange(2, 2, rows.length, 5).setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange(2, 7, rows.length, 1).setHorizontalAlignment('center');
  sheet.getRange(2, 8, rows.length, 2).setNumberFormat('#,##0').setHorizontalAlignment('right');
  sheet.getRange(2, 10, rows.length, 1).setHorizontalAlignment('center');
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

function getSavingsTargetsMetadata() {
  const raw = PropertiesService.getScriptProperties().getProperty('SAVINGS_TARGETS');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function saveSavingsTargetsMetadata(targets) {
  PropertiesService.getScriptProperties().setProperty('SAVINGS_TARGETS', JSON.stringify(targets));
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

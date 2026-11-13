/**
 * 融融記帳表 — 每週餘額盤點制 PWA 前端核心邏輯 (app.js)
 */

const STORAGE_KEYS = {
  RECORDS: 'rong_ledger_records_v1',
  POOL_CONFIG: 'rong_ledger_pool_config_v1',
  CLOUD_CONFIG: 'rong_ledger_cloud_config_v1',
  SYNC_STATE: 'rong_ledger_sync_state_v1',
  A2HS_DISMISSED: 'rong_ledger_a2hs_dismissed_v1'
};

// 五大資產項目定義（對應 Google 試算表 B, C, E, F, G 欄）
const ASSET_ACCOUNTS = [
  { key: 'walletCash', name: '錢包現金', subtitle: '隨身日常皮夾現鈔', defaultPool: 'liquid' },
  { key: 'ctbcBank', name: '中信銀行', subtitle: '日常刷卡扣款與轉帳主力', defaultPool: 'liquid' },
  { key: 'bagCash', name: '袋袋現金', subtitle: '預留信封袋／備用現鈔', defaultPool: 'savings' },
  { key: 'landBank', name: '土地銀行', subtitle: '中長期儲蓄專款帳戶', defaultPool: 'savings' },
  { key: 'twBank', name: '台灣銀行', subtitle: '定存／緊急預備金帳戶', defaultPool: 'savings' }
];

const DEFAULT_POOL_CONFIG = {
  walletCash: 'liquid',
  ctbcBank: 'liquid',
  bagCash: 'savings',
  landBank: 'savings',
  twBank: 'savings'
};

let state = {
  records: [],
  poolConfig: { ...DEFAULT_POOL_CONFIG },
  cloudConfig: {
    gasUrl: '',
    apiToken: ''
  },
  syncMeta: {
    dirty: false,
    lastSyncAt: null,
    status: 'offline' // 'synced' | 'syncing' | 'pending' | 'offline'
  },
  editingId: null,
  selectedChartIndex: null
};

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
  loadStateFromStorage();
  initServiceWorker();
  initA2HSBanner();
  initNavigation();
  renderPoolInputs();
  renderPoolConfigSettings();
  bindEvents();
  resetRecordForm();
  renderAll();

  // 若有待同步資料且目前有網路，啟動背景自動補傳
  if (state.syncMeta.dirty && navigator.onLine && state.cloudConfig.gasUrl) {
    syncToCloud({ silent: true });
  }
});

function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

function initA2HSBanner() {
  const isStandalone =
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  const dismissed = localStorage.getItem(STORAGE_KEYS.A2HS_DISMISSED) === '1';
  const banner = document.getElementById('a2hsBanner');

  if (!isStandalone && !dismissed) {
    banner.classList.remove('hidden');
  }

  document.getElementById('closeA2hsBtn').addEventListener('click', () => {
    banner.classList.add('hidden');
    localStorage.setItem(STORAGE_KEYS.A2HS_DISMISSED, '1');
  });
}

function initNavigation() {
  const navButtons = document.querySelectorAll('.nav-btn');
  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      switchTab(targetId);
    });
  });
}

function switchTab(targetId) {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-target') === targetId);
  });
  document.querySelectorAll('.tab-view').forEach((sec) => {
    sec.classList.toggle('active', sec.id === targetId);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ==================== 核心盤點公式與重算引擎 ====================
/**
 * 依據日期由舊至新排序並自動重算所有欄位（與 Google 試算表 A～N 欄 100% 對齊）
 * W0 例外規則：第一筆紀錄（index === 0）僅作為初始淨餘額基準，
 * 本週總收入與本週實際總花費皆不計入（顯示為 '-'）。
 */
function recalculateRecords(rawRecords, poolConfig = state.poolConfig) {
  const sorted = [...rawRecords].sort((a, b) => {
    const cmp = String(a.date).localeCompare(String(b.date));
    if (cmp !== 0) return cmp;
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  let prevNetBalance = null;

  return sorted.map((rec, idx) => {
    const walletCash = parseMoney(rec.walletCash);
    const ctbcBank = parseMoney(rec.ctbcBank);
    const bagCash = parseMoney(rec.bagCash);
    const landBank = parseMoney(rec.landBank);
    const twBank = parseMoney(rec.twBank);
    const unpaidCard = parseMoney(rec.unpaidCard);

    const amounts = { walletCash, ctbcBank, bagCash, landBank, twBank };

    let liquidSubtotal = 0;
    let savingsSubtotal = 0;

    ASSET_ACCOUNTS.forEach((acc) => {
      const pool = poolConfig[acc.key] || acc.defaultPool;
      if (pool === 'liquid') {
        liquidSubtotal += amounts[acc.key];
      } else {
        savingsSubtotal += amounts[acc.key];
      }
    });

    const totalAssets = liquidSubtotal + savingsSubtotal;
    const netBalance = totalAssets - unpaidCard;

    const isW0 = idx === 0;
    const income = isW0 ? 0 : parseMoney(rec.income);
    const actualSpend = isW0 ? null : (prevNetBalance + income - netBalance);

    const computed = {
      id: rec.id || `rec-${rec.date}-${idx}`,
      date: rec.date,
      weekCode: `W${idx}`,
      isW0,
      walletCash,
      ctbcBank,
      liquidSubtotal,
      bagCash,
      landBank,
      twBank,
      savingsSubtotal,
      totalAssets,
      unpaidCard,
      netBalance,
      income,
      actualSpend,
      prevNetBalance,
      note: (rec.note || '').trim(),
      createdAt: rec.createdAt || Date.now()
    };

    prevNetBalance = netBalance;
    return computed;
  });
}

// ==================== 本機儲存與狀態管理 ====================
function loadStateFromStorage() {
  try {
    const savedPool = localStorage.getItem(STORAGE_KEYS.POOL_CONFIG);
    if (savedPool) {
      state.poolConfig = { ...DEFAULT_POOL_CONFIG, ...JSON.parse(savedPool) };
    }

    const savedCloud = localStorage.getItem(STORAGE_KEYS.CLOUD_CONFIG);
    if (savedCloud) {
      state.cloudConfig = { ...state.cloudConfig, ...JSON.parse(savedCloud) };
    }

    const savedSync = localStorage.getItem(STORAGE_KEYS.SYNC_STATE);
    if (savedSync) {
      state.syncMeta = { ...state.syncMeta, ...JSON.parse(savedSync) };
    }

    const savedRecords = localStorage.getItem(STORAGE_KEYS.RECORDS);
    if (savedRecords) {
      const parsed = JSON.parse(savedRecords);
      state.records = recalculateRecords(parsed, state.poolConfig);
    } else {
      state.records = [];
    }
  } catch (err) {
    console.error('載入本機資料失敗:', err);
  }

  document.getElementById('inputGasUrl').value = state.cloudConfig.gasUrl || '';
  document.getElementById('inputApiToken').value = state.cloudConfig.apiToken || '';
  updateSyncPillUI();
}

function saveStateToStorage({ markDirty = true } = {}) {
  state.records = recalculateRecords(state.records, state.poolConfig);
  localStorage.setItem(STORAGE_KEYS.RECORDS, JSON.stringify(state.records));
  localStorage.setItem(STORAGE_KEYS.POOL_CONFIG, JSON.stringify(state.poolConfig));

  if (markDirty) {
    state.syncMeta.dirty = true;
    state.syncMeta.status = state.cloudConfig.gasUrl ? 'pending' : 'offline';
  }
  localStorage.setItem(STORAGE_KEYS.SYNC_STATE, JSON.stringify(state.syncMeta));
  updateSyncPillUI();
}

// ==================== 動態表單與雙池輸入框渲染 ====================
function renderPoolInputs() {
  const liquidContainer = document.getElementById('liquidInputsContainer');
  const savingsContainer = document.getElementById('savingsInputsContainer');

  // 保存目前輸入中的值避免切換設定時遺失
  const currentValues = {};
  ASSET_ACCOUNTS.forEach((acc) => {
    const el = document.getElementById(`input_${acc.key}`);
    if (el) currentValues[acc.key] = el.value;
  });

  liquidContainer.innerHTML = '';
  savingsContainer.innerHTML = '';

  ASSET_ACCOUNTS.forEach((acc) => {
    const pool = state.poolConfig[acc.key] || acc.defaultPool;
    const row = document.createElement('div');
    row.className = 'form-row';
    row.innerHTML = `
      <label class="form-label" for="input_${acc.key}">
        ${acc.name}
        <small>${acc.subtitle}</small>
      </label>
      <div class="input-wrap">
        <span class="input-prefix">$</span>
        <input
          id="input_${acc.key}"
          data-account="${acc.key}"
          type="text"
          inputmode="decimal"
          class="amount-input auto-select"
          placeholder="0"
          value="${currentValues[acc.key] !== undefined ? currentValues[acc.key] : '0'}"
        />
      </div>
    `;

    if (pool === 'liquid') {
      liquidContainer.appendChild(row);
    } else {
      savingsContainer.appendChild(row);
    }
  });

  attachAutoSelectAndLivePreview();
}

function attachAutoSelectAndLivePreview() {
  // iPhone Safari 點擊金額輸入框自動全選，並即時千分位或試算
  document.querySelectorAll('.auto-select').forEach((input) => {
    input.onfocus = () => {
      setTimeout(() => {
        try {
          input.select();
          input.setSelectionRange(0, input.value.length);
        } catch (_) {}
      }, 20);
    };
    input.oninput = () => {
      updateLiveRecordPreview();
    };
    input.onblur = () => {
      const val = parseMoney(input.value);
      input.value = formatNumberPlain(val);
      updateLiveRecordPreview();
    };
  });
}

// ==================== 即時試算預覽（分頁 2） ====================
function getFormAmounts() {
  const amounts = {};
  ASSET_ACCOUNTS.forEach((acc) => {
    const el = document.getElementById(`input_${acc.key}`);
    amounts[acc.key] = el ? parseMoney(el.value) : 0;
  });
  const unpaidCard = parseMoney(document.getElementById('inputUnpaidCard').value);
  const income = parseMoney(document.getElementById('inputIncome').value);
  const date = document.getElementById('inputDate').value || getTodayISO();
  const note = document.getElementById('inputNote').value.trim();

  return { ...amounts, unpaidCard, income, date, note };
}

/**
 * 找出本次輸入日期對應的「上一筆盤點紀錄」
 * 若無更早的紀錄，代表此筆為 W0 初始基準日
 */
function findPredecessorRecord(targetDate, editingId) {
  const otherRecords = state.records.filter((r) => r.id !== editingId);
  const earlierOrEqual = otherRecords.filter((r) => String(r.date) <= String(targetDate));
  if (earlierOrEqual.length === 0) return null;
  return earlierOrEqual[earlierOrEqual.length - 1];
}

function updateLiveRecordPreview() {
  const formVals = getFormAmounts();

  let liquidSubtotal = 0;
  let savingsSubtotal = 0;
  ASSET_ACCOUNTS.forEach((acc) => {
    const pool = state.poolConfig[acc.key] || acc.defaultPool;
    if (pool === 'liquid') {
      liquidSubtotal += formVals[acc.key];
    } else {
      savingsSubtotal += formVals[acc.key];
    }
  });

  const totalAssets = liquidSubtotal + savingsSubtotal;
  const netBalance = totalAssets - formVals.unpaidCard;

  document.getElementById('liveLiquidSubtotal').textContent = `小計 $${formatMoney(liquidSubtotal)}`;
  document.getElementById('liveSavingsSubtotal').textContent = `小計 $${formatMoney(savingsSubtotal)}`;
  document.getElementById('previewTotalAssets').textContent = `5項資產總額 $${formatMoney(totalAssets)}`;
  document.getElementById('previewNetBalance').textContent = `$${formatMoney(netBalance)}`;

  const prevRecord = findPredecessorRecord(formVals.date, state.editingId);
  const weekBadge = document.getElementById('recordWeekBadge');
  const incomeInput = document.getElementById('inputIncome');
  const incomeHelper = document.getElementById('incomeHelperText');
  const previewSpendEl = document.getElementById('previewActualSpend');
  const formulaHintEl = document.getElementById('previewFormulaHint');
  const prevHintEl = document.getElementById('prevRecordHint');

  if (!prevRecord) {
    // W0 初始基準日例外規則
    weekBadge.textContent = 'W0 初始基準日';
    incomeInput.value = '-';
    incomeInput.disabled = true;
    incomeHelper.textContent = '首筆基準日 (W0) 僅建立初始淨額，不計算當週收入與花費';
    previewSpendEl.textContent = '-';
    formulaHintEl.innerHTML =
      '🌱 <strong>首筆資料 (W0 初始基準日)：</strong>系統將以此筆真實淨可用餘額作為起點基準，下一週 (W1) 起開始自動反推每週實際總花費。';
    prevHintEl.textContent = '首筆盤點：建立初始資產基準';
  } else {
    const otherCountBefore = state.records.filter(
      (r) => r.id !== state.editingId && String(r.date) <= String(formVals.date)
    ).length;
    weekBadge.textContent = `W${otherCountBefore} 週次盤點`;
    if (incomeInput.disabled) {
      incomeInput.disabled = false;
      incomeInput.value = '0';
    }
    const currentIncome = parseMoney(incomeInput.value);
    const actualSpend = prevRecord.netBalance + currentIncome - netBalance;

    incomeHelper.textContent = '薪資、獎金等外部流入（內部轉帳不計，無則填 0）';
    previewSpendEl.textContent = `$${formatMoney(actualSpend)}`;
    prevHintEl.textContent = `上期 (${prevRecord.date}) 淨額：$${formatMoney(prevRecord.netBalance)}`;

    let spendNotice = '';
    if (actualSpend < 0) {
      spendNotice = `<br/><span style="color: var(--accent-debt);">⚠️ 推算花費為負數 ($${formatMoney(actualSpend)})，請確認是否漏填「本週總收入」或少計上期資產。</span>`;
    }

    formulaHintEl.innerHTML =
      `公式：上期淨額 <strong>$${formatMoney(prevRecord.netBalance)}</strong> ＋ 本週收入 <strong>$${formatMoney(currentIncome)}</strong> － 本次淨額 <strong>$${formatMoney(netBalance)}</strong> ＝ 本週花費 <strong>$${formatMoney(actualSpend)}</strong>` +
      spendNotice;
  }
}

// ==================== 儲存、編輯、刪除紀錄 ====================
function resetRecordForm() {
  state.editingId = null;
  document.getElementById('recordFormModeTitle').textContent = '新增每週盤點';
  document.getElementById('submitRecordBtn').textContent = '儲存本週盤點';
  document.getElementById('cancelEditBtn').style.display = 'none';
  document.getElementById('inputDate').value = getTodayISO();

  ASSET_ACCOUNTS.forEach((acc) => {
    const el = document.getElementById(`input_${acc.key}`);
    if (el) el.value = '0';
  });
  document.getElementById('inputUnpaidCard').value = '0';
  document.getElementById('inputIncome').disabled = false;
  document.getElementById('inputIncome').value = '0';
  document.getElementById('inputNote').value = '';

  updateLiveRecordPreview();
}

function copyPreviousWeekBalances() {
  if (state.records.length === 0) {
    showToast('目前尚無歷史紀錄可帶入');
    return;
  }
  const formDate = document.getElementById('inputDate').value || getTodayISO();
  const prev = findPredecessorRecord(formDate, state.editingId) || state.records[state.records.length - 1];

  ASSET_ACCOUNTS.forEach((acc) => {
    const el = document.getElementById(`input_${acc.key}`);
    if (el) el.value = formatNumberPlain(prev[acc.key]);
  });
  document.getElementById('inputUnpaidCard').value = formatNumberPlain(prev.unpaidCard);
  updateLiveRecordPreview();
  showToast(`已帶入 ${prev.date} (${prev.weekCode}) 帳戶餘額`);
}

function handleRecordSubmit(e) {
  e.preventDefault();
  const vals = getFormAmounts();

  if (!vals.date) {
    showToast('請選擇盤點日期');
    return;
  }

  if (state.editingId) {
    const idx = state.records.findIndex((r) => r.id === state.editingId);
    if (idx >= 0) {
      state.records[idx] = {
        ...state.records[idx],
        ...vals
      };
    }
    showToast('已更新盤點紀錄並自動重算後續週次');
  } else {
    // 檢查同一天是否已有紀錄，若有則詢問覆蓋或更新
    const sameDateIdx = state.records.findIndex((r) => r.date === vals.date);
    if (sameDateIdx >= 0) {
      state.records[sameDateIdx] = {
        ...state.records[sameDateIdx],
        ...vals
      };
      showToast(`已更新 ${vals.date} 當日盤點紀錄`);
    } else {
      state.records.push({
        id: `rec-${vals.date}-${Date.now()}`,
        ...vals,
        createdAt: Date.now()
      });
      showToast('已儲存本週盤點！');
    }
  }

  saveStateToStorage({ markDirty: true });
  resetRecordForm();
  renderAll();
  switchTab('tab-dashboard');

  // Offline-First：優先存入 localStorage 後，立即在背景非同步推送至 Google 試算表
  if (state.cloudConfig.gasUrl) {
    syncToCloud({ silent: true });
  }
}

function startEditRecord(recordId) {
  const rec = state.records.find((r) => r.id === recordId);
  if (!rec) return;

  state.editingId = rec.id;
  document.getElementById('recordFormModeTitle').textContent = `編輯盤點 (${rec.weekCode})`;
  document.getElementById('submitRecordBtn').textContent = '更新盤點紀錄';
  document.getElementById('cancelEditBtn').style.display = 'inline-flex';
  document.getElementById('inputDate').value = rec.date;

  ASSET_ACCOUNTS.forEach((acc) => {
    const el = document.getElementById(`input_${acc.key}`);
    if (el) el.value = formatNumberPlain(rec[acc.key]);
  });

  document.getElementById('inputUnpaidCard').value = formatNumberPlain(rec.unpaidCard);
  document.getElementById('inputIncome').disabled = false;
  document.getElementById('inputIncome').value = rec.isW0 ? '-' : formatNumberPlain(rec.income);
  document.getElementById('inputNote').value = rec.note || '';

  updateLiveRecordPreview();
  switchTab('tab-record');
}

function deleteRecord(recordId) {
  const rec = state.records.find((r) => r.id === recordId);
  if (!rec) return;

  if (!window.confirm(`確定要刪除 ${rec.date} (${rec.weekCode}) 的盤點紀錄嗎？\n刪除後系統會自動重新計算後續週次的花費。`)) {
    return;
  }

  state.records = state.records.filter((r) => r.id !== recordId);
  saveStateToStorage({ markDirty: true });
  if (state.editingId === recordId) {
    resetRecordForm();
  }
  renderAll();
  showToast('已刪除紀錄並重算各週花費');

  if (state.cloudConfig.gasUrl) {
    syncToCloud({ silent: true });
  }
}

// ==================== 畫面渲染（Dashboard / History / Settings） ====================
function renderAll() {
  state.records = recalculateRecords(state.records, state.poolConfig);
  renderDashboard();
  renderHistoryList();
  updateLiveRecordPreview();
}

function renderDashboard() {
  const records = state.records;
  const latest = records.length > 0 ? records[records.length - 1] : null;
  const prev = records.length > 1 ? records[records.length - 2] : null;

  const liquidNames = ASSET_ACCOUNTS
    .filter((a) => (state.poolConfig[a.key] || a.defaultPool) === 'liquid')
    .map((a) => a.name)
    .join(' · ');
  const savingsNames = ASSET_ACCOUNTS
    .filter((a) => (state.poolConfig[a.key] || a.defaultPool) === 'savings')
    .map((a) => a.name)
    .join(' · ');

  document.getElementById('dashLiquidAccounts').textContent = liquidNames || '無項目';
  document.getElementById('dashSavingsAccounts').textContent = savingsNames || '無項目';

  if (!latest) {
    document.getElementById('dashLatestDateBadge').textContent = '尚無紀錄';
    document.getElementById('dashNetBalance').textContent = '$0';
    document.getElementById('dashWeeklySpend').textContent = '-';
    document.getElementById('dashSpendDelta').innerHTML =
      '<span class="hero-stat-label">請至「每週盤點」建立 W0 初始基準</span>';
    document.getElementById('dashTotalAssets').textContent = '$0';
    document.getElementById('dashIncomeNote').textContent = '本週收入 -';
    document.getElementById('dashPoolRatioText').textContent = '流動 0% · 儲蓄 0%';
    document.getElementById('barLiquid').style.width = '50%';
    document.getElementById('barSavings').style.width = '50%';
    document.getElementById('dashLiquidPct').textContent = '0%';
    document.getElementById('dashSavingsPct').textContent = '0%';
    document.getElementById('dashLiquidAmount').textContent = '$0';
    document.getElementById('dashSavingsAmount').textContent = '$0';
    document.getElementById('dashUnpaidCard').textContent = '-$0';
    renderTrendChart([]);
    return;
  }

  document.getElementById('dashLatestDateBadge').textContent = `${latest.weekCode} · ${latest.date}`;
  document.getElementById('dashNetBalance').textContent = `$${formatMoney(latest.netBalance)}`;
  document.getElementById('dashTotalAssets').textContent = `$${formatMoney(latest.totalAssets)}`;
  document.getElementById('dashIncomeNote').textContent = latest.isW0
    ? 'W0 初始基準日（不計收入）'
    : `本週收入 $${formatMoney(latest.income)}${latest.note ? ' · ' + latest.note : ''}`;

  if (latest.isW0 || latest.actualSpend === null) {
    document.getElementById('dashWeeklySpend').textContent = '-';
    document.getElementById('dashSpendDelta').innerHTML =
      '<span class="badge">W0 初始基準建立完成</span>';
  } else {
    document.getElementById('dashWeeklySpend').textContent = `$${formatMoney(latest.actualSpend)}`;
    if (prev && !prev.isW0 && prev.actualSpend !== null) {
      const diff = latest.actualSpend - prev.actualSpend;
      if (diff > 0) {
        document.getElementById('dashSpendDelta').innerHTML =
          `<span class="delta-tag delta-up num">較上週 +$${formatMoney(diff)} ▲</span>`;
      } else if (diff < 0) {
        document.getElementById('dashSpendDelta').innerHTML =
          `<span class="delta-tag delta-down num">較上週 -$${formatMoney(Math.abs(diff))} ▼</span>`;
      } else {
        document.getElementById('dashSpendDelta').innerHTML =
          `<span class="badge">與上週花費持平</span>`;
      }
    } else {
      document.getElementById('dashSpendDelta').innerHTML =
        '<span class="badge">首週實際花費統計</span>';
    }
  }

  // 雙池比例計算
  const total = Math.max(0, latest.totalAssets);
  const liquidPct = total > 0 ? Math.round((latest.liquidSubtotal / total) * 100) : 0;
  const savingsPct = total > 0 ? 100 - liquidPct : 0;

  document.getElementById('dashPoolRatioText').textContent = `流動 ${liquidPct}% · 儲蓄 ${savingsPct}%`;
  document.getElementById('barLiquid').style.width = `${total > 0 ? liquidPct : 50}%`;
  document.getElementById('barSavings').style.width = `${total > 0 ? savingsPct : 50}%`;
  document.getElementById('dashLiquidPct').textContent = `${liquidPct}%`;
  document.getElementById('dashSavingsPct').textContent = `${savingsPct}%`;
  document.getElementById('dashLiquidAmount').textContent = `$${formatMoney(latest.liquidSubtotal)}`;
  document.getElementById('dashSavingsAmount').textContent = `$${formatMoney(latest.savingsSubtotal)}`;
  document.getElementById('dashUnpaidCard').textContent = `-$${formatMoney(latest.unpaidCard)}`;

  renderTrendChart(records.slice(-8));
}

function renderTrendChart(recentRecords) {
  const barsContainer = document.getElementById('trendChartBars');
  const detailBox = document.getElementById('trendChartDetail');
  const avgBadge = document.getElementById('dashAvgSpendBadge');

  barsContainer.innerHTML = '';

  if (recentRecords.length === 0) {
    avgBadge.textContent = '週均 $-';
    detailBox.innerHTML = '<span>尚無盤點資料，新增盤點後將自動繪製近 8 週趨勢圖</span>';
    return;
  }

  const spendRecords = recentRecords.filter((r) => !r.isW0 && r.actualSpend !== null && r.actualSpend >= 0);
  if (spendRecords.length > 0) {
    const avg = Math.round(spendRecords.reduce((acc, r) => acc + r.actualSpend, 0) / spendRecords.length);
    avgBadge.textContent = `近${spendRecords.length}週均 $${formatMoney(avg)}`;
  } else {
    avgBadge.textContent = '週均 $-';
  }

  const maxSpend = Math.max(
    1,
    ...recentRecords.map((r) => (r.isW0 || r.actualSpend === null ? 0 : Math.max(0, r.actualSpend)))
  );

  if (state.selectedChartIndex === null || state.selectedChartIndex >= recentRecords.length) {
    state.selectedChartIndex = recentRecords.length - 1;
  }

  recentRecords.forEach((rec, idx) => {
    const col = document.createElement('div');
    col.className = `chart-col ${idx === state.selectedChartIndex ? 'selected' : ''}`;

    const isW0 = rec.isW0 || rec.actualSpend === null;
    const heightPct = isW0 ? 12 : Math.max(10, Math.round((Math.max(0, rec.actualSpend) / maxSpend) * 100));
    const shortDate = rec.date.slice(5).replace('-', '/');
    const shortVal = isW0
      ? 'W0'
      : rec.actualSpend >= 10000
      ? `${(rec.actualSpend / 1000).toFixed(1)}k`
      : `$${rec.actualSpend}`;

    col.innerHTML = `
      <div class="chart-bar-val num">${shortVal}</div>
      <div class="chart-bar ${isW0 ? 'w0' : ''}" style="height: ${heightPct}%;"></div>
      <div class="chart-date num">${shortDate}</div>
    `;

    col.addEventListener('click', () => {
      state.selectedChartIndex = idx;
      renderTrendChart(recentRecords);
    });

    barsContainer.appendChild(col);
  });

  const sel = recentRecords[state.selectedChartIndex];
  if (sel) {
    const spendStr = sel.isW0 ? '-（W0 初始基準）' : `$${formatMoney(sel.actualSpend)}`;
    detailBox.innerHTML = `
      <div>
        <strong>${sel.weekCode} (${sel.date})</strong>
        <span style="color: var(--text-secondary); margin-left: 6px;">${sel.note || '無備註'}</span>
      </div>
      <div class="num">
        花費 <strong>${spendStr}</strong> · 淨額 $${formatMoney(sel.netBalance)}
      </div>
    `;
  }
}

function renderHistoryList() {
  const container = document.getElementById('historyListContainer');
  const countBadge = document.getElementById('historyCountBadge');
  countBadge.textContent = `共 ${state.records.length} 筆`;

  if (state.records.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 24px 12px; color: var(--text-muted); font-size: 14px;">
        目前尚無任何盤點紀錄。<br/>點擊下方「每週盤點」建立第一筆 W0 基準吧！
      </div>
    `;
    return;
  }

  // 由新到舊顯示
  const reversed = [...state.records].reverse();
  container.innerHTML = '';

  reversed.forEach((rec) => {
    const item = document.createElement('div');
    item.className = 'history-item';

    const spendDisplay = rec.isW0 ? 'W0 基準 (-)' : `花費 $${formatMoney(rec.actualSpend)}`;
    const incomeDisplay = rec.isW0 ? '-' : `$${formatMoney(rec.income)}`;

    item.innerHTML = `
      <div class="history-summary">
        <div>
          <div class="history-date-row">
            <span class="badge ${rec.isW0 ? '' : 'liquid'}">${rec.weekCode}</span>
            <span class="num">${rec.date}</span>
          </div>
          <div class="history-note-preview">${escapeHtml(rec.note || (rec.isW0 ? '建立初始淨餘額基準' : '例行每週盤點'))}</div>
        </div>
        <div class="history-right">
          <div class="history-spend num">${spendDisplay}</div>
          <div class="history-net num">真實淨額 $${formatMoney(rec.netBalance)}</div>
        </div>
      </div>
      <div class="history-details">
        <div class="snapshot-grid num">
          <div class="snapshot-row"><span>B 錢包現金</span><strong>$${formatMoney(rec.walletCash)}</strong></div>
          <div class="snapshot-row"><span>C 中信銀行</span><strong>$${formatMoney(rec.ctbcBank)}</strong></div>
          <div class="snapshot-row"><span>D 日常流動小計</span><strong>$${formatMoney(rec.liquidSubtotal)}</strong></div>
          <div class="snapshot-row"><span>E 袋袋現金</span><strong>$${formatMoney(rec.bagCash)}</strong></div>
          <div class="snapshot-row"><span>F 土地銀行</span><strong>$${formatMoney(rec.landBank)}</strong></div>
          <div class="snapshot-row"><span>G 台灣銀行</span><strong>$${formatMoney(rec.twBank)}</strong></div>
          <div class="snapshot-row"><span>H 儲蓄專款小計</span><strong>$${formatMoney(rec.savingsSubtotal)}</strong></div>
          <div class="snapshot-row"><span>I 5項資產總額</span><strong>$${formatMoney(rec.totalAssets)}</strong></div>
          <div class="snapshot-row"><span>J 未繳卡費</span><strong style="color: var(--accent-debt);">-$${formatMoney(rec.unpaidCard)}</strong></div>
          <div class="snapshot-row"><span>L 本週總收入</span><strong>${incomeDisplay}</strong></div>
        </div>
        <div class="history-actions">
          <button type="button" class="btn btn-secondary btn-sm edit-rec-btn" data-id="${rec.id}">編輯此週</button>
          <button type="button" class="btn btn-danger btn-sm del-rec-btn" data-id="${rec.id}">刪除</button>
        </div>
      </div>
    `;

    item.querySelector('.history-summary').addEventListener('click', () => {
      item.classList.toggle('open');
    });

    item.querySelector('.edit-rec-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      startEditRecord(rec.id);
    });

    item.querySelector('.del-rec-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteRecord(rec.id);
    });

    container.appendChild(item);
  });
}

function renderPoolConfigSettings() {
  const container = document.getElementById('poolConfigContainer');
  container.innerHTML = '';

  ASSET_ACCOUNTS.forEach((acc) => {
    const currentPool = state.poolConfig[acc.key] || acc.defaultPool;
    const row = document.createElement('div');
    row.className = 'pool-toggle-row';
    row.innerHTML = `
      <span><strong>${acc.name}</strong></span>
      <div class="pool-switch">
        <button type="button" class="${currentPool === 'liquid' ? 'active-liquid' : ''}" data-key="${acc.key}" data-pool="liquid">日常流動池</button>
        <button type="button" class="${currentPool === 'savings' ? 'active-savings' : ''}" data-key="${acc.key}" data-pool="savings">儲蓄專款池</button>
      </div>
    `;

    row.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-key');
        const pool = btn.getAttribute('data-pool');
        state.poolConfig[key] = pool;
        saveStateToStorage({ markDirty: true });
        renderPoolConfigSettings();
        renderPoolInputs();
        renderAll();
        showToast(`已將「${acc.name}」調整至${pool === 'liquid' ? '日常流動池' : '儲蓄專款池'}`);
      });
    });

    container.appendChild(row);
  });
}

// ==================== Google 試算表雲端同步 (Offline-First) ====================
function updateSyncPillUI() {
  const pill = document.getElementById('syncStatusPill');
  const text = document.getElementById('syncStatusText');
  const lastSyncEl = document.getElementById('cloudLastSyncText');

  if (!state.cloudConfig.gasUrl) {
    pill.setAttribute('data-state', 'offline');
    text.textContent = '離線暫存';
    lastSyncEl.textContent = '尚未設定網址';
    return;
  }

  if (!navigator.onLine) {
    pill.setAttribute('data-state', 'pending');
    text.textContent = state.syncMeta.dirty ? '離線待同步' : '離線模式';
    return;
  }

  if (state.syncMeta.status === 'syncing') {
    pill.setAttribute('data-state', 'syncing');
    text.textContent = '同步中...';
  } else if (state.syncMeta.dirty) {
    pill.setAttribute('data-state', 'pending');
    text.textContent = '待同步 ●';
  } else {
    pill.setAttribute('data-state', 'synced');
    text.textContent = '雲端已同步 ✓';
  }

  if (state.syncMeta.lastSyncAt) {
    const d = new Date(state.syncMeta.lastSyncAt);
    const timeStr = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    lastSyncEl.textContent = `上次同步 ${timeStr}`;
  } else {
    lastSyncEl.textContent = '已綁定雲端';
  }
}

async function callGasApi(payload) {
  const url = (state.cloudConfig.gasUrl || '').trim();
  const token = (state.cloudConfig.apiToken || '').trim();

  if (!url) {
    throw new Error('請先於設定頁輸入 Google Apps Script 網址');
  }

  // 使用 text/plain;charset=utf-8 避免 iOS Safari CORS preflight OPTIONS 失敗
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify({
      ...payload,
      token
    }),
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`HTTP 錯誤 (${response.status})`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(data.error || '雲端試算表回應錯誤');
  }
  return data;
}

async function testCloudConnection() {
  saveCloudConfigInputs();
  if (!state.cloudConfig.gasUrl) {
    showToast('請輸入 Google Apps Script 網頁應用程式網址');
    return;
  }

  try {
    state.syncMeta.status = 'syncing';
    updateSyncPillUI();
    const res = await callGasApi({ action: 'ping' });
    state.syncMeta.status = state.syncMeta.dirty ? 'pending' : 'synced';
    updateSyncPillUI();
    showToast(`連線成功！工作表「${res.sheetName}」目前共 ${res.rowCount} 筆資料`);
  } catch (err) {
    state.syncMeta.status = 'pending';
    updateSyncPillUI();
    showToast(`連線失敗：${err.message}`);
  }
}

async function syncToCloud({ silent = false } = {}) {
  saveCloudConfigInputs();
  if (!state.cloudConfig.gasUrl) {
    if (!silent) showToast('請先於「歷史與設定」分頁綁定 Google 試算表網址');
    return;
  }

  if (!navigator.onLine) {
    state.syncMeta.dirty = true;
    state.syncMeta.status = 'pending';
    updateSyncPillUI();
    if (!silent) showToast('目前無網路連線，已安全暫存於手機，恢復連線後將自動補傳');
    return;
  }

  try {
    state.syncMeta.status = 'syncing';
    updateSyncPillUI();

    state.records = recalculateRecords(state.records, state.poolConfig);
    await callGasApi({
      action: 'syncAll',
      records: state.records,
      poolConfig: state.poolConfig
    });

    state.syncMeta.dirty = false;
    state.syncMeta.status = 'synced';
    state.syncMeta.lastSyncAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEYS.SYNC_STATE, JSON.stringify(state.syncMeta));
    updateSyncPillUI();

    if (!silent) {
      showToast(`已同步 ${state.records.length} 筆盤點紀錄至 Google 試算表 ✓`);
    }
  } catch (err) {
    state.syncMeta.dirty = true;
    state.syncMeta.status = 'pending';
    localStorage.setItem(STORAGE_KEYS.SYNC_STATE, JSON.stringify(state.syncMeta));
    updateSyncPillUI();
    if (!silent) {
      showToast(`同步失敗（資料已保存在本機）：${err.message}`);
    }
  }
}

async function pullFromCloud() {
  saveCloudConfigInputs();
  if (!state.cloudConfig.gasUrl) {
    showToast('請先輸入 Google Apps Script 網址與 Token');
    return;
  }

  if (
    state.records.length > 0 &&
    !window.confirm('從雲端試算表載入將會以試算表上的歷史資料覆蓋目前手機上的紀錄，確定要載入還原嗎？')
  ) {
    return;
  }

  try {
    state.syncMeta.status = 'syncing';
    updateSyncPillUI();

    const res = await callGasApi({ action: 'getAll' });
    if (res.poolConfig) {
      state.poolConfig = { ...DEFAULT_POOL_CONFIG, ...res.poolConfig };
      renderPoolConfigSettings();
      renderPoolInputs();
    }

    state.records = recalculateRecords(res.records || [], state.poolConfig);
    state.syncMeta.dirty = false;
    state.syncMeta.status = 'synced';
    state.syncMeta.lastSyncAt = new Date().toISOString();

    saveStateToStorage({ markDirty: false });
    renderAll();
    showToast(`成功從雲端試算表載入 ${state.records.length} 筆歷史紀錄！`);
  } catch (err) {
    state.syncMeta.status = 'pending';
    updateSyncPillUI();
    showToast(`載入失敗：${err.message}`);
  }
}

function saveCloudConfigInputs() {
  state.cloudConfig.gasUrl = document.getElementById('inputGasUrl').value.trim();
  state.cloudConfig.apiToken = document.getElementById('inputApiToken').value.trim();
  localStorage.setItem(STORAGE_KEYS.CLOUD_CONFIG, JSON.stringify(state.cloudConfig));
  updateSyncPillUI();
}

// ==================== CSV 匯出備份（對應試算表 A～N 欄） ====================
function exportToCsv() {
  if (state.records.length === 0) {
    showToast('目前尚無紀錄可匯出');
    return;
  }

  const headers = [
    '盤點日期',
    '錢包現金',
    '中信銀行',
    '日常流動小計',
    '袋袋現金',
    '土地銀行',
    '台灣銀行',
    '儲蓄專款小計',
    '5項目資產總額',
    '未繳卡費',
    '真實淨可用餘額',
    '本週總收入',
    '本週實際總花費',
    '備註'
  ];

  const rows = state.records.map((r) => [
    r.date,
    r.walletCash,
    r.ctbcBank,
    r.liquidSubtotal,
    r.bagCash,
    r.landBank,
    r.twBank,
    r.savingsSubtotal,
    r.totalAssets,
    r.unpaidCard,
    r.netBalance,
    r.isW0 ? '-' : r.income,
    r.isW0 ? '-' : r.actualSpend,
    `"${(r.note || '').replace(/"/g, '""')}"`
  ]);

  const csvContent =
    '\uFEFF' + [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `融融記帳表_${getTodayISO()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast('已匯出 A～N 欄完整 CSV 檔案');
}

// ==================== 事件綁定 ====================
function bindEvents() {
  document.getElementById('recordForm').addEventListener('submit', handleRecordSubmit);
  document.getElementById('copyPrevWeekBtn').addEventListener('click', copyPreviousWeekBalances);
  document.getElementById('cancelEditBtn').addEventListener('click', () => {
    resetRecordForm();
    showToast('已取消編輯');
  });

  document.getElementById('inputDate').addEventListener('change', updateLiveRecordPreview);

  document.getElementById('resetPoolConfigBtn').addEventListener('click', () => {
    state.poolConfig = { ...DEFAULT_POOL_CONFIG };
    saveStateToStorage({ markDirty: true });
    renderPoolConfigSettings();
    renderPoolInputs();
    renderAll();
    showToast('已恢復預設雙池分類');
  });

  document.getElementById('saveCloudConfigBtn').addEventListener('click', testCloudConnection);
  document.getElementById('manualPushSyncBtn').addEventListener('click', () => syncToCloud({ silent: false }));
  document.getElementById('pullFromCloudBtn').addEventListener('click', pullFromCloud);
  document.getElementById('exportCsvBtn').addEventListener('click', exportToCsv);

  document.getElementById('syncStatusPill').addEventListener('click', () => {
    if (!state.cloudConfig.gasUrl) {
      switchTab('tab-history');
      showToast('請設定 Google 試算表網址以啟用雲端同步');
    } else {
      syncToCloud({ silent: false });
    }
  });

  // 網路恢復時自動補傳待同步資料
  window.addEventListener('online', () => {
    updateSyncPillUI();
    if (state.syncMeta.dirty && state.cloudConfig.gasUrl) {
      syncToCloud({ silent: false });
    }
  });

  window.addEventListener('offline', () => {
    updateSyncPillUI();
  });
}

// ==================== 工具函式 ====================
function parseMoney(val) {
  if (val === '-' || val === null || val === undefined || val === '') return 0;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? Math.round(num) : 0;
}

function formatMoney(num) {
  if (num === null || num === undefined || num === '-') return '-';
  return Number(num).toLocaleString('zh-TW');
}

function formatNumberPlain(num) {
  if (num === null || num === undefined || num === '-') return '0';
  return Number(num).toLocaleString('en-US');
}

function getTodayISO() {
  const now = new Date();
  const tzOffset = now.getTimezoneOffset() * 60000;
  return new Date(now.getTime() - tzOffset).toISOString().slice(0, 10);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2800);
}

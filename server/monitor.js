// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
const store = require('./store');

function plantOf(data, id) {
  return data.plants.find((p) => p.id === id) || null;
}
function outletOf(data, id) {
  return data.outlets.find((o) => o.id === id) || null;
}
function deviceOf(data, id) {
  return data.devices.find((d) => d.id === id) || null;
}

function readingsOf(data, query) {
  const q = query || {};
  let rows = data.readings.slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 口径：单日有效小时不足该数，该日不计入平均与总量
const MIN_VALID_HOURS_PER_DAY = 18;
// 浓度类指标：按设置里的量程（默认 0 到 500）判定；流量、氧含量按物理合理性判定
const CONCENTRATION_METRICS = ['COD', '氨氮'];
// 氧含量的物理合理上限（体积分数 %）
const OXYGEN_PHYSICAL_MAX = 25;

// 判定一条小时值是否计入统计，并给出不计入原因（口径第 1、8 条）
// 返回 { counted, reasons }：reasons 为空数组表示计入
function countVerdict(data, reading) {
  const settings = data.settings;
  const reasons = [];
  const device = deviceOf(data, reading.deviceId);
  const value = Number(reading.value);
  if (reading.flag !== '有效') reasons.push('数据标记为「' + (reading.flag || '空') + '」');
  if (!device) reasons.push('监测设备不存在');
  else if (device.status !== '正常') reasons.push('设备处于「' + device.status + '」状态');
  if (!Number.isFinite(value)) {
    reasons.push('数值不是有效数字');
  } else {
    if (value < 0) reasons.push('数值为负（' + value + '），低于检出下限，不合物理');
    if (CONCENTRATION_METRICS.indexOf(reading.metric) >= 0) {
      const rangeMax = Number(settings.rangeMax);
      const rangeMin = Number(settings.rangeMin);
      if (value > rangeMax) reasons.push('超出量程上限（' + value + ' > ' + rangeMax + '）');
      if (value >= 0 && value < rangeMin) reasons.push('低于量程下限（' + value + ' < ' + rangeMin + '）');
    } else if (reading.metric === '氧含量') {
      if (value > OXYGEN_PHYSICAL_MAX) reasons.push('氧含量超出物理合理范围（0 到 ' + OXYGEN_PHYSICAL_MAX + '）');
    }
    // 流量：为负已在上面判定；设置里的量程是污染物浓度量程，不适用于流量
  }
  if (isStopped(data, reading)) reasons.push('单位停产或排放口停用时段，按口径不计入');
  return { counted: reasons.length === 0, reasons };
}

// 口径：只有有效小时值参与统计——标记为有效、设备状态正常、数值在量程与物理合理范围内
function isCounted(data, reading) {
  return countVerdict(data, reading).counted;
}

// 口径：折算浓度 = 实测浓度 × (21 − 基准氧) / (21 − 实测氧含量)；氧含量缺失按基准氧处理
function effectiveConcentration(reading, settings) {
  return Number(reading.value);
}

// 小时值里的氧含量（同排放口同时刻的氧含量读数）
function oxygenAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '氧含量' && r.at === reading.at);
  return row ? Number(row.value) : null;
}

function flowAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '流量' && r.at === reading.at);
  return row ? Number(row.value) : 0;
}

// 口径第 8 条：单位停产或排放口停用时段的小时值不计入（但保留可查）
function isStopped(data, reading) {
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  return !!(outlet && plant && (outlet.status === '停用' || plant.status === '停产'));
}

// 参与核算的流量：同一时刻的流量读数本身也要是计入的，否则按 0 处理
function countedFlowAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '流量' && r.at === reading.at);
  if (!row) return 0;
  return isCounted(data, row) ? Number(row.value) : 0;
}

// 一天里该排放口某指标的逐小时明细
function dayRows(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = readingsOf(data, { outletId, metric, day });
  return rows.map((row) => {
    const device = deviceOf(data, row.deviceId);
    const verdict = countVerdict(data, row);
    return {
      id: row.id,
      at: row.at,
      hour: Number(String(row.at).slice(11, 13)),
      value: Number(row.value),
      source: row.source,
      flag: row.flag,
      deviceCode: device ? device.code : '',
      deviceStatus: device ? device.status : '',
      oxygen: oxygenAt(data, row),
      flow: countedFlowAt(data, row),
      counted: verdict.counted,
      reasons: verdict.reasons,
      concentration: verdict.counted ? effectiveConcentration(row, settings) : 0,
    };
  });
}

// 日均：有效小时不足 18 小时或补录超过单日上限的，该日不计入平均与总量，并写明原因
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = dayRows(data, outletId, metric, day);
  const counted = rows.filter((r) => r.counted);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const countedHours = counted.length;
  const imputedHours = counted.filter((r) => r.source === '补录').length;
  const maxImpute = Number(settings.maxImputeHoursPerDay);
  const invalidReasons = [];
  if (countedHours < MIN_VALID_HOURS_PER_DAY) {
    invalidReasons.push('有效小时不足 ' + MIN_VALID_HOURS_PER_DAY + ' 小时（实际 ' + countedHours + ' 小时）');
  }
  if (imputedHours > maxImpute) {
    invalidReasons.push('补录小时超过单日上限（' + imputedHours + ' > ' + maxImpute + ' 小时）');
  }
  const valid = invalidReasons.length === 0;
  const sum = counted.reduce((acc, r) => acc + r.concentration, 0);
  const average = countedHours ? store.round(sum / countedHours, 2) : 0;
  const flowTotal = counted.reduce((acc, r) => acc + r.flow, 0);
  return {
    day,
    outletId,
    metric,
    rows,
    countedHours,
    imputedHours,
    average,
    valid,
    invalidReason: invalidReasons.join('；') || null,
    limit,
    exceed: valid && average > limit,
    flowTotal: store.round(flowTotal, 1),
  };
}

function dailySeries(data, outletId, metric, month) {
  const days = store.daysInMonth(month);
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    if (!readingsOf(data, { outletId, metric, day }).length) continue;
    out.push(dailyStats(data, outletId, metric, day));
  }
  return out;
}

// 月均值：按有效天数平均（分母是计入的日数，不计入的日不参与）
function monthAverage(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  if (!series.length) return 0;
  const sum = series.reduce((acc, s) => acc + s.average, 0);
  return store.round(sum / series.length, 2);
}

// 月总量（吨）：不计入的日整体剔除；计入日内逐小时按同一时刻的浓度与流量配对累加
// 每小时排放量(吨) = 折算浓度(mg/L) × 流量(m³/h) × 1000(升每立方米) / 1e9
function monthTotal(data, outletId, metric, month) {
  const settings = data.settings;
  let mg = 0;
  const series = dailySeries(data, outletId, metric, month);
  for (const stats of series) {
    if (!stats.valid) continue;
    for (const row of stats.rows) {
      if (!row.counted) continue;
      mg += row.concentration * row.flow * 1000;
    }
  }
  return store.round(mg / Number(settings.tonsDivisor), 4);
}

// 季度总量：按当季日均乘以季节天数
function quarterTotal(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const months = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3].map((m) => y + '-' + String(m).padStart(2, '0'));
  const totals = months.filter((m) => dailySeries(data, outletId, metric, m).length).map((m) => monthTotal(data, outletId, metric, m));
  if (!totals.length) return 0;
  const average = totals.reduce((a, b) => a + b, 0) / totals.length;
  return store.round((average / store.daysInMonth(months[0])) * 90, 4);
}

// 季度许可量：年度许可按季度平均分解
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  return store.round(annual / 4, 4);
}

// 年累计：把库里的全部数据加起来
function accumulatedTons(data, metric) {
  const outlets = data.outlets.map((o) => o.id);
  let total = 0;
  for (const outletId of outlets) {
    const months = Array.from(new Set(data.readings.filter((r) => r.outletId === outletId && r.metric === metric).map((r) => store.monthOf(r.at))));
    for (const month of months) total += monthTotal(data, outletId, metric, month);
  }
  return store.round(total, 4);
}

// 超标：日均超过限值，或者小时值超过限值达到规定次数
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const exceedDays = series.filter((s) => s.exceed).map((s) => s.day);
  let exceedHours = 0;
  for (const s of series) {
    for (const row of s.rows) if (row.counted && row.concentration > limit) exceedHours += 1;
  }
  const hourly = exceedHours >= Number(settings.hourlyExceedCountLimit);
  return {
    month,
    outletId,
    metric,
    limit,
    exceedDays,
    exceedDaysCount: exceedDays.length,
    exceedHours,
    hourlyExceed: hourly,
    exceeded: exceedDays.length > 0,
    monthAverage: monthAverage(data, outletId, metric, month),
  };
}

function outletsOf(data, plantId) {
  return data.outlets.filter((o) => o.plantId === plantId);
}

// 排放口汇总：逐指标给出月均、月总量、超标情况
function outletSummary(data, outletId, month) {
  const outlet = outletOf(data, outletId);
  const settings = data.settings;
  const metrics = ['COD', '氨氮'];
  const rows = metrics.map((metric) => {
    const ex = exceedance(data, outletId, metric, month);
    return {
      metric,
      monthAverage: ex.monthAverage,
      monthTotalTons: monthTotal(data, outletId, metric, month),
      exceedDaysCount: ex.exceedDaysCount,
      exceedHours: ex.exceedHours,
      exceeded: ex.exceeded,
      limit: ex.limit,
    };
  });
  const devices = data.devices.filter((d) => d.outletId === outletId).map((d) => Object.assign({}, d, {
    readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
  }));
  return {
    outlet,
    plant: outlet ? plantOf(data, outlet.plantId) : null,
    month,
    rows,
    devices,
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: Number(settings.annualPermitCodTons),
    accumulatedCodTons: accumulatedTons(data, 'COD'),
    accumulatedAmmoniaTons: accumulatedTons(data, '氨氮'),
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, countVerdict, isCounted, effectiveConcentration, oxygenAt, flowAt, countedFlowAt,
  dayRows, dailyStats, dailySeries, monthAverage, monthTotal, quarterTotal, quarterPermitTons, accumulatedTons,
  exceedance, outletsOf, outletSummary,
  MIN_VALID_HOURS_PER_DAY,
};

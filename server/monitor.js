// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
const store = require('./store');

// 量程（settings.rangeMin/rangeMax，默认 0–500）只约束浓度指标；流量、氧含量各按物理区间判
const CONCENTRATION_METRICS = ['COD', '氨氮'];
// 氧含量是体积百分比，物理上只可能落在 0–21
const OXYGEN_MIN = 0;
const OXYGEN_MAX = 21;

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
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function detectionLimit(settings, metric) {
  return metric === '氨氮' ? Number(settings.detectionLimitAmmonia) : Number(settings.detectionLimitCod);
}

// 口径 1/8/6：逐条读数判无效原因。返回原因数组（空数组 = 可计入）
// 覆盖：数据标记、设备状态（校准/维护/故障）、负值、超量程、低于检出下限、
//       非数值或明显不合物理、排放口停用、单位停产、许可年之外
function invalidReasons(data, reading) {
  const settings = data.settings;
  const reasons = [];
  const metric = reading.metric;
  const raw = reading.value;
  const v = Number(raw);
  const device = deviceOf(data, reading.deviceId);
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;

  if (reading.flag && reading.flag !== '有效') reasons.push({ code: 'flag_invalid', text: '数据标记为「无效」' });
  if (!device) {
    reasons.push({ code: 'device_missing', text: '监测设备不存在' });
  } else if (device.status === '校准') {
    reasons.push({ code: 'device_calibrating', text: '设备校准中，该时段读数无效' });
  } else if (device.status === '维护') {
    reasons.push({ code: 'device_maintenance', text: '设备维护中，该时段读数无效' });
  } else if (device.status === '故障') {
    reasons.push({ code: 'device_fault', text: '设备故障，该时段读数无效' });
  }
  if (outlet && outlet.status === '停用') reasons.push({ code: 'outlet_stopped', text: '排放口已停用，时段数据不计入' });
  if (plant && plant.status === '停产') reasons.push({ code: 'plant_suspended', text: '排污单位已停产，时段数据不计入' });
  if (plant && plant.permitYearStart && store.dayOf(reading.at) < String(plant.permitYearStart)) {
    reasons.push({ code: 'out_of_permit_year', text: '不在许可年（' + plant.permitYearStart + ' 起）内' });
  }

  if (raw === '' || raw === null || raw === undefined || !Number.isFinite(v)) {
    reasons.push({ code: 'not_a_number', text: '数值不是有效数字' });
    return reasons;
  }

  if (CONCENTRATION_METRICS.includes(metric)) {
    const min = Number(settings.rangeMin);
    const max = Number(settings.rangeMax);
    const dl = detectionLimit(settings, metric);
    if (v < 0) {
      reasons.push({ code: 'negative', text: '数值为负（' + v + '），不合物理' });
    } else if (Number.isFinite(min) && v < min) {
      reasons.push({ code: 'below_range_min', text: '低于量程下限（' + v + ' < ' + min + '）' });
    }
    if (Number.isFinite(max) && v > max) {
      reasons.push({ code: 'over_range', text: '超出量程上限（' + v + ' > ' + max + '）' });
    } else if (v >= 0 && Number.isFinite(dl) && v < dl) {
      reasons.push({ code: 'below_detection_limit', text: '低于检出下限（' + v + ' < ' + dl + ' mg/L）' });
    }
  } else if (metric === '流量') {
    if (v < 0) reasons.push({ code: 'negative', text: '流量为负（' + v + '），不合物理' });
  } else if (metric === '氧含量') {
    if (v < OXYGEN_MIN || v > OXYGEN_MAX) {
      reasons.push({ code: 'oxygen_physical', text: '氧含量超出物理区间 0–21（' + v + '）' });
    }
  }
  return reasons;
}

// 口径：只有有效小时值参与统计——标记有效、设备正常、数值在量程/检出限内、未停产停用、在许可年内
function isCounted(data, reading) {
  return invalidReasons(data, reading).length === 0;
}

// 单条读数的最终计入状态：物理/业务无效原因 + 同一时刻重复落选
function readingStatus(data, reading) {
  const reasons = invalidReasons(data, reading).map((x) => x.text);
  const canonical = canonicalAt(data, reading.outletId, reading.metric, reading.at);
  if (canonical && canonical.id !== reading.id) {
    reasons.push('同一时刻已有' + (canonical.source === '自动' ? '自动' : '有效') + '监测值（' + canonical.id + '），重复读数不计入');
  }
  return { counted: reasons.length === 0, reasons };
}

// 口径 2：折算浓度 = 实测浓度 × (21 − 基准氧) / (21 − 实测氧含量)；氧含量缺失按基准氧处理（等价不折算）
function effectiveConcentration(data, reading) {
  const settings = data.settings;
  const oxygen = oxygenAt(data, reading);
  const base = Number(settings.oxygenBaseline);
  const denom = oxygen === null ? 21 - base : 21 - oxygen;
  if (!Number.isFinite(denom) || denom === 0) return Number(reading.value);
  return Number(reading.value) * (21 - base) / denom;
}

// 小时值里的氧含量（同排放口同时刻的有效氧含量读数）
function oxygenAt(data, reading) {
  const row = canonicalAt(data, reading.outletId, '氧含量', reading.at);
  if (!row || !isCounted(data, row)) return null;
  return Number(row.value);
}

function flowAt(data, reading) {
  const row = canonicalAt(data, reading.outletId, '流量', reading.at);
  if (!row || !isCounted(data, row)) return 0;
  return Number(row.value);
}

// 同一排放口、指标、时刻可能有多条读数（自动值与补录值并存、正常值与异常值并存）。
// 只取一条代表该小时：本身有效的优先，其次「自动」优先，再按录入次序（id）；
// 物理有效行不存在时才退而取无效行（它仍会带着无效原因被排除）。
function pickCanonical(data, a, b) {
  if (!a) return b;
  if (!b) return a;
  const av = isCounted(data, a);
  const bv = isCounted(data, b);
  if (av !== bv) return av ? a : b;
  const aa = a.source === '自动';
  const bb = b.source === '自动';
  if (aa !== bb) return aa ? a : b;
  return a.id < b.id ? a : b;
}

function canonicalAt(data, outletId, metric, at) {
  const same = readingsOf(data, { outletId, metric }).filter((r) => r.at === at);
  if (!same.length) return null;
  return same.reduce((best, r) => pickCanonical(data, best, r), null);
}

// 逐小时行：附判定结果与原因（含同一时刻重复落选）
function hourRows(data, outletId, metric, filter) {
  const rows = readingsOf(data, Object.assign({ outletId, metric }, filter || {}));
  return rows.map((row) => {
    const status = readingStatus(data, row);
    return { row, reasons: status.reasons, counted: status.counted };
  });
}

// 一天里该排放口某指标的逐小时明细
function dayRows(data, outletId, metric, day) {
  return hourRows(data, outletId, metric, { day }).map((h) => toHourView(data, h));
}

function toHourView(data, { row, reasons, counted }) {
  const device = deviceOf(data, row.deviceId);
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
    flow: flowAt(data, row),
    counted,
    invalidReasons: reasons,
    concentration: counted ? store.round(effectiveConcentration(data, row), 4) : null,
  };
}

// 口径 3：日均按小时流量加权；有效小时不足 18、补录超过上限或当日无有效流量的，该日不计入
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const minHours = Number(settings.minDailyHours);
  const maxImpute = Number(settings.maxImputeHoursPerDay);
  const hours = hourRows(data, outletId, metric, { day });
  const rows = hours.map((h) => toHourView(data, h));
  const counted = hours.filter((h) => h.counted);
  const imputedHours = counted.filter((h) => h.row.source === '补录').length;
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const flowSum = counted.reduce((acc, h) => acc + flowAt(data, h.row), 0);
  const flowTotal = store.round(flowSum, 1);
  const dayReasons = [];
  if (!counted.length) dayReasons.push('当日没有有效小时值');
  if (counted.length && counted.length < minHours) dayReasons.push('有效小时不足（' + counted.length + ' < ' + minHours + '），该日不参与平均与总量');
  if (imputedHours > maxImpute) dayReasons.push('补录小时超过上限（' + imputedHours + ' > ' + maxImpute + '），该日按无效处理');
  if (counted.length >= minHours && imputedHours <= maxImpute && flowSum <= 0) dayReasons.push('当日没有可配对的有效流量，无法按流量加权计算日均');

  const valid = dayReasons.length === 0;
  let average = null;
  if (valid) {
    const weighted = counted.reduce((acc, h) => acc + effectiveConcentration(data, h.row) * flowAt(data, h.row), 0);
    average = store.round(weighted / flowSum, 2);
  }
  return {
    day,
    outletId,
    metric,
    rows,
    countedHours: counted.length,
    imputedHours,
    average,
    valid,
    invalidReasons: dayReasons,
    limit,
    exceed: valid && average > limit,
    flowTotal,
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

function validDailyStats(data, outletId, metric, month) {
  return dailySeries(data, outletId, metric, month).filter((s) => s.valid);
}

// 口径 5：月平均按有数据且有效的天数平均（分母是有效天数）
function monthAverage(data, outletId, metric, month) {
  const series = validDailyStats(data, outletId, metric, month);
  if (!series.length) return null;
  const sum = series.reduce((acc, s) => acc + s.average, 0);
  return store.round(sum / series.length, 2);
}

// 口径 3/5：月总量（吨）逐小时按时刻配对浓度与流量累加；无效日的小时一律不算
// 每小时排放量(吨) = 折算浓度(mg/L) × 流量(m³/h) × 1000 / 1e9
function monthTotal(data, outletId, metric, month) {
  const settings = data.settings;
  const validDays = new Set(validDailyStats(data, outletId, metric, month).map((s) => s.day));
  const conc = hourRows(data, outletId, metric, { month})
    .filter((h) => h.counted && validDays.has(store.dayOf(h.row.at)));
  let mg = 0;
  for (const h of conc) {
    const flow = flowAt(data, h.row);
    mg += effectiveConcentration(data, h.row) * flow;
  }
  return store.round(mg * 1000 / Number(settings.tonsDivisor), 4);
}

// 口径 5：季度总量按季度内逐小时累加，不做按天外推
function quarterTotal(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const months = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3].map((m) => y + '-' + String(m).padStart(2, '0'));
  const total = months.reduce((acc, m) => acc + monthTotal(data, outletId, metric, m), 0);
  return store.round(total, 4);
}

// 口径 6：季度许可量 = 年许可量 × 该季度实际天数占全年天数的比例
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  const year = Number(String(quarter).slice(0, 4));
  const yearDays = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  return store.round(annual * store.daysInQuarter(quarter) / yearDays, 4);
}

// 口径 6：年累计按各单位许可年起始日累计，许可年之外的数据不带入
function accumulatedTons(data, metric) {
  let total = 0;
  for (const outlet of data.outlets) {
    const plant = plantOf(data, outlet.plantId);
    const start = plant && plant.permitYearStart ? String(plant.permitYearStart) : '';
    const months = Array.from(new Set(
      data.readings
        .filter((r) => r.outletId === outlet.id && r.metric === metric && (!start || store.dayOf(r.at) >= start))
        .map((r) => store.monthOf(r.at))
    ));
    for (const month of months) total += monthTotal(data, outlet.id, metric, month);
  }
  return store.round(total, 4);
}

// 口径 7：日均超限值，或有效小时值超限值达到规定次数
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const exceedDays = series.filter((s) => s.exceed).map((s) => s.day);
  let exceedHours = 0;
  for (const s of series.filter((x) => x.valid)) {
    for (const row of s.rows) {
      if (row.counted && row.concentration > limit) exceedHours += 1;
    }
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
    exceeded: exceedDays.length > 0 || hourly,
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
  readingsOf, invalidReasons, readingStatus, isCounted, effectiveConcentration, oxygenAt, flowAt,
  canonicalAt, hourRows,
  dayRows, dailyStats, dailySeries, monthAverage, monthTotal, quarterTotal, quarterPermitTons, accumulatedTons,
  exceedance, outletsOf, outletSummary,
  CONCENTRATION_METRICS,
};

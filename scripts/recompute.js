// 一次性重算脚本：对比「改前桩口径」与「改后口径（无效值/有效小时联动）」
// 运行：node scripts/recompute.js
const store = require('../server/store');
const mon = require('../server/monitor');

const data = store.load();
const settings = data.settings;

/* ---------- 改前逻辑（照改前 monitor.js 的桩原样复刻） ---------- */
function oldRows(outletId, metric, day) {
  return mon.readingsOf(data, { outletId, metric, day }).map((r) => ({
    at: r.at, value: Number(r.value), concentration: Number(r.value), counted: true, source: r.source,
  }));
}
function oldFlowAt(outletId, at) {
  const row = data.readings.find((r) => r.outletId === outletId && r.metric === '流量' && r.at === at);
  return row ? Number(row.value) : 0;
}
function oldDaily(outletId, metric, day) {
  const rows = oldRows(outletId, metric, day);
  if (!rows.length) return null;
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const avg = store.round(rows.reduce((a, r) => a + r.concentration, 0) / rows.length, 2);
  return {
    countedHours: rows.length,
    imputedHours: rows.filter((r) => r.source === '补录').length,
    average: avg, valid: true, limit, exceed: avg > limit,
    flowTotal: store.round(rows.reduce((a, r) => a + oldFlowAt(outletId, r.at), 0), 1),
  };
}
function oldDailySeries(outletId, metric, month) {
  const out = [];
  const days = store.daysInMonth(month);
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    const s = oldDaily(outletId, metric, day);
    if (s) out.push(Object.assign({ day }, s));
  }
  return out;
}
function oldMonthAverage(outletId, metric, month) {
  const series = oldDailySeries(outletId, metric, month);
  if (!series.length) return 0;
  return store.round(series.reduce((a, s) => a + s.average, 0) / store.daysInMonth(month), 2);
}
function oldMonthTotal(outletId, metric, month) {
  const conc = mon.readingsOf(data, { outletId, metric, month });
  const flow = mon.readingsOf(data, { outletId, metric: '流量', month });
  let mg = 0;
  for (let i = 0; i < conc.length; i += 1) mg += Number(conc[i].value) * (flow[i] ? Number(flow[i].value) : 0);
  return store.round(mg / Number(settings.tonsDivisor), 4);
}
function oldQuarterTotal(outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const months = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3].map((m) => y + '-' + String(m).padStart(2, '0'));
  const totals = months.filter((m) => oldDailySeries(outletId, metric, m).length).map((m) => oldMonthTotal(outletId, metric, m));
  if (!totals.length) return 0;
  return store.round(totals.reduce((a, b) => a + b, 0) / totals.length / store.daysInMonth(months[0]) * 90, 4);
}
function oldAccumulated(metric) {
  let total = 0;
  for (const o of data.outlets) {
    const months = Array.from(new Set(data.readings.filter((r) => r.outletId === o.id && r.metric === metric).map((r) => store.monthOf(r.at))));
    for (const m of months) total += oldMonthTotal(o.id, metric, m);
  }
  return store.round(total, 4);
}

/* ---------- 输出 ---------- */
const line = (s) => { console.log(s); };
const outletName = (id) => { const o = mon.outletOf(data, id); return o ? o.code + ' ' + o.name : id; };
const months = Array.from(new Set(data.readings.map((r) => store.monthOf(r.at)))).sort();

line('================ 一、逐日受影响明细 ================');
for (const o of data.outlets) {
  for (const metric of ['COD', '氨氮']) {
    let printed = false;
    for (const month of months) {
      const afterMap = new Map(mon.dailySeries(data, o.id, metric, month).map((s) => [s.day, s]));
      const before = oldDailySeries(o.id, metric, month);
      for (const b of before) {
        const a = afterMap.get(b.day);
        if (!a) continue;
        const avgChanged = b.average !== a.average;
        const validityChanged = b.valid !== a.valid;
        if (avgChanged || validityChanged) {
          if (!printed) { line(''); line('■ ' + outletName(o.id) + ' / ' + metric); printed = true; }
          line('  ' + b.day +
            '  日均 ' + b.average + ' → ' + (a.average === null ? '不参与' : a.average) +
            '  有效小时 ' + b.countedHours + ' → ' + a.countedHours +
            '  补录 ' + b.imputedHours + ' → ' + a.imputedHours +
            '  ' + (b.valid === a.valid ? '' : '【该日由参与变为不参与】') +
            (a.invalidReasons.length ? ' 原因：' + a.invalidReasons.join('；') : ''));
        }
      }
    }
  }
}

line('');
line('================ 二、月均 / 月总量 / 季度 / 年累计 ================');
for (const o of data.outlets) {
  line('');
  line('■ ' + outletName(o.id));
  for (const metric of ['COD', '氨氮']) {
    for (const month of months) {
      const hasBefore = oldDailySeries(o.id, metric, month).length > 0;
      const hasAfter = mon.dailySeries(data, o.id, metric, month).length > 0;
      if (!hasBefore && !hasAfter) continue;
      const bAvg = oldMonthAverage(o.id, metric, month);
      const aAvg = mon.monthAverage(data, o.id, metric, month);
      const bTot = oldMonthTotal(o.id, metric, month);
      const aTot = mon.monthTotal(data, o.id, metric, month);
      line('  ' + month + ' ' + metric +
        '  月均 ' + bAvg + ' → ' + (aAvg === null ? '不参与' : aAvg) +
        '   月总量(吨) ' + bTot + ' → ' + aTot + '  （Δ ' + store.round(aTot - bTot, 4) + '）');
    }
    const bQ = oldQuarterTotal(o.id, metric, '2026-Q3');
    const aQ = mon.quarterTotal(data, o.id, metric, '2026-Q3');
    line('  2026-Q3 ' + metric + ' 季度总量(吨) ' + bQ + ' → ' + aQ + '  （Δ ' + store.round(aQ - bQ, 4) + '）');
  }
}
line('');
line('■ 年累计（全部排放口合计；改前含许可年外 2025-12 数据）');
line('  COD  ' + oldAccumulated('COD') + ' 吨 → ' + mon.accumulatedTons(data, 'COD') + ' 吨  （Δ ' + store.round(mon.accumulatedTons(data, 'COD') - oldAccumulated('COD'), 4) + '）');
line('  氨氮 ' + oldAccumulated('氨氮') + ' 吨 → ' + mon.accumulatedTons(data, '氨氮') + ' 吨  （Δ ' + store.round(mon.accumulatedTons(data, '氨氮') - oldAccumulated('氨氮'), 4) + '）');

line('');
line('================ 三、库里所有越界（超出量程 / 为负 / 不合物理）读数 ================');
const bounds = [];
for (const r of data.readings) {
  const reasons = mon.invalidReasons(data, r).filter((x) => ['over_range', 'negative', 'below_range_min', 'below_detection_limit', 'oxygen_physical', 'not_a_number'].includes(x.code));
  if (reasons.length) {
    const o = mon.outletOf(data, r.outletId);
    const d = mon.deviceOf(data, r.deviceId);
    bounds.push({ id: r.id, at: r.at, outlet: o ? o.code + ' ' + o.name : r.outletId, device: d ? d.code : r.deviceId, metric: r.metric, value: r.value, range: Number(settings.rangeMin) + '–' + Number(settings.rangeMax), reason: reasons.map((x) => x.text).join('；') });
  }
}
line('共 ' + bounds.length + ' 条：');
for (const b of bounds) line('  ' + b.id + '  ' + b.at + '  ' + b.outlet + '  ' + b.device + '  ' + b.metric + '  实测 ' + b.value + '（浓度量程 ' + b.range + '）  → ' + b.reason);

line('');
line('================ 四、其余被判无效读数分类（不属越界，但同样不计入） ================');
const groups = {};
for (const r of data.readings) {
  const st = mon.readingStatus(data, r);
  if (st.counted) continue;
  if (mon.invalidReasons(data, r).some((x) => ['over_range', 'negative'].includes(x.code))) continue;
  const code = st.reasons[0];
  (groups[code] = groups[code] || []).push(r.id);
}
for (const k of Object.keys(groups)) line('  [' + groups[k].length + ' 条] ' + k + '  例：' + groups[k].slice(0, 3).join('、') + (groups[k].length > 3 ? ' …' : ''));

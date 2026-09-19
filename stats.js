/* Статистика точности измерений (чистые функции, без DOM — проверяются тестами в tests/).
   Методика:
   - согласие двух методов: Bland & Altman (bias, 95% границы согласия) + допусковый интервал
     «95% разностей с уверенностью 95%» (для малых выборок приближённые интервалы Bland–Altman слишком
     оптимистичны, см. sources.json);
   - повторяемость: pooled within-subject SD (Sw), SEM = Sw, MDC95 = 1,96·√2·Sw (= коэффициент повторяемости 2,77·Sw);
   - надёжность: ICC(2,1) и ICC(3,1) с 95% ДИ по McGraw & Wong (1996); трактовка по Koo & Li (2016). */

export const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
export const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

/* ---------- специальные функции ---------- */
// Обратная функция нормального распределения (алгоритм Acklam, погрешность ~1e-9)
export function zInv(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425, ph = 1 - pl;
  if (p <= 0 || p >= 1) return NaN;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p <= ph) { const q = p - 0.5, r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function lgamma(x) { // Lanczos
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a, b, x) { // непрерывная дробь для неполной бета-функции (Numerical Recipes)
  const MAXIT = 300, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
export const fCdf = (f, d1, d2) => (f <= 0 ? 0 : ibeta(d1 * f / (d1 * f + d2), d1 / 2, d2 / 2));
export const tCdf = (t, df) => { const x = df / (df + t * t); const p = 0.5 * ibeta(x, df / 2, 0.5); return t > 0 ? 1 - p : p; };

function gammaP(a, x) { // регуляризованная неполная гамма P(a, x)
  if (x <= 0) return 0;
  if (x < a + 1) { // ряд
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 3e-15) break; }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d; // непрерывная дробь
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}
const chi2Cdf = (x, nu) => gammaP(nu / 2, x / 2);

function invertCdf(cdf, p, lo, hi) { // бисекция монотонной cdf
  while (cdf(hi) < p) { lo = hi; hi *= 2; if (hi > 1e12) break; }
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (cdf(mid) < p) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
export const fInv = (p, d1, d2) => invertCdf((f) => fCdf(f, d1, d2), p, 0, 10);
export const chi2Inv = (p, nu) => invertCdf((x) => chi2Cdf(x, nu), p, 0, Math.max(10, nu * 2));
export function tInv(p, df) { // p в (0,1)
  if (p === 0.5) return 0;
  const upper = p > 0.5;
  const pp = upper ? p : 1 - p;
  const v = invertCdf((t) => tCdf(t, df), pp, 0, 10);
  return upper ? v : -v;
}

/* ---------- допусковый множитель (Howe, 1969) ----------
   k такой, что интервал mean ± k·SD с уверенностью gamma накрывает долю p разностей. */
export function tolFactor(n, p = 0.95, gamma = 0.95) {
  if (n < 2) return NaN;
  const nu = n - 1;
  const z = zInv((1 + p) / 2);
  const chi = chi2Inv(1 - gamma, nu);
  return Math.sqrt(nu * (1 + 1 / n) * z * z / chi);
}

/* ---------- линейная регрессия и корреляция ---------- */
export function linfit(x, y) {
  const n = x.length, mx = mean(x), my = mean(y);
  const sxx = x.reduce((s, v) => s + (v - mx) ** 2, 0);
  const sxy = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  const syy = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const slope = sxx > 0 ? sxy / sxx : NaN;
  return { n, slope, intercept: my - slope * mx, r: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN, sxx };
}

/* ---------- Bland–Altman ----------
   pairs: [{a: показание приложения, r: эталон}] */
export function blandAltman(pairs) {
  const n = pairs.length;
  if (n < 3) return { n };
  const a = pairs.map((p) => p.a), r = pairs.map((p) => p.r);
  const d = pairs.map((p) => p.a - p.r), m = pairs.map((p) => (p.a + p.r) / 2);
  const bias = mean(d), s = sd(d);
  const t = tInv(0.975, n - 1);
  const k = tolFactor(n);
  const prop = linfit(m, d); // разность от среднего: пропорциональная ошибка
  return {
    n, bias, sd: s,
    biasCI: [bias - t * s / Math.sqrt(n), bias + t * s / Math.sqrt(n)],
    loa: [bias - 1.96 * s, bias + 1.96 * s],
    tol: [bias - k * s, bias + k * s], tolK: k,
    mae: mean(d.map(Math.abs)), rmse: Math.sqrt(mean(d.map((x) => x * x))), maxAbs: Math.max(...d.map(Math.abs)),
    propSlope: prop.slope, propR: prop.r,
    fit: linfit(a, r), // r = slope·a + intercept — поправка показаний
    diffs: d, means: m,
  };
}

/* ---------- повторяемость ----------
   groups: [[повторы одного объекта], ...]; берутся группы с ≥ 2 повторов */
export function repeatability(groups) {
  const g = groups.filter((x) => x.length >= 2);
  if (!g.length) return { groups: 0 };
  let ss = 0, df = 0;
  for (const x of g) { const m = mean(x); ss += x.reduce((s, v) => s + (v - m) ** 2, 0); df += x.length - 1; }
  const sw = Math.sqrt(ss / df);
  return { groups: g.length, df, sw, sem: sw, mdc95: 1.96 * Math.SQRT2 * sw, rc: 2.77 * sw };
}

/* ---------- ICC ----------
   matrix[i][j]: объект i, эксперт/повтор j; полная матрица без пропусков */
export function icc(matrix) {
  const n = matrix.length, k = matrix[0].length;
  if (n < 3 || k < 2) return { n, k };
  const rowM = matrix.map(mean);
  const colM = Array.from({ length: k }, (_, j) => mean(matrix.map((row) => row[j])));
  const gm = mean(rowM);
  const ssr = k * rowM.reduce((s, v) => s + (v - gm) ** 2, 0);
  const ssc = n * colM.reduce((s, v) => s + (v - gm) ** 2, 0);
  const sst = matrix.reduce((s, row) => s + row.reduce((q, v) => q + (v - gm) ** 2, 0), 0);
  const sse = sst - ssr - ssc;
  const msr = ssr / (n - 1), msc = ssc / (k - 1), mse = sse / ((n - 1) * (k - 1)), msw = (ssc + sse) / (n * (k - 1));
  const icc11 = (msr - msw) / (msr + (k - 1) * msw);
  const icc21 = (msr - mse) / (msr + (k - 1) * mse + k * (msc - mse) / n);
  const icc31 = (msr - mse) / (msr + (k - 1) * mse);
  const q = 0.975;
  // ДИ ICC(3,1) (McGraw & Wong, 1996)
  const F = msr / mse, df1 = n - 1, df2 = (n - 1) * (k - 1);
  const FL = F / fInv(q, df1, df2), FU = F * fInv(q, df2, df1);
  const ci31 = [(FL - 1) / (FL + k - 1), (FU - 1) / (FU + k - 1)];
  // ДИ ICC(2,1): приближение Саттертуэйта (McGraw & Wong, 1996)
  const a = k * icc21 / (n * (1 - icc21));
  const b = 1 + k * icc21 * (n - 1) / (n * (1 - icc21));
  const v = (a * msc + b * mse) ** 2 / ((a * msc) ** 2 / (k - 1) + (b * mse) ** 2 / ((n - 1) * (k - 1)));
  const FL2 = fInv(q, n - 1, v), FU2 = fInv(q, v, n - 1);
  const den = k * msc + (k * n - k - n) * mse;
  const ci21 = [n * (msr - FL2 * mse) / (FL2 * den + n * msr), n * (FU2 * msr - mse) / (den + n * FU2 * msr)];
  return { n, k, msr, msc, mse, icc11, icc21, icc31, ci21, ci31 };
}

// Трактовка по Koo & Li (2016): по нижней границе 95% ДИ
export function iccLabel(v) { return v < 0.5 ? "низкая" : v < 0.75 ? "умеренная" : v < 0.9 ? "хорошая" : "отличная"; }

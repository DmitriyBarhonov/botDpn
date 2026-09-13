/**
 * Работа с датами. Все даты подписок хранятся как строки 'YYYY-MM-DD'
 * (календарный день, без времени и без таймзоны).
 *
 * Почему не SQL-арифметика: SQLite date('2026-01-31','+1 month') возвращает
 * '2026-03-03' — переполняет дни вместо ограничения последним днём месяца.
 * Для продления подписки это дало бы клиенту лишние дни, поэтому месяцы
 * прибавляем здесь, с ограничением дня (клампингом).
 */

/** Проверяет, что строка — корректная календарная дата 'YYYY-MM-DD'. */
export function isValidDate(iso) {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

/** Количество дней в месяце (month — 1..12). */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Сегодняшняя дата в указанной таймзоне, как 'YYYY-MM-DD'.
 * en-CA даёт формат ISO без ручной сборки.
 */
export function todayIn(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Прибавляет n месяцев к дате, ограничивая день последним днём месяца.
 * '2026-01-31' + 1 мес => '2026-02-28' (а не '2026-03-03').
 */
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth(); // 0..11
  const day = Math.min(d, daysInMonth(ty, tm + 1));
  return format(ty, tm + 1, day);
}

/** Прибавляет n дней к дате. */
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/**
 * Целых дней от a до b. Положительное — b в будущем.
 * daysBetween('2026-09-08', '2026-09-11') === 3
 * Считаем через UTC-полдень, чтобы переходы на летнее время не влияли.
 */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

/** Дата в человеческом виде: '2026-09-08' -> '08.09.2026'. */
export function formatRu(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * Склонение слова «день» по числу: 1 день, 2 дня, 5 дней.
 */
export function pluralDays(n) {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} день`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} дня`;
  return `${n} дней`;
}

/** Склонение слова «месяц»: 1 месяц, 2 месяца, 5 месяцев. */
export function pluralMonths(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} месяц`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} месяца`;
  return `${n} месяцев`;
}

function format(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Единая классификация «сколько осталось до конца подписки», используемая
 * везде, где нужно показать статус: карточка пользователя, список, статус,
 * подпись кнопки. Раньше пороги (<=3 дня — «скоро», <0 — «просрочено» и т.д.)
 * были продублированы в четырёх местах и могли разойтись — теперь это
 * единственное место, где определены границы.
 *
 * @param {number|null} daysLeft null, если дата подписки ещё не выставлена
 * @returns {{bucket: 'none'|'ok'|'soon'|'today'|'overdue', mark: string}}
 */
export function daysLeftBucket(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return { bucket: 'none', mark: '⚪️' };
  if (daysLeft < 0) return { bucket: 'overdue', mark: '🔴' };
  if (daysLeft === 0) return { bucket: 'today', mark: '⚠️' };
  if (daysLeft <= 3) return { bucket: 'soon', mark: '⏳' };
  return { bucket: 'ok', mark: '✅' };
}

/**
 * Конфигурация из переменных окружения.
 * Загружается через `node --env-file=.env` (встроено в Node 20.6+),
 * поэтому пакет dotenv не нужен.
 *
 * Все ошибки конфигурации выявляем на старте: лучше не запуститься,
 * чем работать с пустым токеном и молчать.
 */

export function loadConfig(env = process.env) {
  const errors = [];

  const token = (env.BOT_TOKEN ?? '').trim();
  if (!token) {
    errors.push('BOT_TOKEN не задан — возьми токен у @BotFather');
  } else if (!/^\d+:[\w-]{30,}$/.test(token)) {
    errors.push('BOT_TOKEN выглядит некорректно (ожидается вид 123456789:AA...)');
  }

  const rawAdmin = (env.ADMIN_ID ?? '').trim();
  const adminId = Number(rawAdmin);
  if (!rawAdmin) {
    errors.push('ADMIN_ID не задан — узнай свой numeric id у @userinfobot');
  } else if (!Number.isInteger(adminId) || adminId <= 0) {
    errors.push(`ADMIN_ID должен быть положительным числом, получено: "${rawAdmin}"`);
  }

  const timeZone = (env.TZ_NAME ?? 'Europe/Moscow').trim();
  if (!isValidTimeZone(timeZone)) {
    errors.push(`TZ_NAME "${timeZone}" — неизвестная таймзона (нужен вид Europe/Moscow)`);
  }

  const dbFile = (env.DB_FILE ?? './data/bot.db').trim();

  const rawHour = (env.REMIND_HOUR ?? '12').trim();
  const remindHour = Number(rawHour);
  if (!Number.isInteger(remindHour) || remindHour < 0 || remindHour > 23) {
    errors.push(`REMIND_HOUR должен быть числом 0..23, получено: "${rawHour}"`);
  }

  const rawMinute = (env.REMIND_MINUTE ?? '0').trim();
  const remindMinute = Number(rawMinute);
  if (!Number.isInteger(remindMinute) || remindMinute < 0 || remindMinute > 59) {
    errors.push(`REMIND_MINUTE должен быть числом 0..59, получено: "${rawMinute}"`);
  }

  if (errors.length) {
    const list = errors.map(e => `  • ${e}`).join('\n');
    throw new Error(`Ошибки конфигурации (.env):\n${list}`);
  }

  return { token, adminId, timeZone, dbFile, remindHour, remindMinute };
}

/** Проверяет, что IANA-идентификатор таймзоны существует. */
export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Ежедневная проверка подписок и отправка напоминаний.
 *
 * Логика: для каждого активного пользователя с выставленной датой считаем,
 * сколько дней осталось до paid_until, и выбираем ОДИН вид напоминания:
 *   3 дня  -> 'd3'
 *   1 день -> 'd1'
 *   0 дней -> 'd0'      (заканчивается сегодня)
 *   < 0    -> 'overdue' (просрочено; не чаще раза в день)
 * За 2 дня намеренно не пишем — иначе четыре сообщения подряд раздражают.
 *
 * Идемпотентность: перед отправкой «занимаем» запись в sent_notifications
 * (UNIQUE по tg_id + kind + due_date + sent_on). Перезапуск процесса или
 * повторный запуск задачи в тот же день ничего не пришлёт повторно.
 * Если Telegram вернул ошибку — запись откатывается, чтобы попробовать позже.
 */

import { todayIn, daysBetween } from './lib/dates.js';
import * as T from './lib/texts.js';
import { paidKeyboard } from './keyboards.js';

/** Пауза между отправками, чтобы не упереться в лимиты Telegram. */
const SEND_DELAY_MS = 120;

const LAST_RUN_KEY = 'last_reminder_run';

/**
 * Определяет, какое напоминание нужно пользователю сегодня.
 * @returns {{kind:string, text:string}|null}
 */
export function pickReminder(user, today) {
  const left = daysBetween(today, user.paid_until);

  if (left === 3) return { kind: 'd3', text: T.remind3Days(user) };
  if (left === 1) return { kind: 'd1', text: T.remind1Day(user) };
  if (left === 0) return { kind: 'd0', text: T.remindToday(user) };
  if (left < 0) return { kind: 'overdue', text: T.remindOverdue(user, -left) };
  return null;
}

/**
 * Прогоняет проверку по всем пользователям.
 * @param {object} deps
 * @param {import('./lib/db.js').Store} deps.store
 * @param {import('grammy').Bot} deps.bot
 * @param {string} deps.timeZone
 * @param {(msg:string)=>void} [deps.log]
 * @returns {Promise<{checked:number, sent:number, skipped:number, failed:number, blocked:number}>}
 */
export async function runDailyCheck({ store, bot, timeZone, log = () => {} }) {
  const today = todayIn(timeZone);
  const users = store.listForReminders();
  const stats = { checked: users.length, sent: 0, skipped: 0, failed: 0, blocked: 0 };

  for (const user of users) {
    const reminder = pickReminder(user, today);
    if (!reminder) continue;

    // Занимаем слот ДО отправки: лучше пропустить, чем задублировать.
    const isFirst = store.claimNotification(user.tg_id, reminder.kind, user.paid_until, today);
    if (!isFirst) {
      stats.skipped++;
      continue;
    }

    try {
      await bot.api.sendMessage(user.tg_id, reminder.text, {
        parse_mode: 'HTML',
        reply_markup: paidKeyboard(),
      });
      stats.sent++;
      if (user.is_blocked) store.setBlocked(user.tg_id, false);
      log(`напоминание ${reminder.kind} -> ${user.name || user.tg_id}`);
    } catch (err) {
      if (isBlockedError(err)) {
        // Пользователь заблокировал бота или удалил аккаунт.
        // Слот НЕ откатываем: повторять отправку бессмысленно.
        store.setBlocked(user.tg_id, true);
        stats.blocked++;
        log(`заблокирован: ${user.name || user.tg_id}`);
      } else {
        // Временная ошибка — откатываем, попробуем при следующем запуске.
        store.releaseNotification(user.tg_id, reminder.kind, user.paid_until, today);
        stats.failed++;
        log(`ошибка отправки ${user.tg_id}: ${err?.message ?? err}`);
      }
    }

    await sleep(SEND_DELAY_MS);
  }

  store.setMeta(LAST_RUN_KEY, today);
  log(
    `проверка ${today}: пользователей ${stats.checked}, отправлено ${stats.sent}, ` +
      `пропущено ${stats.skipped}, ошибок ${stats.failed}, заблокировано ${stats.blocked}`
  );
  return stats;
}

/**
 * Догоняющий запуск при старте процесса.
 * cron-библиотеки НЕ выполняют пропущенный запуск: если VPS был выключен
 * в момент задачи, напоминание потерялось бы. Поэтому при старте смотрим,
 * запускались ли мы уже сегодня, и если нет — запускаем сразу.
 */
export async function catchUpOnStartup(deps) {
  const today = todayIn(deps.timeZone);
  const lastRun = deps.store.getMeta(LAST_RUN_KEY);
  if (lastRun === today) {
    deps.log?.(`проверка за ${today} уже выполнялась, догоняющий запуск не нужен`);
    return null;
  }
  deps.log?.(`догоняющий запуск (последний был: ${lastRun ?? 'никогда'})`);
  return runDailyCheck(deps);
}

export function getLastRun(store) {
  return store.getMeta(LAST_RUN_KEY);
}

/**
 * Распознаёт ошибку «пользователь заблокировал бота» / «чат не найден».
 * Такие ошибки не нужно повторять — только помечать пользователя.
 */
export function isBlockedError(err) {
  const code = err?.error_code ?? err?.parameters?.error_code;
  const desc = String(err?.description ?? err?.message ?? '').toLowerCase();
  if (code === 403) return true;
  return (
    desc.includes('bot was blocked') ||
    desc.includes('user is deactivated') ||
    desc.includes('chat not found') ||
    desc.includes('bot was kicked')
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Обработчики для обычного пользователя:
 *   /start -> приветствие -> запрос имени -> сохранение
 *   «Моя подписка», «Я оплатил» (1–4 месяца), помощь.
 *
 * Многошаговый ввод имени сделан простым состоянием в БД (users.state),
 * без плагина conversations: состояние переживает перезапуск процесса.
 */

import { todayIn, daysBetween, daysLeftBucket } from '../lib/dates.js';
import * as T from '../lib/texts.js';
import { userMenu, monthsKeyboard, paidKeyboard, claimKeyboard } from '../keyboards.js';
import { isBlockedError } from '../reminders.js';

const NAME_MIN = 2;
const NAME_MAX = 40;

/**
 * @param {import('grammy').Bot} bot
 * @param {object} deps
 * @param {import('../lib/db.js').Store} deps.store
 * @param {number} deps.adminId
 * @param {string} deps.timeZone
 * @param {(m:string)=>void} deps.log
 */
export function registerUserHandlers(bot, deps) {
  const { store, adminId, timeZone, log } = deps;

  bot.command('start', async ctx => {
    const from = ctx.from;
    if (!from) return;

    const existing = store.getUser(from.id);
    store.upsertUser(from.id, from.username);

    // Повторный /start у знакомого пользователя не сбрасывает имя и дату.
    if (existing?.name) {
      await ctx.reply(`С возвращением, <b>${T.esc(existing.name)}</b>! 👋`, {
        parse_mode: 'HTML',
        reply_markup: userMenu(),
      });
      await sendStatus(ctx, store, timeZone);
      return;
    }

    store.setState(from.id, 'awaiting_name');
    await ctx.reply(T.WELCOME, { parse_mode: 'HTML', reply_markup: userMenu() });
    await ctx.reply(T.ASK_NAME);
  });

  bot.command('status', async ctx => {
    if (!store.getUser(ctx.from?.id)) return;
    await sendStatus(ctx, store, timeZone);
  });

  bot.command('help', async ctx => {
    await ctx.reply(T.USER_HELP, { parse_mode: 'HTML', reply_markup: userMenu() });
  });

  // Кнопки постоянного меню приходят обычным текстом.
  bot.hears(T.BTN.myStatus, async ctx => {
    await sendStatus(ctx, store, timeZone);
  });

  bot.hears(T.BTN.help, async ctx => {
    await ctx.reply(T.USER_HELP, { parse_mode: 'HTML' });
  });

  bot.hears(T.BTN.paid, async ctx => {
    await ctx.reply('За сколько месяцев ты оплатил?', { reply_markup: monthsKeyboard() });
  });

  // Инлайн-кнопка «Я оплатил» из напоминания.
  bot.callbackQuery('pay', async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.reply('За сколько месяцев ты оплатил?', { reply_markup: monthsKeyboard() });
  });

  bot.callbackQuery('st', async ctx => {
    await ctx.answerCallbackQuery();
    await sendStatus(ctx, store, timeZone);
  });

  bot.callbackQuery('uh', async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.reply(T.USER_HELP, { parse_mode: 'HTML' });
  });

  // Выбор количества месяцев -> создаём заявку и пишем админу.
  bot.callbackQuery(/^pm:([1-4])$/, async ctx => {
    const months = Number(ctx.match[1]);
    const tgId = ctx.from.id;

    let user = store.getUser(tgId);
    if (!user) {
      user = store.upsertUser(tgId, ctx.from.username);
    }

    await ctx.answerCallbackQuery('Заявка отправлена');

    const { id: claimId } = store.createClaim(tgId, months);
    const fresh = store.getUser(tgId);

    // Убираем кнопки у сообщения с выбором месяцев, чтобы не нажали второй раз.
    await ctx.editMessageText(
      fresh.paid_until ? T.claimSent(months) : T.CLAIM_NO_DATE,
      { parse_mode: 'HTML' }
    ).catch(() => {});

    // Уведомление админу с кнопками подтверждения.
    try {
      await bot.api.sendMessage(adminId, T.adminClaimNotice(fresh, { months }), {
        parse_mode: 'HTML',
        reply_markup: claimKeyboard(claimId),
      });
      log(`заявка #${claimId}: ${fresh.name || tgId} на ${months} мес.`);
    } catch (err) {
      log(`НЕ УДАЛОСЬ уведомить админа о заявке #${claimId}: ${err?.message ?? err}`);
      // Заявка остаётся в БД — админ увидит её в /pending.
    }
  });

  // Ввод имени: срабатывает только в состоянии awaiting_name.
  // Регистрируется последним, чтобы не перехватывать кнопки меню.
  bot.on('message:text', async ctx => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = store.getUser(tgId);

    if (!user) {
      // Написал боту, не нажав /start.
      await ctx.reply('Нажми /start, чтобы начать 🙂');
      return;
    }

    if (user.state !== 'awaiting_name') {
      // Обычное сообщение вне сценария — подсказываем меню.
      await ctx.reply('Не понял. Выбери действие в меню ниже 👇', { reply_markup: userMenu() });
      return;
    }

    const name = sanitizeName(ctx.message.text);
    if (!name) {
      await ctx.reply(T.ASK_NAME_AGAIN, { parse_mode: 'HTML' });
      return;
    }

    store.setName(tgId, name);
    log(`новый пользователь: ${name} (${tgId}, @${ctx.from.username ?? '—'})`);

    await ctx.reply(T.nameSaved(name), { parse_mode: 'HTML', reply_markup: userMenu() });

    // Сообщаем админу, что появился новый человек и ему нужно выставить дату.
    try {
      const uname = ctx.from.username ? ` (@${T.esc(ctx.from.username)})` : '';
      await bot.api.sendMessage(
        adminId,
        `🆕 <b>Новый пользователь</b>\n\n` +
          `Имя: <b>${T.esc(name)}</b>${uname}\n` +
          `ID: <code>${tgId}</code>\n\n` +
          `Нужно выставить дату окончания подписки — открой /users.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      log(`не удалось уведомить админа о новом пользователе: ${err?.message ?? err}`);
    }
  });
}

/** Отправляет пользователю его статус подписки. */
async function sendStatus(ctx, store, timeZone) {
  const user = store.getUser(ctx.from.id);
  if (!user) {
    await ctx.reply('Нажми /start, чтобы начать 🙂');
    return;
  }
  const today = todayIn(timeZone);
  const daysLeft = user.paid_until ? daysBetween(today, user.paid_until) : null;
  const showPay = ['soon', 'today', 'overdue'].includes(daysLeftBucket(daysLeft).bucket);

  await ctx.reply(T.myStatus(user, today, daysLeft), {
    parse_mode: 'HTML',
    reply_markup: showPay ? paidKeyboard() : undefined,
  });
}

/**
 * Приводит введённое имя к безопасному виду.
 * @returns {string|null} null, если имя не подходит
 */
export function sanitizeName(raw) {
  let name = String(raw ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (name.startsWith('/')) return null;            // это команда, а не имя
  if (/https?:\/\/|t\.me\/|@\w{4,}/i.test(name)) return null; // ссылки и упоминания
  if (name.length < NAME_MIN || name.length > NAME_MAX) return null;
  if (!/[\p{L}]/u.test(name)) return null;          // должна быть хотя бы одна буква

  return name;
}

export { isBlockedError };

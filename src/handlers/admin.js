/**
 * Админ-панель внутри бота. Доступна только аккаунту с ADMIN_ID.
 *
 * Экраны:
 *   /admin, /help  — меню и справка
 *   /users         — список пользователей, постранично, с сортировкой «кто ближе к концу»
 *   карточка       — изменить дату, изменить имя, +1..4 месяца, архив
 *   /pending       — заявки, ожидающие подтверждения
 *   /find <текст>  — поиск по имени, @username или ID
 *   /stats, /audit — сводка и журнал изменений
 *   /broadcast     — разослать сообщение всем активным пользователям
 *
 * Ввод даты/имени/текста рассылки реализован состоянием в памяти процесса
 * (adminState): это короткоживущий диалог, терять его при перезапуске не страшно.
 */

import { todayIn, daysBetween, addMonths, formatRu, isValidDate, pluralMonths } from '../lib/dates.js';
import * as T from '../lib/texts.js';
import {
  usersKeyboard,
  userCardKeyboard,
  adminMenuKeyboard,
  claimKeyboard,
} from '../keyboards.js';
import { runDailyCheck, getLastRun, isBlockedError } from '../reminders.js';
import { sanitizeName } from './user.js';

const PAGE_SIZE = 8;

/** Ожидание ввода: adminState.set(adminId, {tgId, mode}) или {mode: 'broadcast'}. */
const adminState = new Map();

/** Пауза между отправками рассылки, чтобы не упереться в лимиты Telegram. */
const BROADCAST_DELAY_MS = 120;

export function registerAdminHandlers(bot, deps) {
  const { store, adminId, timeZone, log } = deps;

  const isAdmin = ctx => ctx.from?.id === adminId;

  // ---------- команды ----------

  bot.command(['admin', 'menu'], async ctx => {
    if (!isAdmin(ctx)) return;
    await ctx.reply(T.ADMIN_HELP, { parse_mode: 'HTML', reply_markup: adminMenuKeyboard() });
  });

  bot.command('users', async ctx => {
    if (!isAdmin(ctx)) return;
    await showUsersPage(ctx, deps, 0, false);
  });

  bot.command('pending', async ctx => {
    if (!isAdmin(ctx)) return;
    await showPending(ctx, deps, false);
  });

  bot.command('stats', async ctx => {
    if (!isAdmin(ctx)) return;
    const counts = store.countUsers();
    const pending = store.listPendingClaims().length;
    await ctx.reply(T.statsText(counts, pending, timeZone, getLastRun(store)), {
      parse_mode: 'HTML',
    });
  });

  bot.command('audit', async ctx => {
    if (!isAdmin(ctx)) return;
    const rows = store.listAudit(20);
    if (!rows.length) {
      await ctx.reply('Журнал пуст.');
      return;
    }
    const lines = rows.map(r => {
      const when = r.at.slice(0, 16).replace('T', ' ');
      return `<code>${when}</code> ${T.esc(r.action)} ${r.tg_id ?? ''} ${T.esc(r.details ?? '')}`;
    });
    await ctx.reply('🧾 <b>Последние изменения</b>\n\n' + lines.join('\n'), { parse_mode: 'HTML' });
  });

  bot.command('find', async ctx => {
    if (!isAdmin(ctx)) return;
    const query = (ctx.match ?? '').trim().toLowerCase().replace(/^@/, '');
    if (!query) {
      await ctx.reply('Использование: /find Иван — или /find 123456789');
      return;
    }
    const today = todayIn(timeZone);
    const found = store.listUsers({ activeOnly: false }).filter(u => {
      return (
        String(u.tg_id).includes(query) ||
        (u.name ?? '').toLowerCase().includes(query) ||
        (u.username ?? '').toLowerCase().includes(query)
      );
    });
    if (!found.length) {
      await ctx.reply('Никого не нашёл.');
      return;
    }
    for (const u of found.slice(0, 10)) {
      await sendUserCard(ctx, deps, u.tg_id, 0, false);
    }
    if (found.length > 10) {
      await ctx.reply(`Показал 10 из ${found.length}. Уточни запрос.`);
    }
  });

  /** Рассылка всем активным пользователям. С аргументом — сразу, без — спросит текст. */
  bot.command('broadcast', async ctx => {
    if (!isAdmin(ctx)) return;
    const text = (ctx.match ?? '').trim();
    if (!text) {
      adminState.set(ctx.from.id, { mode: 'broadcast' });
      await ctx.reply(T.ADMIN_ASK_BROADCAST, { parse_mode: 'HTML' });
      return;
    }
    await runBroadcast(ctx, deps, text);
  });

  /** Ручной прогон ежедневной проверки — удобно для теста. */
  bot.command('runcheck', async ctx => {
    if (!isAdmin(ctx)) return;
    await ctx.reply('Запускаю проверку подписок…');
    const stats = await runDailyCheck({ store, bot, timeZone, log });
    await ctx.reply(
      `Готово.\nПроверено: ${stats.checked}\nОтправлено: ${stats.sent}\n` +
        `Пропущено (уже отправляли): ${stats.skipped}\nОшибок: ${stats.failed}\n` +
        `Заблокировали бота: ${stats.blocked}`
    );
  });

  bot.command('cancel', async ctx => {
    if (!isAdmin(ctx)) return;
    if (adminState.delete(ctx.from.id)) {
      await ctx.reply(T.CANCELLED);
    }
  });

  // ---------- инлайн-кнопки ----------

  bot.callbackQuery(/^ul:(\d+)$/, async ctx => {
    if (!isAdmin(ctx)) return void ctx.answerCallbackQuery(T.NOT_ADMIN);
    await ctx.answerCallbackQuery();
    await showUsersPage(ctx, deps, Number(ctx.match[1]), true);
  });

  bot.callbackQuery(/^uc:(\d+)$/, async ctx => {
    if (!isAdmin(ctx)) return void ctx.answerCallbackQuery(T.NOT_ADMIN);
    await ctx.answerCallbackQuery();
    await sendUserCard(ctx, deps, Number(ctx.match[1]), 0, true);
  });

  bot.callbackQuery('pl', async ctx => {
    if (!isAdmin(ctx)) return void ctx.answerCallbackQuery(T.NOT_ADMIN);
    await ctx.answerCallbackQuery();
    await showPending(ctx, deps, true);
  });

  bot.callbackQuery('noop', ctx => ctx.answerCallbackQuery());

  /** Запрос ручного ввода даты. */
  bot.callbackQuery(/^ud:(\d+)$/, async ctx => {
    if (!isAdmin(ctx)) return void ctx.answerCallbackQuery(T.NOT_ADMIN);
    const tgId = Number(ctx.match[1]);
    const user = store.getUser(tgId);
    if (!user) return void ctx.answerCallbackQuery('Пользователь не найден');

    adminState.set(ctx.from.id, { tgId, mode: 'date' });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Пользователь: <b>${T.esc(user.name || tgId)}</b>\n` +
        `Текущая дата: ${user.paid_until ? formatRu(user.paid_until) : '—'}\n\n` +
        T.ADMIN_ASK_DATE,
      { parse_mode: 'HTML' }
    );
  });

  /** Запрос ручного ввода имени. */
  bot.callbackQuery(/^un:(\d+)$/, async ctx => {
    if (!isAdmin(ctx)) return void ctx.answerCallbackQuery(T.NOT_ADMIN);
    const tgId = Number(ctx.match[1]);
    const user = store.getUser(tgId);
    if (!user) return void ctx.answerCallbackQuery('Пользователь не найден');

    adminState.set(ctx.from.id, { tgId, mode: 'name' });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `Пользователь: <b>${T.esc(user.name || tgId)}</b>\n` +
        `Текущее имя: <b>${T.esc(user.name || '—')}</b>\n\n` +
        T.ADMIN_ASK_NAME,
      { parse_mode: 'HTML' }
    );
  });

  /** Быстрое продление на N месяцев. */
  bot.callbackQuery(/^ua:(\d+):([1-4])$/, async ctx => {
    if (!isAdmin(ctx)) return void ctx.answerCallbackQuery(T.NOT_ADMIN);
    const tgId = Number(ctx.match[1]);
    const months = Number(ctx.match[2]);
    const user = store.getUser(tgId);
    if (!user) return void ctx.answerCallbackQuery('Пользователь не найден');

    const today = todayIn(timeZone);
    // От будущей даты продлеваем, от прошедшей — считаем с сегодня.
    const base = user.paid_until && user.paid_until >= today ? user.paid_until : today;
    const next = addMonths(base, months);
    store.setPaidUntil(tgId, next, ctx.from.id, `add_${months}m`);

    await ctx.answerCallbackQuery(`+${months} мес.`);
    await refreshCard(ctx, deps, tgId);
    await notifyUser(bot, tgId, store, log,
      `📅 Администратор продлил твою подписку на ${pluralMonths(months)}.\n\n` +
        `Теперь оплачено до: <b>${formatRu(next)}</b>`
    );
    log(`админ продлил ${user.name || tgId} на ${months} мес: ${base} -> ${next}`);
  });

  /** Архив / возврат из архива. */
  bot.callbackQuery(/^ux:(\d+):([01])$/, async ctx => {
    if (!isAdmin(ctx)) return void ctx.answerCallbackQuery(T.NOT_ADMIN);
    const tgId = Number(ctx.match[1]);
    const active = ctx.match[2] === '1';
    store.setActive(tgId, active, ctx.from.id);
    await ctx.answerCallbackQuery(active ? 'Возвращён' : 'В архиве');
    await refreshCard(ctx, deps, tgId);
  });

  /** Подтверждение заявки. */
  bot.callbackQuery(/^cc:(\d+)$/, async ctx => {
    if (!isAdmin(ctx)) return void ctx.answerCallbackQuery(T.NOT_ADMIN);
    const claimId = Number(ctx.match[1]);

    const result = store.confirmClaim(claimId, timeZone, ctx.from.id);

    if (result.needsDate) {
      // У пользователя ещё нет ни одной выставленной даты — подтверждать
      // рано: иначе дата назначилась бы автоматически от сегодня, в обход
      // требования «админ выставляет первую дату вручную». Заявка остаётся
      // pending, чтобы её можно было подтвердить после того, как дата появится.
      await ctx.answerCallbackQuery('Сначала выставь дату вручную', { show_alert: true });
      await ctx.reply(
        `⚠️ У <b>${T.esc(result.user?.name || result.claim.tg_id)}</b> ещё не выставлена дата подписки.\n\n` +
          'Сначала открой /users и задай дату вручную — после этого заявку можно будет подтвердить.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (!result.ok) {
      const msg = result.already ? 'Заявка уже обработана' : 'Заявка не найдена';
      await ctx.answerCallbackQuery(msg);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return;
    }

    const user = store.getUser(result.claim.tg_id);
    await ctx.answerCallbackQuery('Подтверждено ✅');
    await ctx
      .editMessageText(T.adminClaimResolved(user, result.claim, result.from, result.to), {
        parse_mode: 'HTML',
      })
      .catch(() => {});

    await notifyUser(bot, user.tg_id, store, log,
      T.claimConfirmed(result.claim.months, result.to)
    );
    log(`заявка #${claimId} подтверждена: ${user.name || user.tg_id} -> ${result.to}`);
  });

  /** Отклонение заявки. */
  bot.callbackQuery(/^cr:(\d+)$/, async ctx => {
    if (!isAdmin(ctx)) return void ctx.answerCallbackQuery(T.NOT_ADMIN);
    const claimId = Number(ctx.match[1]);

    const result = store.rejectClaim(claimId, ctx.from.id);
    if (!result.ok) {
      await ctx.answerCallbackQuery(result.already ? 'Заявка уже обработана' : 'Заявка не найдена');
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return;
    }

    const user = store.getUser(result.claim.tg_id);
    await ctx.answerCallbackQuery('Отклонено');
    await ctx
      .editMessageText(T.adminClaimRejectedNotice(user, result.claim), { parse_mode: 'HTML' })
      .catch(() => {});

    await notifyUser(bot, user.tg_id, store, log, T.CLAIM_REJECTED);
    log(`заявка #${claimId} отклонена: ${user.name || user.tg_id}`);
  });

  // ---------- ввод даты/имени текстом ----------
  // Возвращает true, если сообщение обработано как ввод для adminState.
  return function handleAdminText(ctx) {
    if (ctx.from?.id !== adminId) return false;
    const pending = adminState.get(adminId);
    if (!pending) return false;

    const text = (ctx.message?.text ?? '').trim();
    if (text.startsWith('/')) return false; // команды не считаем вводом

    if (pending.mode === 'name') {
      return handleNameInput(ctx, deps, pending, text);
    }
    if (pending.mode === 'broadcast') {
      adminState.delete(adminId);
      runBroadcast(ctx, deps, ctx.message.text); // берём текст как есть, без .trim()
      return true;
    }
    return handleDateInput(ctx, deps, pending, text);
  };

  function handleDateInput(ctx, deps, pending, text) {
    const iso = parseRuDate(text);
    if (!iso) {
      ctx.reply(T.ADMIN_BAD_DATE, { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }

    const user = store.getUser(pending.tgId);
    adminState.delete(adminId);
    if (!user) {
      ctx.reply('Пользователь не найден.').catch(() => {});
      return true;
    }

    store.setPaidUntil(pending.tgId, iso, adminId, 'set_date');
    const today = todayIn(timeZone);
    const left = daysBetween(today, iso);
    const warn = left < 0 ? '\n\n⚠️ Дата в прошлом — подписка сразу считается просроченной.' : '';

    ctx
      .reply(
        `✅ Дата для <b>${T.esc(user.name || user.tg_id)}</b> изменена на <b>${formatRu(iso)}</b>.` +
          warn,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});

    notifyUser(bot, pending.tgId, store, log,
      `📅 Администратор обновил дату твоей подписки.\n\nОплачено до: <b>${formatRu(iso)}</b>`
    );
    log(`админ выставил дату ${user.name || pending.tgId}: ${iso}`);
    return true;
  }

  function handleNameInput(ctx, deps, pending, text) {
    const name = sanitizeName(text);
    if (!name) {
      ctx.reply(T.ADMIN_BAD_NAME, { parse_mode: 'HTML' }).catch(() => {});
      return true;
    }

    const user = store.getUser(pending.tgId);
    adminState.delete(adminId);
    if (!user) {
      ctx.reply('Пользователь не найден.').catch(() => {});
      return true;
    }

    const oldName = user.name;
    store.renameUser(pending.tgId, name, adminId);

    ctx
      .reply(
        `✅ Имя для <code>${pending.tgId}</code> изменено: <b>${T.esc(oldName || '—')}</b> → <b>${T.esc(name)}</b>.`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});

    notifyUser(bot, pending.tgId, store, log,
      `✏️ Администратор изменил твоё имя на: <b>${T.esc(name)}</b>`
    );
    log(`админ изменил имя ${pending.tgId}: ${oldName || '—'} -> ${name}`);
    return true;
  }
}

// ---------- вспомогательные функции ----------

async function showUsersPage(ctx, deps, page, edit) {
  const { store, timeZone } = deps;
  const today = todayIn(timeZone);
  const all = store.listUsers({ activeOnly: false }).map(u => ({
    ...u,
    daysLeft: u.paid_until ? daysBetween(today, u.paid_until) : null,
  }));

  if (!all.length) {
    await reply(ctx, T.NO_USERS, {}, edit);
    return;
  }

  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const soon = all.filter(u => u.daysLeft !== null && u.daysLeft >= 0 && u.daysLeft <= 3).length;
  const overdue = all.filter(u => u.daysLeft !== null && u.daysLeft < 0).length;
  const noDate = all.filter(u => u.paid_until === null).length;

  const header =
    `👥 <b>Пользователи</b> — всего ${all.length}\n` +
    `⏳ скоро истекают: ${soon}   🔴 просрочено: ${overdue}   ⚪️ без даты: ${noDate}\n\n` +
    `Нажми на пользователя, чтобы открыть карточку.`;

  await reply(ctx, header, {
    parse_mode: 'HTML',
    reply_markup: usersKeyboard(slice, safePage, pages),
  }, edit);
}

async function sendUserCard(ctx, deps, tgId, page, edit) {
  const { store, timeZone } = deps;
  const user = store.getUser(tgId);
  if (!user) {
    await reply(ctx, 'Пользователь не найден.', {}, edit);
    return;
  }
  const today = todayIn(timeZone);
  const daysLeft = user.paid_until ? daysBetween(today, user.paid_until) : null;

  await reply(ctx, T.adminUserCard(user, today, daysLeft), {
    parse_mode: 'HTML',
    reply_markup: userCardKeyboard(user, page),
  }, edit);
}

/** Обновляет карточку на месте после действия. */
async function refreshCard(ctx, deps, tgId) {
  const { store, timeZone } = deps;
  const user = store.getUser(tgId);
  if (!user) return;
  const today = todayIn(timeZone);
  const daysLeft = user.paid_until ? daysBetween(today, user.paid_until) : null;
  await ctx
    .editMessageText(T.adminUserCard(user, today, daysLeft), {
      parse_mode: 'HTML',
      reply_markup: userCardKeyboard(user, 0),
    })
    .catch(() => {});
}

async function showPending(ctx, deps, edit) {
  const { store } = deps;
  const claims = store.listPendingClaims();
  if (!claims.length) {
    await reply(ctx, T.NO_PENDING, { reply_markup: adminMenuKeyboard() }, edit);
    return;
  }
  await reply(ctx, `💰 Заявок в ожидании: <b>${claims.length}</b>`, { parse_mode: 'HTML' }, edit);
  for (const c of claims) {
    await ctx.reply(T.adminClaimNotice(c, c), {
      parse_mode: 'HTML',
      reply_markup: claimKeyboard(c.id),
    });
  }
}

/**
 * Рассылает текст всем активным (не в архиве) пользователям.
 * Блокировки помечает в базе, как и ежедневные напоминания; не дублирует
 * логику ожидания — просто ждёт BROADCAST_DELAY_MS между отправками.
 */
export async function runBroadcast(ctx, deps, text) {
  const { store, bot, log } = deps;
  const users = store.listUsers({ activeOnly: true });

  if (!users.length) {
    await ctx.reply('Нет активных пользователей для рассылки.');
    return;
  }

  await ctx.reply(`📣 Рассылаю ${users.length} пользователям…`);

  let sent = 0;
  let blocked = 0;
  let failed = 0;

  for (const user of users) {
    try {
      await bot.api.sendMessage(user.tg_id, text, { parse_mode: 'HTML' });
      sent++;
      if (user.is_blocked) store.setBlocked(user.tg_id, false);
    } catch (err) {
      if (isBlockedError(err)) {
        store.setBlocked(user.tg_id, true);
        blocked++;
      } else {
        failed++;
        log(`рассылка: ошибка отправки ${user.tg_id}: ${err?.message ?? err}`);
      }
    }
    await sleep(BROADCAST_DELAY_MS);
  }

  await ctx.reply(
    `✅ Рассылка завершена.\nДоставлено: ${sent}\nЗаблокировали бота: ${blocked}\nОшибок: ${failed}`
  );
  log(`рассылка админа: доставлено ${sent}, заблокировано ${blocked}, ошибок ${failed}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Отправляет или редактирует сообщение — в зависимости от источника вызова. */
async function reply(ctx, text, opts, edit) {
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch {
      // Сообщение могло быть удалено или текст совпадает — отправим новое.
    }
  }
  await ctx.reply(text, opts);
}

/** Пишет пользователю, аккуратно обрабатывая блокировку бота. */
async function notifyUser(bot, tgId, store, log, text) {
  try {
    await bot.api.sendMessage(tgId, text, { parse_mode: 'HTML' });
    store.setBlocked(tgId, false);
  } catch (err) {
    if (isBlockedError(err)) {
      store.setBlocked(tgId, true);
      log(`пользователь ${tgId} заблокировал бота`);
    } else {
      log(`не удалось написать ${tgId}: ${err?.message ?? err}`);
    }
  }
}

/**
 * Разбирает дату, введённую админом. Принимает ДД.ММ.ГГГГ, ДД/ММ/ГГГГ,
 * ДД-ММ-ГГГГ и ISO ГГГГ-ММ-ДД.
 * @returns {string|null} 'YYYY-MM-DD' или null
 */
export function parseRuDate(text) {
  const s = String(text ?? '').trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    return isValidDate(iso) ? iso : null;
  }

  m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isValidDate(iso) ? iso : null;
  }

  return null;
}

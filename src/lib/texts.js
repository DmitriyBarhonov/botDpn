/**
 * Все тексты бота в одном месте — чтобы менять формулировки,
 * не трогая логику.
 *
 * parse_mode = 'HTML' везде. HTML безопаснее MarkdownV2: экранировать нужно
 * только три символа (& < >), и имя пользователя, введённое вручную,
 * не может сломать разметку. Любое подставляемое имя пропускаем через esc().
 */

import { formatRu, pluralDays, pluralMonths, daysLeftBucket } from './dates.js';

/** Экранирование для parse_mode: 'HTML'. */
export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// ---------- пользователь ----------

export const WELCOME =
  '👋 Привет! Я бот-напоминалка об оплате.\n\n' +
  'Буду писать тебе, когда подойдёт время платить, чтобы доступ не отключился ' +
  'в самый неподходящий момент.\n\n' +
  '⚠️ <b>Важно: не отключай мне уведомления.</b> Я напоминаю только здесь и ' +
  'не бегаю за каждым отдельно — если пропустишь сообщение, доступ просто перестанет работать.\n\n' +
  'Давай познакомимся 👇';

export const ASK_NAME = 'Как тебя зовут? Напиши имя одним сообщением — так я буду тебя узнавать.';

export const ASK_NAME_AGAIN =
  'Напиши, пожалуйста, имя обычным текстом (от 2 до 40 символов, без ссылок).';

export function nameSaved(name) {
  return (
    `Приятно познакомиться, <b>${esc(name)}</b>! 🤝\n\n` +
    'Я записал тебя. Как только администратор выставит дату окончания подписки, ' +
    'я начну напоминать об оплате заранее — за 3 дня, за день и в сам день окончания.\n\n' +
    'Нажми «Моя подписка», чтобы посмотреть статус.'
  );
}

/** Экран «Моя подписка». */
export function myStatus(user, today, daysLeft) {
  const head = `👤 <b>${esc(user.name || 'без имени')}</b>\n`;

  if (!user.paid_until) {
    return (
      head +
      '\n📅 Дата окончания подписки пока не выставлена.\n\n' +
      'Администратор внесёт её вручную — после этого я начну напоминать об оплате. ' +
      'Ничего делать не нужно, просто подожди.'
    );
  }

  const until = `📅 Подписка оплачена до: <b>${formatRu(user.paid_until)}</b>\n`;
  const { bucket } = daysLeftBucket(daysLeft);

  if (bucket === 'ok') {
    return head + '\n' + until + `\n✅ Всё в порядке, осталось ${pluralDays(daysLeft)}. Напомню заранее.`;
  }
  if (bucket === 'soon') {
    return (
      head + '\n' + until +
      `\n⏳ Осталось ${pluralDays(daysLeft)}. Пора продлевать — нажми кнопку ниже, когда оплатишь.`
    );
  }
  if (bucket === 'today') {
    return head + '\n' + until + '\n⚠️ Подписка заканчивается <b>сегодня</b>. Нужно оплатить, чтобы не потерять доступ.';
  }
  return (
    head + '\n' + until +
    `\n🔴 Подписка просрочена на ${pluralDays(-daysLeft)}. Оплати, пожалуйста, и нажми кнопку ниже.`
  );
}

// ---------- напоминания ----------

export function remind3Days(user) {
  return (
    `Привет, <b>${esc(user.name)}</b>! ⏳\n\n` +
    `Через <b>3 дня</b> (${formatRu(user.paid_until)}) заканчивается подписка.\n\n` +
    'Оплати заранее, чтобы доступ не прерывался. Когда оплатишь — нажми кнопку ниже, ' +
    'и я передам администратору.'
  );
}

export function remind1Day(user) {
  return (
    `<b>${esc(user.name)}</b>, напоминаю: ⏰\n\n` +
    `Подписка заканчивается <b>завтра</b> — ${formatRu(user.paid_until)}.\n\n` +
    'Успей оплатить, иначе доступ отключится. После оплаты нажми кнопку ниже.'
  );
}

export function remindToday(user) {
  return (
    `<b>${esc(user.name)}</b>, подписка заканчивается <b>сегодня</b>! ⚠️\n\n` +
    `Последний день — ${formatRu(user.paid_until)}.\n\n` +
    'Если не оплатить, доступ пропадёт. Оплати и нажми кнопку ниже.'
  );
}

export function remindOverdue(user, overdueDays) {
  return (
    `<b>${esc(user.name)}</b>, подписка просрочена 🔴\n\n` +
    `Срок вышел ${formatRu(user.paid_until)} — уже ${pluralDays(overdueDays)} назад.\n\n` +
    'Доступ может не работать. Оплати, пожалуйста, и нажми кнопку ниже — я сообщу администратору.'
  );
}

// ---------- заявка на оплату ----------

export function claimSent(months) {
  return (
    `✅ Принято: оплата на <b>${pluralMonths(months)}</b>.\n\n` +
    'Отправил заявку администратору. Как только он подтвердит, я пришлю новую дату окончания подписки.\n\n' +
    'Если ошибся с количеством месяцев — просто нажми нужную кнопку ещё раз, я заменю заявку.'
  );
}

export const CLAIM_NO_DATE =
  'Заявка отправлена администратору 📨\n\n' +
  'Правда, у тебя ещё не выставлена дата окончания подписки — администратор внесёт её вручную.';

export function claimConfirmed(months, until) {
  return (
    `🎉 Оплата на <b>${pluralMonths(months)}</b> подтверждена!\n\n` +
    `📅 Подписка активна до: <b>${formatRu(until)}</b>\n\n` +
    'Спасибо! Напомню заранее, когда снова подойдёт срок.'
  );
}

export const CLAIM_REJECTED =
  '❌ Администратор не подтвердил оплату.\n\n' +
  'Если ты точно оплатил — свяжись с ним напрямую и уточни детали. ' +
  'Возможно, платёж просто ещё не дошёл.';

// ---------- админ ----------

export function adminClaimNotice(user, claim) {
  const uname = user.username ? ` (@${esc(user.username)})` : '';
  const current = user.paid_until
    ? `оплачено до ${formatRu(user.paid_until)}`
    : '<i>дата не выставлена</i>';
  return (
    '💰 <b>Заявка на оплату</b>\n\n' +
    `Пользователь: <b>${esc(user.name || 'без имени')}</b>${uname}\n` +
    `ID: <code>${user.tg_id}</code>\n` +
    `Сейчас: ${current}\n` +
    `Заявка: оплата на <b>${pluralMonths(claim.months)}</b>\n\n` +
    'Подтвердить продление?'
  );
}

export function adminClaimResolved(user, claim, from, to) {
  return (
    '✅ <b>Подтверждено</b>\n\n' +
    `${esc(user.name || user.tg_id)} — оплата на ${pluralMonths(claim.months)}.\n` +
    `Было: ${from ? formatRu(from) : '—'}\n` +
    `Стало: <b>${to ? formatRu(to) : '—'}</b>`
  );
}

export function adminClaimRejectedNotice(user, claim) {
  return (
    '❌ <b>Отклонено</b>\n\n' +
    `${esc(user.name || user.tg_id)} — заявка на ${pluralMonths(claim.months)} отклонена. ` +
    'Пользователю отправлено сообщение.'
  );
}

export const ADMIN_HELP =
  '🛠 <b>Админ-панель</b>\n\n' +
  '/users — список пользователей и сроки\n' +
  '/pending — заявки на оплату, ожидающие ответа\n' +
  '/find <i>текст</i> — найти пользователя по имени, @username или ID\n' +
  '/stats — сводка\n' +
  '/audit — последние изменения\n' +
  '/broadcast <i>текст</i> — разослать сообщение всем активным пользователям\n' +
  '/help — эта справка\n\n' +
  'Дату и имя можно менять кнопками в карточке пользователя (открывается из /users).';

export const NOT_ADMIN = 'Эта команда доступна только администратору.';

export const ADMIN_ASK_DATE =
  '📅 Пришли новую дату окончания подписки в формате <b>ДД.ММ.ГГГГ</b>\n' +
  '(например: 15.10.2026)\n\n' +
  'Или /cancel, чтобы отменить.';

export const ADMIN_BAD_DATE =
  '❌ Не понял дату. Нужен формат <b>ДД.ММ.ГГГГ</b>, например 15.10.2026.\n' +
  'Или /cancel для отмены.';

export const ADMIN_ASK_NAME =
  '✏️ Пришли новое имя пользователя одним сообщением (от 2 до 40 символов).\n\n' +
  'Или /cancel, чтобы отменить.';

export const ADMIN_BAD_NAME =
  '❌ Такое имя не подходит (от 2 до 40 символов, без ссылок и команд).\n' +
  'Или /cancel для отмены.';

export const ADMIN_ASK_BROADCAST =
  '📣 Пришли текст рассылки одним сообщением — уйдёт всем активным пользователям ' +
  '(поддерживается HTML-разметка: <b>жирный</b>, <i>курсив</i>).\n\n' +
  'Или /cancel, чтобы отменить.';

export const CANCELLED = 'Отменено.';

export function adminUserCard(user, today, daysLeft) {
  const uname = user.username ? ` (@${esc(user.username)})` : '';
  const { bucket, mark } = daysLeftBucket(user.paid_until ? daysLeft : null);
  const status = {
    none: `${mark} дата не выставлена`,
    overdue: `${mark} просрочено на ${pluralDays(-daysLeft)}`,
    today: `${mark} заканчивается сегодня`,
    soon: `${mark} осталось ${pluralDays(daysLeft)}`,
    ok: `${mark} осталось ${pluralDays(daysLeft)}`,
  }[bucket];

  return (
    `👤 <b>${esc(user.name || 'без имени')}</b>${uname}\n` +
    `ID: <code>${user.tg_id}</code>\n` +
    `Оплачено до: <b>${user.paid_until ? formatRu(user.paid_until) : '—'}</b>\n` +
    `Статус: ${status}\n` +
    (user.is_blocked ? '🚫 Бот заблокирован пользователем\n' : '') +
    (user.is_active ? '' : '📦 В архиве (напоминания отключены)\n')
  );
}

export const NO_USERS = 'Пока никто не зарегистрировался.';
export const NO_PENDING = 'Заявок на оплату нет ✅';

export function statsText(counts, pending, tz, lastRun) {
  return (
    '📊 <b>Сводка</b>\n\n' +
    `Всего пользователей: <b>${counts.total}</b>\n` +
    `Активных: ${counts.active ?? 0}\n` +
    `Без даты подписки: ${counts.without_date ?? 0}\n` +
    `Заявок в ожидании: ${pending}\n\n` +
    `Таймзона напоминаний: <code>${tz}</code>\n` +
    `Последняя проверка: ${lastRun ?? 'ещё не запускалась'}`
  );
}

// ---------- кнопки ----------

export const BTN = {
  myStatus: '📅 Моя подписка',
  paid: '💳 Я оплатил',
  help: 'ℹ️ Помощь',
  months: n => `${n} мес.`,
  back: '⬅️ Назад',
  confirm: '✅ Подтвердить',
  reject: '❌ Отклонить',
  setDate: '📅 Изменить дату',
  setName: '✏️ Изменить имя',
  addMonth: n => `+${n} мес.`,
  archive: '📦 В архив',
  unarchive: '♻️ Вернуть из архива',
  users: '👥 Пользователи',
  pending: '💰 Заявки',
  prev: '⬅️',
  next: '➡️',
};

export const USER_HELP =
  'ℹ️ <b>Как это работает</b>\n\n' +
  '• Я напоминаю об оплате за 3 дня, за день и в день окончания подписки.\n' +
  '• Когда оплатишь — нажми «💳 Я оплатил» и выбери, за сколько месяцев.\n' +
  '• Администратор подтвердит, и я пришлю новую дату.\n\n' +
  '⚠️ Не отключай уведомления от бота — иначе пропустишь напоминание.\n\n' +
  'Команды: /start — меню, /status — моя подписка.';

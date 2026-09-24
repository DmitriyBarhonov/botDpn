/**
 * Клавиатуры и кодирование callback_data.
 *
 * Ограничение Telegram: callback_data — не более 64 БАЙТ (не символов).
 * Поэтому используем короткие латинские префиксы и только цифры в данных.
 * Самый длинный вариант — 'au:1234567890123:0' (18 байт), с запасом.
 *
 * Формат: <действие>:<аргументы через двоеточие>
 *   pay      — пользователь открыл выбор месяцев
 *   pm:<n>   — «я оплатил на n месяцев»
 *   st       — мой статус
 *   uh       — помощь пользователю
 *   cc:<id>  — админ подтверждает заявку id
 *   cr:<id>  — админ отклоняет заявку id
 *   ul:<p>   — список пользователей, страница p
 *   uc:<tg>  — карточка пользователя tg
 *   ud:<tg>  — изменить дату пользователю tg
 *   un:<tg>  — изменить имя пользователю tg
 *   ua:<tg>:<n> — добавить n месяцев пользователю tg
 *   ux:<tg>:<0|1> — архив/восстановить
 *   pl       — список заявок
 *   noop     — неактивная кнопка (например, номер страницы)
 */

import { InlineKeyboard, Keyboard } from 'grammy';
import { BTN } from './lib/texts.js';
import { daysLeftBucket } from './lib/dates.js';

/** Постоянное меню снизу для пользователя. */
export function userMenu() {
  return new Keyboard()
    .text(BTN.myStatus)
    .text(BTN.paid)
    .row()
    .text(BTN.help)
    .resized()
    .persistent();
}

/** Кнопка «Я оплатил» под напоминанием. */
export function paidKeyboard() {
  return new InlineKeyboard().text(BTN.paid, 'pay');
}

/** Выбор количества месяцев: 1..4. */
export function monthsKeyboard() {
  const kb = new InlineKeyboard();
  for (const n of [1, 2, 3, 4]) kb.text(BTN.months(n), `pm:${n}`);
  return kb;
}

/** Кнопки под заявкой в чате админа. */
export function claimKeyboard(claimId) {
  return new InlineKeyboard()
    .text(BTN.confirm, `cc:${claimId}`)
    .text(BTN.reject, `cr:${claimId}`);
}

/** Список пользователей: постранично + переходы в карточки. */
export function usersKeyboard(users, page, pages) {
  const kb = new InlineKeyboard();
  for (const u of users) {
    kb.text(userRowLabel(u), `uc:${u.tg_id}`).row();
  }
  if (pages > 1) {
    if (page > 0) kb.text(BTN.prev, `ul:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, 'noop');
    if (page < pages - 1) kb.text(BTN.next, `ul:${page + 1}`);
  }
  return kb;
}

/** Карточка пользователя в админке. */
export function userCardKeyboard(user, page = 0) {
  const kb = new InlineKeyboard()
    .text(BTN.setDate, `ud:${user.tg_id}`)
    .text(BTN.setName, `un:${user.tg_id}`)
    .row();
  for (const n of [1, 2, 3, 4]) kb.text(BTN.addMonth(n), `ua:${user.tg_id}:${n}`);
  kb.row();
  kb.text(user.is_active ? BTN.archive : BTN.unarchive, `ux:${user.tg_id}:${user.is_active ? 0 : 1}`)
    .row()
    .text(BTN.back, `ul:${page}`);
  return kb;
}

/** Быстрая клавиатура админ-панели. */
export function adminMenuKeyboard() {
  return new InlineKeyboard()
    .text(BTN.users, 'ul:0')
    .text(BTN.pending, 'pl');
}

/** Короткая подпись строки пользователя в списке. */
function userRowLabel(u) {
  const name = truncate(u.name || `id${u.tg_id}`, 18);
  if (!u.paid_until) return `⚪️ ${name} — без даты`;
  const { mark } = daysLeftBucket(u.daysLeft);
  const tail = u.daysLeft < 0 ? `просрочка ${-u.daysLeft}д` : `${u.daysLeft}д`;
  return `${mark} ${name} — ${tail}`;
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/** Проверка, что callback_data укладывается в лимит Telegram. */
export function callbackDataBytes(data) {
  return Buffer.byteLength(data, 'utf8');
}

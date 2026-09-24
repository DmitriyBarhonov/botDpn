/**
 * Тесты. Запуск: npm test
 * Используется встроенный тест-раннер Node (node --test), без зависимостей.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as D from '../src/lib/dates.js';
import * as T from '../src/lib/texts.js';
import * as K from '../src/keyboards.js';
import * as R from '../src/reminders.js';
import { Store } from '../src/lib/db.js';
import { loadConfig } from '../src/config.js';
import { sanitizeName } from '../src/handlers/user.js';
import { parseRuDate } from '../src/handlers/admin.js';

const TZ = 'Europe/Moscow';

// ---------- даты ----------

test('addMonths ограничивает день последним днём месяца', () => {
  // SQLite date('2026-01-31','+1 month') вернул бы 2026-03-03 — это баг,
  // из-за которого клиент получил бы лишние дни.
  assert.equal(D.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(D.addMonths('2026-03-31', 1), '2026-04-30');
  assert.equal(D.addMonths('2026-08-31', 1), '2026-09-30');
  assert.equal(D.addMonths('2024-02-29', 12), '2025-02-28');
  assert.equal(D.addMonths('2026-01-31', 4), '2026-05-31');
  assert.equal(D.addMonths('2026-12-31', 1), '2027-01-31');
  assert.equal(D.addMonths('2026-05-15', 3), '2026-08-15');
});

test('daysBetween считает целые дни, включая переход на летнее время', () => {
  assert.equal(D.daysBetween('2026-09-08', '2026-09-11'), 3);
  assert.equal(D.daysBetween('2026-09-08', '2026-09-08'), 0);
  assert.equal(D.daysBetween('2026-09-08', '2026-09-05'), -3);
  assert.equal(D.daysBetween('2026-03-01', '2026-04-01'), 31);
});

test('isValidDate отвергает несуществующие даты', () => {
  assert.equal(D.isValidDate('2026-02-28'), true);
  assert.equal(D.isValidDate('2024-02-29'), true);
  assert.equal(D.isValidDate('2026-02-29'), false);
  assert.equal(D.isValidDate('2026-02-30'), false);
  assert.equal(D.isValidDate('2026-13-01'), false);
  assert.equal(D.isValidDate('2026-2-8'), false);
  assert.equal(D.isValidDate(''), false);
});

test('склонения числительных', () => {
  assert.equal(D.pluralDays(1), '1 день');
  assert.equal(D.pluralDays(3), '3 дня');
  assert.equal(D.pluralDays(5), '5 дней');
  assert.equal(D.pluralDays(11), '11 дней');
  assert.equal(D.pluralDays(21), '21 день');
  assert.equal(D.pluralMonths(1), '1 месяц');
  assert.equal(D.pluralMonths(2), '2 месяца');
  assert.equal(D.pluralMonths(5), '5 месяцев');
});

test('todayIn возвращает дату в нужной таймзоне', () => {
  assert.match(D.todayIn(TZ), /^\d{4}-\d{2}-\d{2}$/);
});

// ---------- тексты ----------

test('esc не даёт сломать HTML-разметку через имя', () => {
  assert.equal(T.esc('<b>x</b> & "y"'), '&lt;b&gt;x&lt;/b&gt; &amp; "y"');
  assert.ok(!T.nameSaved('<script>alert(1)</script>').includes('<script>'));
});

test('во всех сообщениях только допустимые Telegram-теги', () => {
  const allowed = /^(\/?[bius]|\/?code|\/?pre|a href="[^"]*"|\/a)$/;
  const user = { tg_id: 1, name: 'Иван', username: 'ivan', paid_until: '2026-09-11', is_blocked: 0, is_active: 1 };
  const messages = [
    T.WELCOME, T.USER_HELP, T.ADMIN_HELP,
    T.remind3Days(user), T.remind1Day(user), T.remindToday(user), T.remindOverdue(user, 5),
    T.myStatus(user, '2026-09-08', 3), T.myStatus({ ...user, paid_until: null }, '2026-09-08', null),
    T.adminClaimNotice(user, { months: 2 }), T.adminUserCard(user, '2026-09-08', 3),
    T.claimConfirmed(2, '2026-11-11'), T.claimSent(3), T.CLAIM_REJECTED,
  ];
  for (const msg of messages) {
    for (const [, tag] of msg.matchAll(/<([^>]*)>/g)) {
      assert.ok(allowed.test(tag), `недопустимый тег <${tag}>`);
    }
    assert.ok(msg.length < 4096, 'сообщение длиннее лимита Telegram');
  }
});

test('приветствие содержит просьбу не отключать уведомления', () => {
  assert.match(T.WELCOME, /не отключай/i);
  assert.match(T.WELCOME, /уведомлен/i);
});

// ---------- клавиатуры ----------

test('callback_data укладывается в лимит 64 байта', () => {
  const maxTg = 9999999999;
  const all = [
    'pay', 'pm:4', 'st', 'uh', 'pl', 'noop',
    `cc:${Number.MAX_SAFE_INTEGER}`, `cr:${Number.MAX_SAFE_INTEGER}`,
    'ul:99', `uc:${maxTg}`, `ud:${maxTg}`, `ua:${maxTg}:4`, `ux:${maxTg}:0`,
  ];
  for (const data of all) {
    assert.ok(K.callbackDataBytes(data) <= 64, `${data} длиннее 64 байт`);
  }
});

test('клавиатуры собираются и кнопки валидны', () => {
  const flat = kb => (kb.inline_keyboard || []).flat();
  const users = [
    { tg_id: 1, name: 'Иван', paid_until: '2026-09-11', daysLeft: 3 },
    { tg_id: 2, name: 'ОченьДлинноеИмяКотороеНеПоместится', paid_until: '2026-01-01', daysLeft: -250 },
    { tg_id: 3, name: null, paid_until: null, daysLeft: null },
  ];
  const kbs = [
    K.paidKeyboard(), K.monthsKeyboard(), K.claimKeyboard(12345), K.adminMenuKeyboard(),
    K.userCardKeyboard({ tg_id: 9999999999, is_active: 1 }, 3),
    K.usersKeyboard(users, 0, 3), K.usersKeyboard(users, 1, 3), K.usersKeyboard(users, 2, 3),
  ];
  for (const kb of kbs) {
    const buttons = flat(kb);
    assert.ok(buttons.length > 0);
    for (const b of buttons) {
      assert.ok(b.text.length <= 64, `подпись слишком длинная: ${b.text}`);
      if (b.callback_data) assert.ok(K.callbackDataBytes(b.callback_data) <= 64);
    }
  }
  assert.equal(K.monthsKeyboard().inline_keyboard.flat().length, 4);
});

// ---------- валидация ввода ----------

test('sanitizeName пропускает имена и отсекает мусор', () => {
  assert.equal(sanitizeName('Иван'), 'Иван');
  assert.equal(sanitizeName('  Иван   Петров '), 'Иван Петров');
  assert.equal(sanitizeName('Иван\nПетров'), 'Иван Петров');
  assert.equal(sanitizeName('Анна-Мария'), 'Анна-Мария');
  assert.equal(sanitizeName('José'), 'José');
  assert.equal(sanitizeName('/start'), null);
  assert.equal(sanitizeName('И'), null);
  assert.equal(sanitizeName('я'.repeat(41)), null);
  assert.equal(sanitizeName('12345'), null);
  assert.equal(sanitizeName('http://spam.com'), null);
  assert.equal(sanitizeName('t.me/spam'), null);
  assert.equal(sanitizeName('@spamchannel'), null);
  assert.equal(sanitizeName(''), null);
  assert.equal(sanitizeName(null), null);
});

test('parseRuDate понимает ДД.ММ.ГГГГ и ISO, отвергает неверные даты', () => {
  assert.equal(parseRuDate('15.10.2026'), '2026-10-15');
  assert.equal(parseRuDate('5.1.2027'), '2027-01-05');
  assert.equal(parseRuDate('15/10/2026'), '2026-10-15');
  assert.equal(parseRuDate('2026-10-15'), '2026-10-15');
  assert.equal(parseRuDate('29.02.2024'), '2024-02-29');
  assert.equal(parseRuDate('29.02.2026'), null);
  assert.equal(parseRuDate('31.02.2026'), null);
  assert.equal(parseRuDate('15.13.2026'), null);
  assert.equal(parseRuDate('15.10.26'), null);
  assert.equal(parseRuDate('завтра'), null);
});

// ---------- конфигурация ----------

test('loadConfig проверяет обязательные значения', () => {
  const good = { BOT_TOKEN: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', ADMIN_ID: '987654321' };
  const cfg = loadConfig(good);
  assert.equal(cfg.adminId, 987654321);
  assert.equal(cfg.timeZone, 'Europe/Moscow');
  assert.equal(cfg.remindHour, 12);

  assert.throws(() => loadConfig({}), /BOT_TOKEN/);
  assert.throws(() => loadConfig({ ...good, BOT_TOKEN: 'мусор' }), /BOT_TOKEN/);
  assert.throws(() => loadConfig({ ...good, ADMIN_ID: 'abc' }), /ADMIN_ID/);
  assert.throws(() => loadConfig({ ...good, TZ_NAME: 'Mars/Olympus' }), /TZ_NAME/);
  assert.throws(() => loadConfig({ ...good, REMIND_HOUR: '25' }), /REMIND_HOUR/);
});

// ---------- база данных ----------

function seed() {
  const store = new Store(':memory:');
  const add = (id, name, until) => {
    store.upsertUser(id, name);
    store.setState(id, 'awaiting_name');
    store.setName(id, name);
    if (until) store.setPaidUntil(id, until, 1);
  };
  return { store, add };
}

test('повторный /start не создаёт дубликат и не теряет имя', () => {
  const { store } = seed();
  store.upsertUser(1, 'ivan');
  store.setState(1, 'awaiting_name');
  store.setName(1, 'Иван');
  store.upsertUser(1, 'ivan_renamed');
  assert.equal(store.listUsers().length, 1);
  assert.equal(store.getUser(1).name, 'Иван');
  assert.equal(store.getUser(1).username, 'ivan_renamed');
});

test('многократные нажатия «Я оплатил» дают одну активную заявку', () => {
  const { store, add } = seed();
  add(1, 'Иван', '2026-09-11');
  const first = store.createClaim(1, 4);
  const second = store.createClaim(1, 1);
  assert.equal(store.listPendingClaims().length, 1);
  assert.equal(store.getClaim(first.id).status, 'superseded');
  assert.equal(second.superseded, first.id);
});

test('двойное подтверждение не продлевает подписку дважды', () => {
  const { store, add } = seed();
  const until = D.addDays(D.todayIn(TZ), 30);
  add(1, 'Иван', until);
  const claim = store.createClaim(1, 1);
  const first = store.confirmClaim(claim.id, TZ, 99);
  const second = store.confirmClaim(claim.id, TZ, 99);
  const expected = D.addMonths(until, 1);
  assert.equal(first.ok, true);
  assert.equal(first.to, expected);
  assert.equal(second.ok, false);
  assert.equal(second.already, true);
  assert.equal(store.getUser(1).paid_until, expected);
});

test('просроченная подписка продлевается от сегодня, а не от прошлой даты', () => {
  const { store, add } = seed();
  add(1, 'Иван', '2020-01-01');
  const claim = store.createClaim(1, 1);
  const result = store.confirmClaim(claim.id, TZ, 99);
  const expected = D.addMonths(D.todayIn(TZ), 1);
  assert.equal(result.to, expected);
});

test('подтверждение заявки без выставленной даты не назначает дату автоматически', () => {
  // Пользователь нажал «Я оплатил» до того, как админ хоть раз вручную
  // выставил дату подписки. Раньше confirmClaim молча брал сегодняшний день
  // как базу — это в обход требования «админ выставляет первую дату сам».
  const { store } = seed();
  store.upsertUser(1, 'ivan');
  store.setState(1, 'awaiting_name');
  store.setName(1, 'Иван'); // paid_until остаётся NULL — админ ещё ничего не вводил

  const claim = store.createClaim(1, 2);
  const result = store.confirmClaim(claim.id, TZ, 99);

  assert.equal(result.ok, false);
  assert.equal(result.needsDate, true);
  assert.equal(store.getUser(1).paid_until, null, 'дата не должна была появиться сама');

  // Заявка остаётся pending — её можно подтвердить после того, как
  // админ вручную выставит дату.
  assert.equal(store.getClaim(claim.id).status, 'pending');

  const until = D.addDays(D.todayIn(TZ), 30);
  store.setPaidUntil(1, until, 99, 'set_date');
  const second = store.confirmClaim(claim.id, TZ, 99);
  assert.equal(second.ok, true);
  assert.equal(second.to, D.addMonths(until, 2));
});

test('отклонение заявки не меняет дату и повторно не срабатывает', () => {
  const { store, add } = seed();
  add(1, 'Иван', '2026-09-11');
  const claim = store.createClaim(1, 2);
  assert.equal(store.rejectClaim(claim.id, 99).ok, true);
  assert.equal(store.rejectClaim(claim.id, 99).ok, false);
  assert.equal(store.getUser(1).paid_until, '2026-09-11');
});

test('количество месяцев ограничено диапазоном 1..4', () => {
  const { store, add } = seed();
  add(1, 'Иван', '2026-09-11');
  assert.throws(() => store.createClaim(1, 9));
  assert.throws(() => store.createClaim(1, 0));
});

test('слот напоминания занимается один раз', () => {
  const { store } = seed();
  assert.equal(store.claimNotification(1, 'd3', '2026-09-11', '2026-09-08'), true);
  assert.equal(store.claimNotification(1, 'd3', '2026-09-11', '2026-09-08'), false);
  store.releaseNotification(1, 'd3', '2026-09-11', '2026-09-08');
  assert.equal(store.claimNotification(1, 'd3', '2026-09-11', '2026-09-08'), true);
  // другой вид напоминания и другая дата — отдельные слоты
  assert.equal(store.claimNotification(1, 'd1', '2026-09-11', '2026-09-08'), true);
  assert.equal(store.claimNotification(1, 'd3', '2026-10-11', '2026-09-08'), true);
});

test('список пользователей сортируется по близости срока, без даты — в конце', () => {
  const { store, add } = seed();
  add(1, 'Дальний', '2027-01-01');
  add(2, 'Близкий', '2026-09-10');
  store.upsertUser(3, 'nodate');
  const list = store.listUsers({ activeOnly: false });
  assert.equal(list[0].tg_id, 2);
  assert.equal(list[1].tg_id, 1);
  assert.equal(list[2].paid_until, null);
});

// ---------- логика напоминаний ----------

test('напоминание выбирается только за 3, 1 и 0 дней и при просрочке', () => {
  const kind = (today, until) => {
    const r = R.pickReminder({ tg_id: 1, name: 'Иван', paid_until: until }, today);
    return r ? r.kind : null;
  };
  assert.equal(kind('2026-09-08', '2026-09-11'), 'd3');
  assert.equal(kind('2026-09-08', '2026-09-09'), 'd1');
  assert.equal(kind('2026-09-08', '2026-09-08'), 'd0');
  assert.equal(kind('2026-09-08', '2026-09-01'), 'overdue');
  assert.equal(kind('2026-09-08', '2026-09-10'), null); // за 2 дня молчим
  assert.equal(kind('2026-09-08', '2026-09-12'), null); // за 4 дня молчим
  assert.equal(kind('2026-09-08', '2027-01-01'), null);
});

test('isBlockedError отличает блокировку от временной ошибки', () => {
  assert.equal(R.isBlockedError({ error_code: 403, description: 'Forbidden: bot was blocked by the user' }), true);
  assert.equal(R.isBlockedError({ description: 'Bad Request: chat not found' }), true);
  assert.equal(R.isBlockedError({ description: 'Forbidden: user is deactivated' }), true);
  assert.equal(R.isBlockedError({ error_code: 429, description: 'Too Many Requests: retry after 5' }), false);
  assert.equal(R.isBlockedError({ error_code: 500, description: 'Internal Server Error' }), false);
  assert.equal(R.isBlockedError(new Error('socket hang up')), false);
});

test('рассылка: получают только нужные, перезапуск не дублирует', async () => {
  const { store, add } = seed();
  const today = D.todayIn(TZ);
  add(1, 'Через3дня', D.addDays(today, 3));
  add(2, 'Завтра', D.addDays(today, 1));
  add(3, 'Сегодня', today);
  add(4, 'Просрочен', D.addDays(today, -5));
  add(5, 'Через2дня', D.addDays(today, 2));
  add(6, 'Далеко', D.addDays(today, 30));
  store.upsertUser(7, 'nodate');
  add(8, 'Заблокировал', D.addDays(today, 3));
  add(9, 'Архивный', D.addDays(today, 3));
  store.setActive(9, false, 1);

  const sent = [];
  const bot = {
    api: {
      sendMessage: async id => {
        if (id === 8) {
          const err = new Error('Forbidden: bot was blocked by the user');
          err.error_code = 403;
          throw err;
        }
        sent.push(id);
      },
    },
  };

  const first = await R.runDailyCheck({ store, bot, timeZone: TZ, log: () => {} });
  assert.deepEqual(sent.sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(first.sent, 4);
  assert.equal(first.blocked, 1);
  assert.equal(store.getUser(8).is_blocked, 1);

  // Перезапуск процесса в тот же день не должен отправить ничего повторно.
  sent.length = 0;
  const second = await R.runDailyCheck({ store, bot, timeZone: TZ, log: () => {} });
  assert.equal(sent.length, 0);
  // 4 успешных + 1 заблокированный: его слот намеренно не откатывается.
  assert.equal(second.skipped, 5);
  assert.equal(second.sent, 0);
});

test('после возврата из архива пользователь снова получает напоминания', async () => {
  const { store, add } = seed();
  const today = D.todayIn(TZ);
  add(1, 'Иван', D.addDays(today, 3));
  store.setActive(1, false, 1); // в архив — как это делает кнопка в карточке

  const sent = [];
  const bot = { api: { sendMessage: async id => { sent.push(id); } } };

  const whileArchived = await R.runDailyCheck({ store, bot, timeZone: TZ, log: () => {} });
  assert.equal(whileArchived.sent, 0, 'в архиве напоминание не отправляется');
  assert.equal(sent.length, 0);

  store.setActive(1, true, 1); // возврат из архива
  const afterReturn = await R.runDailyCheck({ store, bot, timeZone: TZ, log: () => {} });
  assert.equal(afterReturn.sent, 1, 'после возврата из архива напоминание должно уйти');
  assert.deepEqual(sent, [1]);
});

test('временная ошибка откатывает слот и позволяет повторить позже', async () => {
  const { store, add } = seed();
  const today = D.todayIn(TZ);
  add(1, 'Иван', D.addDays(today, 3));

  let failing = true;
  const sent = [];
  const bot = {
    api: {
      sendMessage: async id => {
        if (failing) {
          const err = new Error('Internal Server Error');
          err.error_code = 500;
          throw err;
        }
        sent.push(id);
      },
    },
  };

  const first = await R.runDailyCheck({ store, bot, timeZone: TZ, log: () => {} });
  assert.equal(first.failed, 1);
  assert.equal(first.sent, 0);

  failing = false;
  const second = await R.runDailyCheck({ store, bot, timeZone: TZ, log: () => {} });
  assert.deepEqual(sent, [1]);
  assert.equal(second.sent, 1);
});

test('догоняющий запуск выполняется один раз в день', async () => {
  const { store, add } = seed();
  const today = D.todayIn(TZ);
  add(1, 'Иван', D.addDays(today, 3));
  const bot = { api: { sendMessage: async () => {} } };

  const first = await R.catchUpOnStartup({ store, bot, timeZone: TZ, log: () => {} });
  assert.ok(first, 'первый запуск должен выполниться');
  assert.equal(first.sent, 1);

  // Повторный старт процесса в тот же день — проверка не нужна.
  const second = await R.catchUpOnStartup({ store, bot, timeZone: TZ, log: () => {} });
  assert.equal(second, null);
});

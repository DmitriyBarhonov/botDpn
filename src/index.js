/**
 * Точка входа. Запуск: node --env-file=.env src/index.js
 *
 * Что здесь происходит:
 *  1. читаем и проверяем конфигурацию;
 *  2. открываем базу (создаётся автоматически при первом запуске);
 *  3. регистрируем обработчики: сначала админские, потом пользовательские;
 *  4. навёрстываем пропущенную проверку, если VPS был выключен в час X;
 *  5. ставим ежедневную задачу через croner (таймзона задаётся явно);
 *  6. корректно закрываемся по SIGINT/SIGTERM.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Bot, GrammyError, HttpError } from 'grammy';
import { Cron } from 'croner';

import { loadConfig } from './config.js';
import { Store } from './lib/db.js';
import { registerUserHandlers } from './handlers/user.js';
import { registerAdminHandlers } from './handlers/admin.js';
import { runDailyCheck, catchUpOnStartup } from './reminders.js';
import * as T from './lib/texts.js';

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args);

async function main() {
  const config = loadConfig();

  // Каталог для файла базы может ещё не существовать.
  mkdirSync(dirname(config.dbFile), { recursive: true });

  const store = new Store(config.dbFile);
  log(`база: ${config.dbFile}`);

  const bot = new Bot(config.token);
  const deps = { store, adminId: config.adminId, timeZone: config.timeZone, log };

  // Админские обработчики регистрируем первыми: они возвращают функцию
  // разбора текста (ввод даты), которую нужно вызвать раньше,
  // чем пользовательский обработчик message:text перехватит сообщение.
  const handleAdminText = registerAdminHandlers(bot, deps);

  bot.on('message:text', async (ctx, next) => {
    if (handleAdminText(ctx)) return; // админ вводит дату — дальше не пропускаем
    await next();
  });

  registerUserHandlers(bot, deps);

  // Единый обработчик ошибок: бот не должен падать из-за одного апдейта.
  bot.catch(err => {
    const ctx = err.ctx;
    const where = `update ${ctx?.update?.update_id ?? '?'}`;
    if (err.error instanceof GrammyError) {
      log(`ошибка Telegram API (${where}): ${err.error.description}`);
    } else if (err.error instanceof HttpError) {
      log(`сеть недоступна (${where}): ${err.error.message}`);
    } else {
      log(`ошибка (${where}):`, err.error);
    }
  });

  // Меню команд: пользователю — короткое, админу — расширенное.
  await bot.api.setMyCommands([
    { command: 'start', description: 'Начать' },
    { command: 'status', description: 'Моя подписка' },
    { command: 'help', description: 'Помощь' },
  ]);
  await bot.api
    .setMyCommands(
      [
        { command: 'users', description: 'Пользователи и сроки' },
        { command: 'pending', description: 'Заявки на оплату' },
        { command: 'find', description: 'Найти пользователя' },
        { command: 'stats', description: 'Сводка' },
        { command: 'audit', description: 'Журнал изменений' },
        { command: 'runcheck', description: 'Проверить подписки сейчас' },
        { command: 'help', description: 'Справка админа' },
      ],
      { scope: { type: 'chat', chat_id: config.adminId } }
    )
    .catch(err => log(`не удалось задать команды админа: ${err.message}`));

  const me = await bot.api.getMe();
  log(`бот @${me.username} (id ${me.id}) запускается`);

  // Задача-обёртка: croner по умолчанию НЕ ловит ошибки внутри колбэка
  // (catch: false), а непойманная ошибка в async-функции способна
  // уронить процесс. Поэтому оборачиваем сами.
  const dailyJob = async () => {
    try {
      await runDailyCheck({ store, bot, timeZone: config.timeZone, log });
    } catch (err) {
      log('ошибка ежедневной проверки:', err);
    }
  };

  const pattern = `0 ${config.remindMinute} ${config.remindHour} * * *`;
  const job = new Cron(pattern, { timezone: config.timeZone, catch: true, name: 'daily' }, dailyJob);
  log(
    `ежедневная проверка в ${pad(config.remindHour)}:${pad(config.remindMinute)} ` +
      `(${config.timeZone}); следующий запуск: ${job.nextRun()?.toISOString()}`
  );

  // Навёрстываем пропущенный день: cron-библиотеки не выполняют
  // пропущенный запуск, а VPS мог быть выключен в этот момент.
  // Проходит через тот же UNIQUE-guard, поэтому гонка с обычным
  // запуском в час X не приведёт к дублю.
  try {
    await catchUpOnStartup({ store, bot, timeZone: config.timeZone, log });
  } catch (err) {
    log('ошибка догоняющего запуска:', err);
  }

  // Сообщаем админу, что бот поднялся (полезно после перезагрузки VPS).
  await bot.api
    .sendMessage(
      config.adminId,
      `🤖 Бот запущен.\n\nПроверка подписок: ежедневно в ${pad(config.remindHour)}:${pad(
        config.remindMinute
      )} (${config.timeZone}).\n\n${T.ADMIN_HELP}`,
      { parse_mode: 'HTML' }
    )
    .catch(err => log(`не удалось написать админу: ${err.message} (нажми /start у бота)`));

  // Корректное завершение: сначала останавливаем приём апдейтов,
  // затем cron, затем закрываем базу.
  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    log(`получен ${signal}, останавливаюсь…`);
    job.stop();
    try {
      await bot.stop();
    } catch (err) {
      log('ошибка остановки бота:', err.message);
    }
    store.close();
    log('остановлен');
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // start() не завершается, пока бот работает.
  await bot.start({
    drop_pending_updates: false,
    onStart: info => log(`приём сообщений начат (@${info.username})`),
  });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

main().catch(err => {
  console.error('\n❌ Не удалось запустить бота:\n');
  console.error(err.message ?? err);
  process.exit(1);
});

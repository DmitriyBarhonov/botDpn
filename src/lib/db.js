/**
 * Слой базы данных (SQLite через better-sqlite3, синхронный API).
 *
 * Ключевые решения:
 *  - даты хранятся как TEXT 'YYYY-MM-DD' (календарный день);
 *  - WAL включён — быстрее и безопаснее при внезапном перезапуске;
 *  - идемпотентность напоминаний обеспечивается UNIQUE-индексом
 *    в таблице sent_notifications, а не проверками в коде;
 *  - миграции идемпотентны: CREATE TABLE IF NOT EXISTS + PRAGMA user_version.
 */

import Database from 'better-sqlite3';
import { addMonths, todayIn } from './dates.js';

const SCHEMA_VERSION = 1;

export class Store {
  /** @param {string} file путь к файлу базы, например './data/bot.db' */
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    // Ждать до 5 секунд, если файл занят другим процессом, вместо ошибки SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.#migrate();
  }

  #migrate() {
    const current = this.db.pragma('user_version', { simple: true });
    if (current >= SCHEMA_VERSION) return;

    this.db.exec(`
      -- Пользователи бота.
      CREATE TABLE IF NOT EXISTS users (
        tg_id        INTEGER PRIMARY KEY,          -- telegram user id
        username     TEXT,                          -- @username на момент последнего /start (может быть NULL)
        name         TEXT,                          -- имя, которое пользователь ввёл сам
        state        TEXT NOT NULL DEFAULT 'new',   -- 'new' | 'awaiting_name' | 'ready'
        paid_until   TEXT,                          -- 'YYYY-MM-DD', NULL пока админ не выставил дату
        is_blocked   INTEGER NOT NULL DEFAULT 0,    -- 1, если бот заблокирован пользователем
        is_active    INTEGER NOT NULL DEFAULT 1,    -- 0 = архив, напоминания не отправляются
        created_at   TEXT NOT NULL,                 -- ISO-8601 UTC
        updated_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_paid_until
        ON users(paid_until) WHERE is_active = 1;

      -- Заявки «я оплатил», ожидающие подтверждения админом.
      CREATE TABLE IF NOT EXISTS claims (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        tg_id         INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
        months        INTEGER NOT NULL CHECK (months BETWEEN 1 AND 4),
        status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','confirmed','rejected','superseded')),
        created_at    TEXT NOT NULL,
        resolved_at   TEXT,
        paid_until_before TEXT,                     -- дата до продления (для истории/откатa)
        paid_until_after  TEXT                      -- дата после продления
      );

      -- Не более одной ожидающей заявки на пользователя: защита от многократных нажатий.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_claims_one_pending
        ON claims(tg_id) WHERE status = 'pending';

      CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status, created_at);

      -- Журнал отправленных напоминаний. UNIQUE не даёт отправить повторно
      -- после перезапуска процесса.
      CREATE TABLE IF NOT EXISTS sent_notifications (
        tg_id      INTEGER NOT NULL,
        kind       TEXT NOT NULL,      -- 'd3' | 'd1' | 'd0' | 'overdue'
        due_date   TEXT NOT NULL,      -- paid_until, к которому относится напоминание
        sent_on    TEXT NOT NULL,      -- дата отправки 'YYYY-MM-DD' (в таймзоне бота)
        PRIMARY KEY (tg_id, kind, due_date, sent_on)
      );

      -- Служебные значения: дата последнего запуска ежедневной задачи и т.п.
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Журнал действий админа — чтобы можно было понять, кто и когда менял дату.
      CREATE TABLE IF NOT EXISTS audit (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        at         TEXT NOT NULL,
        actor      INTEGER,            -- tg_id админа
        action     TEXT NOT NULL,
        tg_id      INTEGER,            -- к кому применено
        details    TEXT
      );
    `);

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  close() {
    this.db.close();
  }

  // ---------- users ----------

  /** Создаёт пользователя, если его нет. Возвращает актуальную запись. */
  upsertUser(tgId, username) {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO users (tg_id, username, state, created_at, updated_at)
         VALUES (?, ?, 'new', ?, ?)
         ON CONFLICT(tg_id) DO UPDATE SET
           username   = excluded.username,
           is_blocked = 0,
           updated_at = excluded.updated_at`
      )
      .run(tgId, username ?? null, now, now);
    return this.getUser(tgId);
  }

  getUser(tgId) {
    return this.db.prepare('SELECT * FROM users WHERE tg_id = ?').get(tgId) ?? null;
  }

  setState(tgId, state) {
    this.db
      .prepare('UPDATE users SET state = ?, updated_at = ? WHERE tg_id = ?')
      .run(state, nowIso(), tgId);
  }

  setName(tgId, name) {
    this.db
      .prepare(`UPDATE users SET name = ?, state = 'ready', updated_at = ? WHERE tg_id = ?`)
      .run(name, nowIso(), tgId);
  }

  setPaidUntil(tgId, date, actor = null, action = 'set_date') {
    const before = this.getUser(tgId)?.paid_until ?? null;
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE users SET paid_until = ?, updated_at = ? WHERE tg_id = ?')
        .run(date, nowIso(), tgId);
      this.#audit(actor, action, tgId, `${before ?? '—'} -> ${date}`);
    })();
  }

  /** Админ меняет имя пользователя вручную (отдельно от setName при онбординге). */
  renameUser(tgId, name, actor = null) {
    const before = this.getUser(tgId)?.name ?? null;
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE users SET name = ?, updated_at = ? WHERE tg_id = ?`)
        .run(name, nowIso(), tgId);
      this.#audit(actor, 'rename', tgId, `${before ?? '—'} -> ${name}`);
    })();
  }

  setBlocked(tgId, blocked) {
    this.db
      .prepare('UPDATE users SET is_blocked = ?, updated_at = ? WHERE tg_id = ?')
      .run(blocked ? 1 : 0, nowIso(), tgId);
  }

  setActive(tgId, active, actor = null) {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE users SET is_active = ?, updated_at = ? WHERE tg_id = ?')
        .run(active ? 1 : 0, nowIso(), tgId);
      this.#audit(actor, active ? 'activate' : 'archive', tgId, null);
    })();
  }

  /** Все пользователи, отсортированные: сначала те, у кого срок ближе. */
  listUsers({ activeOnly = true } = {}) {
    const where = activeOnly ? 'WHERE is_active = 1' : '';
    return this.db
      .prepare(
        `SELECT * FROM users ${where}
         ORDER BY paid_until IS NULL, paid_until ASC, tg_id ASC`
      )
      .all();
  }

  countUsers() {
    return this.db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(is_active = 1) AS active,
           SUM(paid_until IS NULL AND is_active = 1) AS without_date
         FROM users`
      )
      .get();
  }

  /** Пользователи с выставленной датой, кому нужно проверить напоминания. */
  listForReminders() {
    return this.db
      .prepare(
        `SELECT * FROM users
         WHERE is_active = 1 AND paid_until IS NOT NULL AND state = 'ready'
         ORDER BY paid_until ASC`
      )
      .all();
  }

  // ---------- claims ----------

  /**
   * Создаёт заявку. Если у пользователя уже есть ожидающая заявка,
   * она помечается 'superseded' — админ видит только последнюю.
   * @returns {{id:number, superseded:number|null}}
   */
  createClaim(tgId, months) {
    return this.db.transaction(() => {
      const prev = this.db
        .prepare(`SELECT id FROM claims WHERE tg_id = ? AND status = 'pending'`)
        .get(tgId);
      if (prev) {
        this.db
          .prepare(`UPDATE claims SET status = 'superseded', resolved_at = ? WHERE id = ?`)
          .run(nowIso(), prev.id);
      }
      const info = this.db
        .prepare(
          `INSERT INTO claims (tg_id, months, status, created_at, paid_until_before)
           VALUES (?, ?, 'pending', ?, (SELECT paid_until FROM users WHERE tg_id = ?))`
        )
        .run(tgId, months, nowIso(), tgId);
      return { id: Number(info.lastInsertRowid), superseded: prev?.id ?? null };
    })();
  }

  getClaim(id) {
    return this.db
      .prepare(
        `SELECT c.*, u.name, u.username, u.paid_until
         FROM claims c JOIN users u ON u.tg_id = c.tg_id
         WHERE c.id = ?`
      )
      .get(id) ?? null;
  }

  listPendingClaims() {
    return this.db
      .prepare(
        `SELECT c.*, u.name, u.username, u.paid_until
         FROM claims c JOIN users u ON u.tg_id = c.tg_id
         WHERE c.status = 'pending'
         ORDER BY c.created_at ASC`
      )
      .all();
  }

  /**
   * Подтверждает заявку и продлевает подписку — атомарно и идемпотентно.
   * Повторное нажатие «Подтвердить» вернёт already:true и НЕ продлит второй раз.
   *
   * Если админ ещё ни разу не выставил дату вручную (paid_until IS NULL),
   * заявка НЕ подтверждается — иначе первая дата подписки назначалась бы
   * автоматически от сегодня, в обход требования «админ выставляет дату сам».
   * Возвращает needsDate:true, чтобы вызывающий код показал админу нужное действие.
   *
   * База отсчёта для продления: если подписка ещё активна — от paid_until,
   * если уже истекла — от сегодняшнего дня (чтобы не дарить прошедшие дни).
   *
   * @returns {{ok:boolean, already?:boolean, needsDate?:boolean, claim?:object, from?:string, to?:string}}
   */
  confirmClaim(id, timeZone, actor = null) {
    return this.db.transaction(() => {
      const claim = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
      if (!claim) return { ok: false };
      if (claim.status !== 'pending') {
        return { ok: false, already: true, claim };
      }

      const user = this.getUser(claim.tg_id);
      if (!user?.paid_until) {
        return { ok: false, needsDate: true, claim, user };
      }

      const today = todayIn(timeZone);
      const base = user.paid_until >= today ? user.paid_until : today;
      const next = addMonths(base, claim.months);

      this.db
        .prepare('UPDATE users SET paid_until = ?, updated_at = ? WHERE tg_id = ?')
        .run(next, nowIso(), claim.tg_id);
      this.db
        .prepare(
          `UPDATE claims SET status = 'confirmed', resolved_at = ?,
             paid_until_before = ?, paid_until_after = ?
           WHERE id = ? AND status = 'pending'`
        )
        .run(nowIso(), user.paid_until, next, id);
      this.#audit(actor, 'confirm_claim', claim.tg_id, `+${claim.months} мес: ${base} -> ${next}`);

      return { ok: true, claim, from: user.paid_until, to: next };
    })();
  }

  /** Отклоняет заявку. Идемпотентно. */
  rejectClaim(id, actor = null) {
    return this.db.transaction(() => {
      const claim = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id);
      if (!claim) return { ok: false };
      if (claim.status !== 'pending') return { ok: false, already: true, claim };
      this.db
        .prepare(`UPDATE claims SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'`)
        .run(nowIso(), id);
      this.#audit(actor, 'reject_claim', claim.tg_id, `${claim.months} мес`);
      return { ok: true, claim };
    })();
  }

  // ---------- напоминания (идемпотентность) ----------

  /**
   * Пытается «занять» отправку напоминания. Возвращает true, если это
   * первая попытка (и напоминание нужно отправить), false — если уже отправляли.
   * Запись делается ДО отправки: лучше пропустить одно напоминание,
   * чем спамить пользователя в цикле перезапусков.
   */
  claimNotification(tgId, kind, dueDate, sentOn) {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO sent_notifications (tg_id, kind, due_date, sent_on)
         VALUES (?, ?, ?, ?)`
      )
      .run(tgId, kind, dueDate, sentOn);
    return info.changes === 1;
  }

  /** Откатывает «занятую» отправку, если Telegram вернул ошибку. */
  releaseNotification(tgId, kind, dueDate, sentOn) {
    this.db
      .prepare(
        `DELETE FROM sent_notifications
         WHERE tg_id = ? AND kind = ? AND due_date = ? AND sent_on = ?`
      )
      .run(tgId, kind, dueDate, sentOn);
  }

  // ---------- meta ----------

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, String(value));
  }

  // ---------- audit ----------

  #audit(actor, action, tgId, details) {
    this.db
      .prepare('INSERT INTO audit (at, actor, action, tg_id, details) VALUES (?, ?, ?, ?, ?)')
      .run(nowIso(), actor, action, tgId, details);
  }

  listAudit(limit = 20) {
    return this.db
      .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
      .all(limit);
  }
}

function nowIso() {
  return new Date().toISOString();
}

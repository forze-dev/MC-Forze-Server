import cron from 'node-cron';
import { pool } from './db.service.js';
import { Telegraf } from 'telegraf';
import 'dotenv/config';

// Ініціалізуємо бота лише для відправки повідомлень
const bot = new Telegraf(process.env.BOT_TOKEN);
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;

// Винагороди для топ-5 учасників (в ігровій валюті)
const REWARDS = {
	1: 30,
	2: 25,
	3: 20,
	4: 15,
	5: 10
};

/**
 * Отримати топ N активних користувачів за день
 * @param {number} limit Кількість користувачів у топі
 * @returns {Promise<Array>} Масив користувачів
 */
async function getTopActiveUsers(limit = 10) {
	const conn = await pool.getConnection();

	try {
		// Отримати топ-N користувачів за кількістю повідомлень
		const [topUsers] = await conn.query(`
            SELECT u.telegram_id, u.minecraft_nick, u.messages_count 
            FROM users u 
            WHERE u.messages_count > 0 
            ORDER BY u.messages_count DESC 
            LIMIT ?
        `, [limit]);

		return topUsers;
	} catch (error) {
		console.error('❌ Помилка отримання топ активних користувачів:', error);
		return [];
	} finally {
		conn.release();
	}
}

/**
 * Нарахувати винагороди топ користувачам
 * @param {Array} topUsers Масив топ користувачів
 * @returns {Promise<boolean>} Результат операції
 */
async function awardTopUsers(topUsers) {
	if (!topUsers.length) return false;

	const conn = await pool.getConnection();
	const now = Math.floor(Date.now() / 1000);

	try {
		await conn.beginTransaction();

		// Масив для зберігання результатів нагородження
		const awardResults = [];

		// Нараховуємо нагороди для перших 5 місць (або менше, якщо користувачів менше)
		for (let i = 0; i < Math.min(topUsers.length, 5); i++) {
			const position = i + 1;
			const user = topUsers[i];
			const reward = REWARDS[position];

			// Оновлюємо баланс користувача
			await conn.query(`
                UPDATE users 
                SET game_balance = game_balance + ?, 
                    updated_at = ? 
                WHERE telegram_id = ?
            `, [reward, now, user.telegram_id]);

			awardResults.push({
				position,
				minecraft_nick: user.minecraft_nick,
				messages_count: user.messages_count,
				reward
			});
		}

		// Скидаємо лічильники повідомлень для ВСІХ користувачів
		await conn.query(`
            UPDATE users 
            SET messages_count = 0, 
                updated_at = ? 
            WHERE messages_count > 0
        `, [now]);

		await conn.commit();
		return awardResults;
	} catch (error) {
		await conn.rollback();
		console.error('❌ Помилка нарахування винагород:', error);
		return false;
	} finally {
		conn.release();
	}
}

/**
 * Форматує повідомлення зі статистикою та нагородами
 * @param {Array} topUsers Масив топ користувачів
 * @param {Array} awardResults Результати нарахування нагород
 * @returns {string} Відформатоване повідомлення
 */
function formatSheduleReport(topUsers, awardResults) {
	// Заголовок звіту
	let message = `📊 *Підсумки по чату за останні 24 години (топ ${topUsers.length})*\n\n`;

	// Статистика повідомлень
	topUsers.forEach((user, index) => {
		message += `${index + 1}. *${user.minecraft_nick}* — ${user.messages_count} смс\n`;
	});

	// Секція нагород, якщо є результати
	if (awardResults && awardResults.length > 0) {
		message += `\n🏆 *Нагороди:*\n`;
		awardResults.forEach(award => {
			message += `${award.position} місце (*${award.minecraft_nick}*): +${award.reward} GFC\n`;
		});

		message += `\n💰 Вітаємо переможців! Нагороди вже зараховано на ваші ігрові рахунки!`;
		message += `\n📝 Лічильники смс скинуто. Новий день — нові можливості!`;
	}

	return message;
}

/**
 * Запускає щоденне підведення підсумків та нагородження
 */
async function runSheduleReport() {
	console.log('🔄 Запуск щоденного звіту активності...');

	try {
		// 1. Отримуємо топ-10 користувачів
		const topUsers = await getTopActiveUsers(10);
		if (!topUsers.length) {
			console.log('📨 Немає активних користувачів за останні 24 години');
			return;
		}

		console.log(`📨 Отримано топ-${topUsers.length} користувачів`);

		// 2. Нараховуємо нагороди
		const awardResults = await awardTopUsers(topUsers);

		// 3. Форматуємо та відправляємо повідомлення в чат
		const reportMessage = formatSheduleReport(topUsers, awardResults);

		// Відправляємо в чат
		if (TARGET_CHAT_ID) {
			await bot.telegram.sendMessage(TARGET_CHAT_ID, reportMessage, { parse_mode: 'Markdown' });
			console.log('✅ Звіт успішно відправлено в чат');
		} else {
			console.error('❌ Не вказано TARGET_CHAT_ID для відправки звіту');
		}

		// 4. Очищуємо всі лічильники повідомлень в Redis
		await redisClient.del(CACHE_KEYS.USER_DAILY_MESSAGES);
		console.log('✅ Лічильники повідомлень успішно скинуті');
	} catch (error) {
		console.error('❌ Помилка формування щоденного звіту:', error);
	}
}

/**
 * Налаштовує cron-завдання для щоденного звіту
 */
function setupSheduleReportSchedule() {
	// За замовчуванням запускаємо о 12:00 за київським часом (UTC+2/UTC+3)
	// Оскільки cron працює за UTC, потрібно врахувати різницю (9:00/10:00 UTC)
	// Перевіряємо, чи діє літній час
	const now = new Date();
	const isDST = now.getTimezoneOffset() < -120; // -180 хвилин для UTC+3 (літній час)

	// Встановлюємо час запуску з урахуванням часового поясу
	const cronTime = isDST ? '0 9 * * *' : '0 10 * * *'; // 12:00 за київським часом

	console.log(`⏱️ Налаштування щоденного звіту за розкладом: ${cronTime} (UTC)`);

	// Встановлюємо cron-завдання
	cron.schedule(cronTime, runSheduleReport, {
		timezone: 'Etc/UTC' // Явно вказуємо UTC
	});

	console.log('✅ Планувальник щоденних звітів успішно налаштовано');
}

// Додаємо функцію для ручного запуску звіту (для тестування)
async function runReportManually() {
	console.log('🔄 Ручний запуск щоденного звіту...');
	await runSheduleReport();
}

export {
	setupSheduleReportSchedule,
	runReportManually,
	runSheduleReport
};
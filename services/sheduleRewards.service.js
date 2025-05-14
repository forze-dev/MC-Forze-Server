import cron from 'node-cron';
import { pool } from './db.service.js';
import { Telegraf } from 'telegraf';
import 'dotenv/config';
import {
	getTopMessageUsers,
	resetAllMessageCounts,
	resetMessagePeriod
} from './redis.service.js';

// Ініціалізуємо бота лише для відправки повідомлень
const bot = new Telegraf(process.env.BOT_TOKEN);
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;

// Винагороди для топ-5 учасників (в ігровій валюті)
const REWARDS = {
	1: 30, // Перше місце
	2: 25, // Друге місце
	3: 20, // Третє місце
	4: 15, // Четверте місце
	5: 10  // П'яте місце
};

/**
 * Перевіряє, чи діє зараз літній час в Україні
 * @returns {boolean} true якщо зараз літній час
 */
function isUkraineDST() {
	const now = new Date();
	// Отримуємо дату в Києві
	const kyivDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kiev' }));
	// Отримуємо зміщення від UTC в хвилинах
	const offsetInMinutes = -kyivDate.getTimezoneOffset();
	// Якщо зміщення більше 120 хвилин (2 години), то це літній час
	return offsetInMinutes > 120;
}

/**
 * Отримати детальну інформацію про користувачів по їх telegram_id
 * @param {string[]} telegramIds Масив telegram_id
 * @returns {Promise<Array>} Масив користувачів з детальною інформацією
 */
async function getUserDetailsByIds(telegramIds) {
	if (!telegramIds.length) return [];

	const conn = await pool.getConnection();

	try {
		// Підготовка параметрів для запиту
		const placeholders = telegramIds.map(() => '?').join(',');

		// Отримання деталей користувачів
		const [users] = await conn.query(`
            SELECT telegram_id, minecraft_nick, messages_count, game_balance 
            FROM users 
            WHERE telegram_id IN (${placeholders})
        `, telegramIds);

		return users;
	} catch (error) {
		console.error('❌ Помилка отримання деталей користувачів:', error);
		return [];
	} finally {
		conn.release();
	}
}

/**
 * Нарахувати винагороди топ користувачам
 * @param {Array} topUsers Масив [telegramId, count]
 * @returns {Promise<Array|boolean>} Результат операції
 */
async function awardTopUsers(topUsers) {
	if (!topUsers.length) return false;

	const conn = await pool.getConnection();
	const now = Math.floor(Date.now() / 1000);

	try {
		await conn.beginTransaction();

		// Отримуємо детальну інформацію про користувачів
		const telegramIds = topUsers.map(item => item[0]);
		const userDetails = await getUserDetailsByIds(telegramIds);

		// Створюємо мапу для швидкого доступу до деталей користувача
		const userMap = new Map();
		userDetails.forEach(user => {
			userMap.set(user.telegram_id.toString(), user);
		});

		// Масив для зберігання результатів нагородження
		const awardResults = [];

		// Нараховуємо нагороди для перших 5 місць (або менше, якщо користувачів менше)
		for (let i = 0; i < Math.min(topUsers.length, 5); i++) {
			const position = i + 1;
			const [telegramId, messageCount] = topUsers[i];
			const reward = REWARDS[position];

			// Отримуємо деталі користувача
			const user = userMap.get(telegramId);
			if (!user) continue;

			// Оновлюємо баланс користувача і зберігаємо message_count
			await conn.query(`
                UPDATE users 
                SET game_balance = game_balance + ?, 
                    messages_count = ?,
                    updated_at = ? 
                WHERE telegram_id = ?
            `, [reward, messageCount, now, telegramId]);

			awardResults.push({
				position,
				telegram_id: telegramId,
				minecraft_nick: user.minecraft_nick,
				messages_count: messageCount,
				reward
			});
		}

		// Для всіх інших користувачів просто оновлюємо message_count
		// Обробляємо інших користувачів, які не отримали нагороди
		for (let i = 5; i < topUsers.length; i++) {
			const [telegramId, messageCount] = topUsers[i];
			const user = userMap.get(telegramId);
			if (!user) continue;

			await conn.query(`
                UPDATE users 
                SET messages_count = ?,
                    updated_at = ? 
                WHERE telegram_id = ?
            `, [messageCount, now, telegramId]);
		}

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
 * @param {Array} topUsers Масив [telegramId, count]
 * @param {Array} userDetails Масив з детальною інформацією про користувачів
 * @param {Array} awardResults Результати нарахування нагород
 * @returns {string} Відформатоване повідомлення
 */
function formatScheduleReport(topUsers, userDetails, awardResults) {
	// Створюємо мапу для швидкого доступу до деталей користувача
	const userMap = new Map();
	userDetails.forEach(user => {
		userMap.set(user.telegram_id.toString(), user);
	});

	// Заголовок звіту
	let message = `📊 *Підсумки активності чату за період*\n\n`;

	// Статистика повідомлень (топ-10)
	message += `🏆 *Топ ${topUsers.length} по кількості повідомлень:*\n\n`;

	topUsers.forEach(([telegramId, count], index) => {
		const user = userMap.get(telegramId);
		if (user) {
			message += `${index + 1}. *${user.minecraft_nick}* — ${count} смс\n`;
		}
	});

	// Секція нагород, якщо є результати
	if (awardResults && awardResults.length > 0) {
		message += `\n💰 *Нагороди за активність:*\n`;
		awardResults.forEach(award => {
			message += `${award.position} місце (*${award.minecraft_nick}*): +${award.reward} GFC\n`;
		});

		message += `\n🎁 Вітаємо переможців! Нагороди вже зараховано на ваші ігрові рахунки!`;
		message += `\n\n⏰ Новий період підрахунку повідомлень почався! Кожен гравець може заробити до 200 GFC за свої повідомлення до наступного підведення підсумків.`;
	}

	return message;
}

/**
 * Запускає щоденне підведення підсумків та нагородження
 */
async function runScheduleReport() {
	console.log('🔄 Запуск щоденного звіту активності...');

	try {
		// 1. Отримуємо топ-10 користувачів за кількістю повідомлень
		const topUsers = await getTopMessageUsers(10);

		if (!topUsers.length) {
			console.log('📨 Немає активних користувачів за останній період');

			// Скидаємо період підрахунку, навіть якщо немає активних користувачів
			await resetMessagePeriod();

			// Відправляємо повідомлення, що немає активних користувачів
			if (TARGET_CHAT_ID) {
				await bot.telegram.sendMessage(
					TARGET_CHAT_ID,
					'📊 *Звіт за період*\n\nНа жаль, не було активних користувачів у чаті за цей період.',
					{ parse_mode: 'Markdown' }
				);
			}

			return;
		}

		console.log(`📨 Отримано топ-${topUsers.length} користувачів за кількістю повідомлень`);

		// 2. Отримуємо детальну інформацію про користувачів
		const telegramIds = topUsers.map(item => item[0]);
		const userDetails = await getUserDetailsByIds(telegramIds);

		// 3. Нараховуємо нагороди
		const awardResults = await awardTopUsers(topUsers);

		// 4. Форматуємо та відправляємо повідомлення в чат
		const reportMessage = formatScheduleReport(topUsers, userDetails, awardResults);

		// 5. Скидаємо лічильники і період для нового циклу
		await resetAllMessageCounts();
		await resetMessagePeriod();

		// 6. Відправляємо в чат
		if (TARGET_CHAT_ID) {
			await bot.telegram.sendMessage(TARGET_CHAT_ID, reportMessage, { parse_mode: 'Markdown' });
			console.log('✅ Звіт успішно відправлено в чат');
		} else {
			console.error('❌ Не вказано TARGET_CHAT_ID для відправки звіту');
		}
	} catch (error) {
		console.error('❌ Помилка формування щоденного звіту:', error);
	}
}

/**
 * Налаштовує cron-завдання для щоденного звіту о 13:00 за Київським часом
 */
function setupScheduleReportSchedule() {
	// Встановлюємо час запуску - 13:00 за київським часом
	// Оскільки cron працює за UTC, потрібно врахувати різницю для Києва (+2/+3 UTC)
	// Перевіряємо, чи діє літній час
	const isDST = isUkraineDST();

	// Встановлюємо час запуску з урахуванням часового поясу
	// 10:00 UTC = 13:00 Київ в літній час (UTC+3)
	// 11:00 UTC = 13:00 Київ в зимовий час (UTC+2)
	const cronTime = isDST ? '0 10 * * *' : '0 11 * * *';

	console.log(`⏱️ Налаштування щоденного звіту за розкладом: ${cronTime} (UTC) = 13:00 (Київ)`);

	// Встановлюємо cron-завдання
	cron.schedule(cronTime, runScheduleReport, {
		timezone: 'Etc/UTC' // Явно вказуємо UTC
	});

	console.log('✅ Планувальник щоденних звітів успішно налаштовано');
}

/**
 * Додаткова функція для ручного запуску звіту (для тестування або керування)
 */
async function runReportManually() {
	console.log('🔄 Ручний запуск щоденного звіту...');
	await runScheduleReport();
}

/**
 * Перевіряє коректність налаштування розкладу і виводить інформацію
 */
function checkScheduleSetup() {
	const isDST = isUkraineDST();
	const kyivTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' });
	const utcTime = new Date().toLocaleString('uk-UA', { timeZone: 'UTC' });

	console.log(`🕒 Поточний час в Києві: ${kyivTime}`);
	console.log(`🕒 Поточний час UTC: ${utcTime}`);
	console.log(`🔍 Літній час в Україні: ${isDST ? 'Так' : 'Ні'}`);
	console.log(`⏰ Звіти заплановано на: 13:00 (Київ) / ${isDST ? '10:00' : '11:00'} (UTC)`);
}

export {
	setupScheduleReportSchedule,
	runReportManually,
	runScheduleReport,
	checkScheduleSetup
};
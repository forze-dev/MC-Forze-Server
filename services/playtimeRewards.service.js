import cron from 'node-cron';
import { pool } from './db.service.js';
import { Telegraf } from 'telegraf';
import 'dotenv/config';

// Ініціалізуємо бота для відправки звітів
const bot = new Telegraf(process.env.BOT_TOKEN);
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;

/**
 * Перевіряє, чи діє зараз літній час в Україні
 * @returns {boolean} true якщо зараз літній час
 */
function isUkraineDST() {
	const now = new Date();
	const kyivDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kiev' }));
	const offsetInMinutes = -kyivDate.getTimezoneOffset();
	return offsetInMinutes > 120;
}

/**
 * Отримати активний час всіх гравців з Plan плагіна
 * @returns {Promise<Array>} Масив гравців з активним часом
 */
async function getAllPlayersActiveTime() {
	const conn = await pool.getConnection();

	try {
		console.log('📊 Отримання активного часу всіх гравців...');

		// Отримуємо активний час всіх гравців (загальний час - afk час)
		const [players] = await conn.query(`
			SELECT 
				pu.name as minecraft_nick,
				pu.uuid,
				u.telegram_id,
				u.game_balance,
				COALESCE(SUM(
					GREATEST(0, ps.session_end - ps.session_start - ps.afk_time)
				) / 60000, 0) as total_active_minutes
			FROM plan_users pu
			JOIN users u ON u.minecraft_nick = pu.name  
			LEFT JOIN plan_sessions ps ON ps.user_id = pu.id
			WHERE u.telegram_id IS NOT NULL
			GROUP BY pu.id, pu.name, pu.uuid, u.telegram_id, u.game_balance
			HAVING total_active_minutes >= 1
			ORDER BY total_active_minutes DESC
		`);

		console.log(`📊 Знайдено ${players.length} гравців з активним часом гри`);
		return players;

	} catch (error) {
		console.error('❌ Помилка отримання активного часу гравців:', error);
		return [];
	} finally {
		conn.release();
	}
}

/**
 * Отримати останні нарахування для гравців
 * @param {Array} telegramIds Масив telegram_id
 * @returns {Promise<Map>} Мапа telegram_id -> дані останнього нарахування
 */
async function getLastRewards(telegramIds) {
	if (!telegramIds.length) return new Map();

	const conn = await pool.getConnection();

	try {
		const placeholders = telegramIds.map(() => '?').join(',');

		const [rewards] = await conn.query(`
			SELECT telegram_id, total_active_minutes, coins_awarded, last_awarded_at
			FROM daily_playtime_rewards
			WHERE telegram_id IN (${placeholders})
		`, telegramIds);

		const rewardMap = new Map();
		rewards.forEach(reward => {
			rewardMap.set(reward.telegram_id.toString(), reward);
		});

		console.log(`📋 Знайдено ${rewards.length} записів останніх нарахувань`);
		return rewardMap;

	} catch (error) {
		console.error('❌ Помилка отримання останніх нарахувань:', error);
		return new Map();
	} finally {
		conn.release();
	}
}

/**
 * Нарахувати коїни гравцям за новий активний час
 * @param {Array} players Масив гравців з активним часом
 * @returns {Promise<Array>} Результати нарахувань
 */
async function awardActiveTimeCoins(players) {
	if (!players.length) return [];

	const conn = await pool.getConnection();
	const now = Math.floor(Date.now() / 1000);

	try {
		await conn.beginTransaction();
		console.log('🔄 Початок транзакції нарахування коїнів...');

		// Отримуємо останні нарахування
		const telegramIds = players.map(p => p.telegram_id);
		const lastRewards = await getLastRewards(telegramIds);

		const awardResults = [];
		let totalNewCoins = 0;

		for (const player of players) {
			const telegramId = player.telegram_id;
			const currentActiveMinutes = Math.floor(player.total_active_minutes);
			const lastReward = lastRewards.get(telegramId.toString());

			let newActiveMinutes = 0;
			let coinsToAward = 0;

			if (lastReward) {
				// Гравець вже має записи - рахуємо різницю
				const lastActiveMinutes = parseInt(lastReward.total_active_minutes);
				newActiveMinutes = Math.max(0, currentActiveMinutes - lastActiveMinutes);
				coinsToAward = newActiveMinutes; // 1 хвилина = 1 коїн

				if (newActiveMinutes > 0) {
					// Оновлюємо існуючий запис
					await conn.query(`
						UPDATE daily_playtime_rewards 
						SET total_active_minutes = ?, 
							coins_awarded = coins_awarded + ?, 
							last_awarded_at = ?,
							updated_at = ?
						WHERE telegram_id = ?
					`, [currentActiveMinutes, coinsToAward, now, now, telegramId]);

					// Оновлюємо баланс гравця
					await conn.query(`
						UPDATE users 
						SET game_balance = game_balance + ?, 
							updated_at = ? 
						WHERE telegram_id = ?
					`, [coinsToAward, now, telegramId]);

					console.log(`✅ ${player.minecraft_nick}: ${newActiveMinutes} хв → ${coinsToAward} GFC`);
				}
			} else {
				// Новий гравець - нараховуємо за весь активний час
				newActiveMinutes = currentActiveMinutes;
				coinsToAward = currentActiveMinutes;

				if (coinsToAward > 0) {
					// Створюємо новий запис
					await conn.query(`
						INSERT INTO daily_playtime_rewards 
						(telegram_id, minecraft_nick, total_active_minutes, coins_awarded, last_awarded_at, created_at, updated_at)
						VALUES (?, ?, ?, ?, ?, ?, ?)
					`, [telegramId, player.minecraft_nick, currentActiveMinutes, coinsToAward, now, now, now]);

					// Оновлюємо баланс гравця
					await conn.query(`
						UPDATE users 
						SET game_balance = game_balance + ?, 
							updated_at = ? 
						WHERE telegram_id = ?
					`, [coinsToAward, now, telegramId]);

					console.log(`🆕 ${player.minecraft_nick}: новий гравець → ${coinsToAward} GFC`);
				}
			}

			if (coinsToAward > 0) {
				totalNewCoins += coinsToAward;
				awardResults.push({
					telegram_id: telegramId,
					minecraft_nick: player.minecraft_nick,
					total_active_hours: Math.round(currentActiveMinutes / 60 * 10) / 10,
					new_active_minutes: newActiveMinutes,
					coins_awarded: coinsToAward,
					total_coins_awarded: (lastReward?.coins_awarded || 0) + coinsToAward
				});
			}
		}

		await conn.commit();
		console.log(`✅ Нарахування завершено: ${awardResults.length} гравців, ${totalNewCoins} GFC`);
		return awardResults;

	} catch (error) {
		await conn.rollback();
		console.error('❌ Помилка нарахування коїнів:', error);
		return [];
	} finally {
		conn.release();
	}
}

/**
 * Отримати топ активних гравців за останні 24 години
 * @returns {Promise<Array>} Топ гравців за новим активним часом
 */
async function getTop24HourActivePlayers() {
	const conn = await pool.getConnection();

	try {
		// Час 24 години тому
		const yesterday = Math.floor(Date.now() / 1000) - (24 * 60 * 60);
		const yesterdayMs = yesterday * 1000; // для plan_sessions (мілісекунди)

		const [topPlayers] = await conn.query(`
			SELECT 
				pu.name as minecraft_nick,
				-- Рахуємо активний час за останні 24 години
				COALESCE(SUM(
					GREATEST(0, ps.session_end - ps.session_start - ps.afk_time)
				) / 60000, 0) as active_minutes_24h
			FROM plan_users pu
			JOIN users u ON u.minecraft_nick = pu.name
			LEFT JOIN plan_sessions ps ON ps.user_id = pu.id AND ps.session_start >= ?
			WHERE u.telegram_id IS NOT NULL
			GROUP BY pu.id, pu.name
			HAVING active_minutes_24h >= 1
			ORDER BY active_minutes_24h DESC
			LIMIT 10
		`, [yesterdayMs]);

		return topPlayers.map(player => ({
			minecraft_nick: player.minecraft_nick,
			active_hours_24h: Math.round(player.active_minutes_24h / 60 * 10) / 10,
			active_minutes_24h: Math.floor(player.active_minutes_24h),
			coins_earned_24h: Math.floor(player.active_minutes_24h) // 1:1 коїни до хвилин
		}));

	} catch (error) {
		console.error('❌ Помилка отримання топ гравців за 24 години:', error);
		return [];
	} finally {
		conn.release();
	}
}

/**
 * Форматує звіт про нарахування коїнів за активний час
 * @param {Array} awardResults Результати нарахувань
 * @param {Array} topPlayers Топ активних гравців за 24 години
 * @returns {string} Відформатований звіт
 */
function formatPlaytimeReport(awardResults, topPlayers) {
	let message = `🎮 *Щоденний звіт: Нарахування коїнів за активний час*\n`;
	message += `📅 ${new Date().toLocaleDateString('uk-UA', {
		timeZone: 'Europe/Kiev',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	})}\n\n`;

	// Загальна статистика
	const totalCoinsAwarded = awardResults.reduce((sum, player) => sum + player.coins_awarded, 0);
	const totalActiveHours = awardResults.reduce((sum, player) => sum + (player.new_active_minutes / 60), 0);

	message += `📊 *Загальна статистика:*\n`;
	message += `• Гравців отримало нагороди: ${awardResults.length}\n`;
	message += `• Загалом нараховано: ${totalCoinsAwarded} GFC\n`;
	message += `• Загальний активний час: ${Math.round(totalActiveHours * 10) / 10} годин\n\n`;

	if (awardResults.length > 0) {
		// Сортуємо гравців за кількістю нарахованих коїнів
		const topAwardedPlayers = [...awardResults]
			.sort((a, b) => b.coins_awarded - a.coins_awarded)
			.slice(0, 5);

		message += `🏆 *Топ гравців за нарахованими коїнами сьогодні:*\n`;
		topAwardedPlayers.forEach((player, index) => {
			const emoji = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '🏅';
			const newHours = Math.round(player.new_active_minutes / 60 * 10) / 10;
			message += `${emoji} ${index + 1}. \`${player.minecraft_nick}\` - ${newHours}г (нових) - ${player.coins_awarded} GFC\n`;
		});
		message += `\n`;
	}

	message += `\n💡 *1 хвилина активної гри = 1 GFC*`;
	message += `\n⏰ Наступне нарахування завтра`;

	return message;
}

/**
 * Основна функція для запуску щоденного нарахування коїнів
 */
async function runDailyPlaytimeRewards() {
	try {
		console.log('🎮 Запуск щоденного нарахування коїнів за активний час...');
		console.log(`🕒 Час запуску: ${new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' })}`);

		// 1. Отримуємо активний час всіх гравців
		const players = await getAllPlayersActiveTime();

		if (players.length === 0) {
			console.log('ℹ️ Немає гравців для нарахування коїнів');

			if (TARGET_CHAT_ID) {
				await bot.telegram.sendMessage(
					TARGET_CHAT_ID,
					'🎮 *Щоденне нарахування коїнів*\n\nСьогодні немає активних гравців для нарахування коїнів.',
					{ parse_mode: 'Markdown' }
				);
			}
			return;
		}

		// 2. Нараховуємо коїни за новий активний час
		const awardResults = await awardActiveTimeCoins(players);

		// 3. Отримуємо топ гравців за 24 години
		const topPlayers = await getTop24HourActivePlayers();

		// 4. Формуємо та відправляємо звіт
		const reportMessage = formatPlaytimeReport(awardResults, topPlayers);

		if (TARGET_CHAT_ID) {
			await bot.telegram.sendMessage(TARGET_CHAT_ID, reportMessage, { parse_mode: 'Markdown' });
			console.log('✅ Звіт про нарахування коїнів успішно відправлено в чат');
		} else {
			console.log('⚠️ TARGET_CHAT_ID не вказано - звіт не відправлено');
		}

		console.log('✅ Щоденне нарахування коїнів завершено успішно');

	} catch (error) {
		console.error('❌ Помилка виконання щоденного нарахування коїнів:', error);

		// Відправляємо повідомлення про помилку в чат
		if (TARGET_CHAT_ID) {
			try {
				await bot.telegram.sendMessage(
					TARGET_CHAT_ID,
					`❌ *Помилка нарахування коїнів*\n\nСталася помилка під час нарахування коїнів за активний час: ${error.message}`,
					{ parse_mode: 'Markdown' }
				);
			} catch (sendError) {
				console.error('❌ Помилка відправки повідомлення про помилку:', sendError);
			}
		}
	}
}

/**
 * Налаштовує cron-завдання для щоденного нарахування о 15:00 за Київським часом
 */
function setupPlaytimeRewardsSchedule() {
	// Встановлюємо час запуску - 15:00 за київським часом
	const isDST = isUkraineDST();

	// 12:00 UTC = 15:00 Київ в літній час (UTC+3)
	// 13:00 UTC = 15:00 Київ в зимовий час (UTC+2)
	const cronTime = isDST ? '0 12 * * *' : '0 13 * * *';

	console.log(`⏱️ Налаштування щоденного нарахування коїнів: ${cronTime} (UTC) = 15:00 (Київ)`);

	// Встановлюємо cron-завдання
	cron.schedule(cronTime, runDailyPlaytimeRewards, {
		timezone: 'Etc/UTC'
	});

	console.log('✅ Планувальник щоденного нарахування коїнів успішно налаштовано');
}

/**
 * Ручний запуск нарахування (для тестування)
 */
async function runPlaytimeRewardsManually() {
	console.log('🔄 Ручний запуск нарахування коїнів за активний час...');
	await runDailyPlaytimeRewards();
}

/**
 * Перевіряє налаштування розкладу
 */
function checkPlaytimeScheduleSetup() {
	const isDST = isUkraineDST();
	const kyivTime = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' });
	const utcTime = new Date().toLocaleString('uk-UA', { timeZone: 'UTC' });

	console.log(`🕒 Поточний час в Києві: ${kyivTime}`);
	console.log(`🕒 Поточний час UTC: ${utcTime}`);
	console.log(`🔍 Літній час в Україні: ${isDST ? 'Так' : 'Ні'}`);
	console.log(`⏰ Нарахування заплановано на: 15:00 (Київ) / ${isDST ? '12:00' : '13:00'} (UTC)`);
}

export {
	setupPlaytimeRewardsSchedule,
	runPlaytimeRewardsManually,
	runDailyPlaytimeRewards,
	checkPlaytimeScheduleSetup,
	getAllPlayersActiveTime,
	getTop24HourActivePlayers
};
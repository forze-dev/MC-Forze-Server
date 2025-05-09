import { pool } from '../services/db.service.js';
import { hashPassword } from '../utils/crypto.js';
import { addRegisteredUser } from '../services/redis.service.js';

async function register(req, res) {
	const { telegramId, minecraftNick, password, referrerNick } = req.body;

	// Перевірка на наявність обов'язкових полів
	if (!telegramId || !minecraftNick || !password) {
		return res.status(400).json({ message: 'Missing telegramId, minecraftNick or password' });
	}

	// Перевірка мінімальної довжини нікнейму та паролю
	if (minecraftNick.length < 3) {
		return res.status(400).json({ message: 'Minecraft nickname must be at least 3 characters long' });
	}

	if (password.length < 4) {
		return res.status(400).json({ message: 'Password must be at least 4 characters long' });
	}

	// Хешуємо пароль
	const hashedPassword = hashPassword(password);
	const now = Math.floor(Date.now() / 1000);

	// Змінна для відстеження чи знайдено реферала
	let referrerFound = false;

	try {
		const conn = await pool.getConnection();

		try {
			await conn.beginTransaction();

			// Перевірка на наявність такого точного нікнейму в authme (з урахуванням регістру)
			const [existingAuthUser] = await conn.query('SELECT * FROM authme WHERE BINARY username = ?', [minecraftNick]);

			if (existingAuthUser.length > 0) {
				await conn.rollback();
				conn.release();
				return res.status(409).json({ message: 'Minecraft username already exists' });
			}

			// Перевірка на наявність подібного нікнейму без урахування регістру
			const [similarUsers] = await conn.query('SELECT * FROM authme WHERE LOWER(username) = LOWER(?)', [minecraftNick]);
			if (similarUsers.length > 0) {
				await conn.rollback();
				conn.release();
				return res.status(409).json({
					message: 'Similar Minecraft username already exists (case-insensitive match)',
					suggestion: similarUsers[0].username
				});
			}

			// Перевірка на наявність такого telegram_id в users
			const [existingTelegramUser] = await conn.query('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);
			if (existingTelegramUser.length > 0) {
				await conn.rollback();
				conn.release();
				return res.status(409).json({ message: 'Telegram user already registered' });
			}

			// Перевіряємо наявність реферала перед додаванням користувача
			let validReferrerNick = null;

			if (referrerNick) {
				// Перевіряємо що користувач не намагається вказати себе як реферала
				if (minecraftNick.toLowerCase() === referrerNick.toLowerCase()) {
					await conn.rollback();
					conn.release();
					return res.status(400).json({ message: 'Cannot set yourself as a referrer' });
				}

				// Спочатку шукаємо точний збіг за регістром
				const [exactReferrer] = await conn.query('SELECT * FROM users WHERE BINARY minecraft_nick = ?', [referrerNick]);

				if (exactReferrer.length > 0) {
					// Реферал існує з точним збігом регістру - зберігаємо його нік
					validReferrerNick = exactReferrer[0].minecraft_nick;
					referrerFound = true;
				} else {
					// Якщо точного збігу немає, шукаємо без урахування регістру
					const [similarReferrers] = await conn.query('SELECT * FROM users WHERE LOWER(minecraft_nick) = LOWER(?)', [referrerNick]);

					if (similarReferrers.length > 0) {
						await conn.rollback();
						conn.release();
						return res.status(400).json({
							message: 'Referrer found but with different case. Please use exact nickname',
							suggestion: similarReferrers[0].minecraft_nick
						});
					}
					// Якщо реферала не знайдено взагалі - продовжуємо реєстрацію без реферала
				}
			}

			// Додаємо користувача в authme
			await conn.query(
				'INSERT INTO authme (username, realname, password, regdate, regip, x, y, z, world, isLogged, hasSession) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
				[minecraftNick, minecraftNick, hashedPassword, now, '127.0.0.1', 0, 0, 0, 'world', 0, 0]
			);

			// Додаємо користувача в users з перевіреним ніком реферала або null
			await conn.query(
				'INSERT INTO users (telegram_id, username, minecraft_nick, referrer_nick, registered_at, messages_count, donate_balance, game_balance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				[telegramId, null, minecraftNick, validReferrerNick, now, 0, 0, 0]
			);

			// Обробляємо реферальну систему тільки якщо реферал існує
			if (referrerFound) {
				const [referrer] = await conn.query('SELECT * FROM users WHERE BINARY minecraft_nick = ?', [validReferrerNick]);
				const referrerTelegramId = referrer[0].telegram_id;

				// Додаємо запис в таблицю referrals 
				await conn.query(
					'INSERT INTO referrals (referrer_telegram_id, referred_telegram_id, referred_nick, confirmed, created_at) VALUES (?, ?, ?, ?, ?)',
					[referrerTelegramId, telegramId, minecraftNick, 1, now]
				);

				// Оновлюємо кількість рефералів для реферера в таблиці discounts
				const [discountRecord] = await conn.query(
					'SELECT * FROM discounts WHERE telegram_id = ?',
					[referrerTelegramId]
				);

				if (discountRecord.length > 0) {
					// Якщо запис існує, збільшуємо лічильник
					await conn.query(
						'UPDATE discounts SET referrals_count = referrals_count + 1, updated_at = ? WHERE telegram_id = ?',
						[now, referrerTelegramId]
					);

					// Оновлюємо відсоток знижки: 2% за кожного реферала, максимум 40% (20 рефералів)
					await conn.query(
						'UPDATE discounts SET discount_percent = CASE ' +
						'WHEN referrals_count >= 20 THEN 40 ' +
						'ELSE referrals_count * 2 ' +
						'END, updated_at = ? WHERE telegram_id = ?',
						[now, referrerTelegramId]
					);
				} else {
					// Якщо запису нема, створюємо новий з знижкою 2% за першого реферала
					await conn.query(
						'INSERT INTO discounts (telegram_id, referrals_count, discount_percent, updated_at) VALUES (?, ?, ?, ?)',
						[referrerTelegramId, 1, 2, now]
					);
				}
			}

			await conn.commit();
			conn.release();

			await addRegisteredUser(telegramId);

			return res.status(201).json({
				message: 'User registered',
				minecraft_nick: minecraftNick,
				registered_at: now,
				referrer_applied: referrerFound,
				referrerNick: validReferrerNick
			});

		} catch (error) {
			await conn.rollback();
			conn.release();
			throw error;
		}
	} catch (err) {
		console.error('Registration error:', err);
		return res.status(500).json({ message: 'Error registering user' });
	}
}

async function addReferrer(req, res) {
	const { telegramId, referrerNick } = req.body;

	// Перевірка на наявність обов'язкових полів
	if (!telegramId || !referrerNick) {
		return res.status(400).json({ message: 'Missing telegramId or referrerNick' });
	}

	const now = Math.floor(Date.now() / 1000);

	try {
		const conn = await pool.getConnection();

		try {
			await conn.beginTransaction();

			// Перевірка на існування користувача
			const [user] = await conn.query('SELECT * FROM users WHERE telegram_id = ?', [telegramId]);

			if (user.length === 0) {
				await conn.rollback();
				conn.release();
				return res.status(404).json({ message: 'User not found' });
			}

			// Перевірка чи вже є реферал
			if (user[0].referrer_nick) {
				await conn.rollback();
				conn.release();
				return res.status(409).json({ message: 'User already has a referrer' });
			}

			// Перевірка, що користувач не намагається вказати себе як реферала
			// Використовуємо регістронезалежне порівняння
			if (user[0].minecraft_nick.toLowerCase() === referrerNick.toLowerCase()) {
				await conn.rollback();
				conn.release();
				return res.status(400).json({ message: 'Cannot set yourself as a referrer' });
			}

			// Перевірка на існування реферала з урахуванням регістру
			const [exactReferrer] = await conn.query('SELECT * FROM users WHERE BINARY minecraft_nick = ?', [referrerNick]);

			if (exactReferrer.length === 0) {
				// Якщо точного збігу немає, шукаємо без урахування регістру
				const [similarReferrers] = await conn.query('SELECT * FROM users WHERE LOWER(minecraft_nick) = LOWER(?)', [referrerNick]);

				if (similarReferrers.length > 0) {
					// Знайдено збіг без урахування регістру
					await conn.rollback();
					conn.release();
					return res.status(400).json({
						message: 'Referrer found but with different case. Please use exact nickname',
						suggestion: similarReferrers[0].minecraft_nick
					});
				} else {
					// Реферала не знайдено взагалі
					await conn.rollback();
					conn.release();
					return res.status(404).json({ message: 'Referrer not found' });
				}
			}

			const referrerTelegramId = exactReferrer[0].telegram_id;
			const exactRefNick = exactReferrer[0].minecraft_nick;

			// Оновлюємо інформацію про реферала в таблиці users
			// Використовуємо ім'я з точним регістром, яке знайшли в БД
			await conn.query(
				'UPDATE users SET referrer_nick = ?, updated_at = ? WHERE telegram_id = ?',
				[exactRefNick, now, telegramId]
			);

			// Додаємо запис в таблицю referrals 
			await conn.query(
				'INSERT INTO referrals (referrer_telegram_id, referred_telegram_id, referred_nick, confirmed, created_at) VALUES (?, ?, ?, ?, ?)',
				[referrerTelegramId, telegramId, user[0].minecraft_nick, 1, now]
			);

			// Оновлюємо кількість рефералів для реферера в таблиці discounts
			const [discountRecord] = await conn.query(
				'SELECT * FROM discounts WHERE telegram_id = ?',
				[referrerTelegramId]
			);

			if (discountRecord.length > 0) {
				// Якщо запис існує, збільшуємо лічильник
				await conn.query(
					'UPDATE discounts SET referrals_count = referrals_count + 1, updated_at = ? WHERE telegram_id = ?',
					[now, referrerTelegramId]
				);

				// Оновлюємо відсоток знижки: 2% за кожного реферала, максимум 40% (20 рефералів)
				await conn.query(
					'UPDATE discounts SET discount_percent = CASE ' +
					'WHEN referrals_count >= 20 THEN 40 ' +
					'ELSE referrals_count * 2 ' +
					'END, updated_at = ? WHERE telegram_id = ?',
					[now, referrerTelegramId]
				);
			} else {
				// Якщо запису нема, створюємо новий з знижкою 2% за першого реферала
				await conn.query(
					'INSERT INTO discounts (telegram_id, referrals_count, discount_percent, updated_at) VALUES (?, ?, ?, ?)',
					[referrerTelegramId, 1, 2, now]
				);
			}

			await conn.commit();
			conn.release();

			return res.status(200).json({
				message: 'Referrer added successfully',
				referrer_nick: exactRefNick
			});

		} catch (error) {
			await conn.rollback();
			conn.release();
			throw error;
		}
	} catch (err) {
		console.error('Add referrer error:', err);
		return res.status(500).json({ message: 'Error adding referrer' });
	}
}
/**
 * Отримати детальну статистику гравця за його Telegram ID
 */
async function getPlayerStatsByTelegramId(req, res) {
	const { telegramId } = req.params;

	if (!telegramId) {
		return res.status(400).json({ message: 'Telegram ID is required' });
	}

	try {
		// Отримуємо з'єднання з базою даних
		const conn = await pool.getConnection();

		try {
			// 1. Основна інформація про гравця з таблиці users
			const [userInfo] = await conn.query(`
                SELECT u.minecraft_nick, u.telegram_id, u.game_balance, u.donate_balance, 
                       u.registered_at, d.discount_percent
                FROM users u
                LEFT JOIN discounts d ON u.telegram_id = d.telegram_id
                WHERE u.telegram_id = ?
            `, [telegramId]);

			if (userInfo.length === 0) {
				conn.release();
				return res.status(404).json({ message: 'Player not found' });
			}

			const playerData = userInfo[0];

			// 2. Кількість рефералів
			const [referralsCount] = await conn.query(`
                SELECT COUNT(*) as referrals_count 
                FROM referrals 
                WHERE referrer_telegram_id = ? AND confirmed = 1
            `, [telegramId]);

			playerData.referrals_count = referralsCount[0].referrals_count;

			// 3. Отримуємо ID гравця з таблиці plan_users за його нікнеймом
			const [planUser] = await conn.query(`
                SELECT id, uuid 
                FROM plan_users 
                WHERE name = ?
            `, [playerData.minecraft_nick]);

			if (planUser.length === 0) {
				conn.release();
				// Повертаємо дані, які вдалося знайти, без статистики Plan
				return res.status(200).json({
					...playerData,
					plan_data_available: false,
					message: 'Plan statistics not available for this player'
				});
			}

			const userId = planUser[0].id;
			const userUuid = planUser[0].uuid;

			// 4. Групи дозволів (з LuckPerms через план)
			const [permissionGroups] = await conn.query(`
                SELECT euv.group_value, euv.string_value
                FROM plan_extension_user_values euv
                JOIN plan_extension_providers ep ON euv.provider_id = ep.id
                WHERE euv.uuid = ? AND (ep.name = 'primaryGroup' OR ep.name = 'permissionGroups')
            `, [userUuid]);

			const groups = permissionGroups.map(g => g.group_value || g.string_value).filter(Boolean);
			playerData.permission_groups = groups;

			// 5. Загальна статистика сесій
			const [sessionStats] = await conn.query(`
                SELECT 
                    COUNT(id) as total_sessions,
                    SUM(session_end - session_start) as total_playtime,
                    SUM(mob_kills) as total_mob_kills,
                    SUM(deaths) as total_deaths,
                    AVG(session_end - session_start) as avg_session_duration
                FROM plan_sessions
                WHERE user_id = ?
            `, [userId]);

			if (sessionStats[0].total_sessions > 0) {
				playerData.total_sessions = sessionStats[0].total_sessions;
				playerData.total_playtime_ms = sessionStats[0].total_playtime;
				playerData.total_playtime_hours = Math.round(sessionStats[0].total_playtime / 3600000 * 10) / 10; // в годинах, округлено до 1 знаку
				playerData.avg_session_duration_ms = sessionStats[0].avg_session_duration;
				playerData.avg_session_duration_minutes = Math.round(sessionStats[0].avg_session_duration / 60000 * 10) / 10; // в хвилинах, округлено до 1 знаку
				playerData.total_mob_kills = sessionStats[0].total_mob_kills;
				playerData.total_deaths = sessionStats[0].total_deaths;
			} else {
				playerData.total_sessions = 0;
				playerData.total_playtime_ms = 0;
				playerData.total_playtime_hours = 0;
				playerData.avg_session_duration_ms = 0;
				playerData.avg_session_duration_minutes = 0;
				playerData.total_mob_kills = 0;
				playerData.total_deaths = 0;
			}

			// 6. Час проведений у кожному світі
			const [worldTimes] = await conn.query(`
                SELECT 
                    w.world_name,
                    SUM(wt.survival_time + wt.creative_time + wt.adventure_time + wt.spectator_time) as total_time,
                    SUM(wt.survival_time) as survival_time,
                    SUM(wt.creative_time) as creative_time,
                    SUM(wt.adventure_time) as adventure_time,
                    SUM(wt.spectator_time) as spectator_time
                FROM plan_world_times wt
                JOIN plan_worlds w ON wt.world_id = w.id
                WHERE wt.user_id = ?
                GROUP BY w.world_name
                ORDER BY total_time DESC
            `, [userId]);

			playerData.world_times = worldTimes.map(wt => ({
				world_name: wt.world_name,
				total_time_ms: wt.total_time,
				total_time_hours: Math.round(wt.total_time / 3600000 * 10) / 10,
				survival_time_ms: wt.survival_time,
				creative_time_ms: wt.creative_time,
				adventure_time_ms: wt.adventure_time,
				spectator_time_ms: wt.spectator_time
			}));

			// Найбільш відвідуваний світ
			if (worldTimes.length > 0) {
				playerData.most_played_world = worldTimes[0].world_name;
			}

			// 7. PvP статистика
			const [pvpKills] = await conn.query(`
                SELECT COUNT(*) as player_kills
                FROM plan_kills
                WHERE killer_uuid = ?
            `, [userUuid]);

			playerData.player_kills = pvpKills[0].player_kills;

			// K/D співвідношення
			if (playerData.total_deaths === 0) {
				playerData.kd_ratio = playerData.player_kills > 0 ? playerData.player_kills : 0;
			} else {
				playerData.kd_ratio = Math.round((playerData.player_kills / playerData.total_deaths) * 100) / 100;
			}

			conn.release();
			return res.status(200).json({
				...playerData,
				plan_data_available: true
			});

		} catch (error) {
			conn.release();
			throw error;
		}
	} catch (err) {
		console.error('Error fetching player stats:', err);
		return res.status(500).json({ message: 'Error fetching player statistics' });
	}
}

/**
 * Отримати детальну статистику гравця за його Minecraft нікнеймом
 */
async function getPlayerStatsByNick(req, res) {
	const { minecraftNick } = req.params;

	if (!minecraftNick) {
		return res.status(400).json({ message: 'Minecraft nickname is required' });
	}

	try {
		const conn = await pool.getConnection();

		try {
			// Спочатку знаходимо користувача за нікнеймом
			const [userInfo] = await conn.query(`
                SELECT u.minecraft_nick, u.telegram_id, u.game_balance, u.donate_balance, 
                       u.registered_at, d.discount_percent
                FROM users u
                LEFT JOIN discounts d ON u.telegram_id = d.telegram_id
                WHERE u.minecraft_nick = ?
            `, [minecraftNick]);

			if (userInfo.length === 0) {
				// Перевіряємо, можливо існує гравець з іншим регістром
				const [similarUsers] = await conn.query(`
                    SELECT minecraft_nick 
                    FROM users 
                    WHERE LOWER(minecraft_nick) = LOWER(?)
                `, [minecraftNick]);

				if (similarUsers.length > 0) {
					conn.release();
					return res.status(404).json({
						message: 'Player not found. Did you mean:',
						suggestions: similarUsers.map(u => u.minecraft_nick)
					});
				}

				conn.release();
				return res.status(404).json({ message: 'Player not found' });
			}

			const telegramId = userInfo[0].telegram_id;

			// Використовуємо існуючий метод, щоб не дублювати код
			conn.release();
			return getPlayerStatsByTelegramId({ params: { telegramId } }, res);

		} catch (error) {
			conn.release();
			throw error;
		}
	} catch (err) {
		console.error('Error fetching player stats by nickname:', err);
		return res.status(500).json({ message: 'Error fetching player statistics' });
	}
}

export { register, addReferrer, getPlayerStatsByTelegramId, getPlayerStatsByNick };
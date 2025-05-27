import { pool } from '../services/db.service.js';
import jwt from 'jsonwebtoken';
import { comparePassword } from '../utils/crypto.js';
import { redisClient } from '../services/redis.service.js';

/**
 * Авторизація гравця
 */
export async function playerLogin(req, res) {
	try {
		const { username, password } = req.body;

		// Перевірка обов'язкових полів
		if (!username || !password) {
			return res.status(400).json({ message: 'Відсутні обов\'язкові поля (username, password)' });
		}

		// Отримуємо інформацію про користувача з authme
		const [authUsers] = await pool.query('SELECT * FROM authme WHERE username = ?', [username]);

		if (authUsers.length === 0) {
			return res.status(401).json({ message: 'Невірний логін або пароль' });
		}

		// Перевіряємо пароль
		const isPasswordValid = comparePassword(password, authUsers[0].password);

		if (!isPasswordValid) {
			return res.status(401).json({ message: 'Невірний логін або пароль' });
		}

		// Отримуємо інформацію про гравця з users
		const [users] = await pool.query('SELECT * FROM users WHERE minecraft_nick = ?', [username]);

		if (users.length === 0) {
			return res.status(404).json({ message: 'Гравця не знайдено в системі' });
		}

		// Перевіряємо чи є гравець адміністратором
		let isAdmin = false;
		let adminRole = null;

		const [admins] = await pool.query(
			'SELECT * FROM admins WHERE telegram_id = ? AND is_active = 1',
			[users[0].telegram_id]
		);

		if (admins.length > 0) {
			isAdmin = true;
			adminRole = admins[0].role;
		}

		// Генеруємо JWT токен
		const tokenPayload = {
			telegramId: users[0].telegram_id,
			minecraftNick: users[0].minecraft_nick,
			isAdmin: isAdmin,
			role: adminRole
		};

		const token = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '1h' });

		// Генеруємо refresh токен з довшим терміном дії
		const refreshToken = jwt.sign(
			{ telegramId: users[0].telegram_id },
			process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
			{ expiresIn: '7d' }
		);

		// Зберігаємо refresh токен у Redis з TTL 7 днів
		const REFRESH_TOKEN_KEY = `refresh_token:${users[0].telegram_id}`;
		await redisClient.set(REFRESH_TOKEN_KEY, refreshToken);
		await redisClient.expire(REFRESH_TOKEN_KEY, 7 * 24 * 60 * 60); // 7 днів

		// Отримуємо розширену інформацію про гравця (як у verifyToken)
		const conn = await pool.getConnection();
		try {
			// 1. Основна інформація про гравця з таблиці users
			const [userInfo] = await conn.query(`
				SELECT u.minecraft_nick, u.telegram_id, u.game_balance, u.donate_balance, 
					u.registered_at, u.messages_count, d.discount_percent
				FROM users u
				LEFT JOIN discounts d ON u.telegram_id = d.telegram_id
				WHERE u.telegram_id = ?
			`, [users[0].telegram_id]);

			if (userInfo.length === 0) {
				conn.release();
				return res.status(404).json({ message: 'Гравця не знайдено' });
			}

			const playerData = userInfo[0];

			// 2. Кількість рефералів
			const [referralsCount] = await conn.query(`
				SELECT COUNT(*) as referrals_count 
				FROM referrals 
				WHERE referrer_telegram_id = ? AND confirmed = 1
			`, [users[0].telegram_id]);

			playerData.referrals_count = referralsCount[0].referrals_count;

			// 3. Отримуємо ID гравця з таблиці plan_users за його нікнеймом
			const [planUser] = await conn.query(`
				SELECT id, uuid 
				FROM plan_users 
				WHERE name = ?
			`, [playerData.minecraft_nick]);

			playerData.plan_data_available = planUser.length > 0;

			if (planUser.length > 0) {
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
			}

			// Інформація для авторизації
			playerData.isAdmin = isAdmin;
			playerData.role = adminRole;

			conn.release();

			return res.status(200).json({
				message: 'Успішна авторизація',
				token,
				refreshToken,
				user: playerData
			});
		} catch (error) {
			conn.release();
			throw error;
		}

	} catch (err) {
		console.error('Error during player login:', err);
		return res.status(500).json({ message: 'Помилка авторизації' });
	}
}

/**
 * Оновлення токена авторизації за допомогою refresh токена
 */
export async function refreshToken(req, res) {
	try {
		const { refreshToken } = req.body;

		if (!refreshToken) {
			return res.status(400).json({ message: 'Відсутній refresh токен' });
		}

		// Перевіряємо валідність refresh токена
		let decoded;
		try {
			decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
		} catch (err) {
			return res.status(401).json({ message: 'Недійсний refresh токен' });
		}

		// Отримуємо збережений токен з Redis
		const REFRESH_TOKEN_KEY = `refresh_token:${decoded.telegramId}`;
		const storedToken = await redisClient.get(REFRESH_TOKEN_KEY);

		// Перевіряємо чи збігається токен з тим, що у Redis
		if (!storedToken || storedToken !== refreshToken) {
			return res.status(401).json({ message: 'Недійсний refresh токен' });
		}

		// Отримуємо інформацію про користувача
		const [users] = await pool.query('SELECT * FROM users WHERE telegram_id = ?', [decoded.telegramId]);

		if (users.length === 0) {
			return res.status(404).json({ message: 'Користувача не знайдено' });
		}

		// Перевіряємо чи є користувач адміністратором
		let isAdmin = false;
		let adminRole = null;

		const [admins] = await pool.query(
			'SELECT * FROM admins WHERE telegram_id = ? AND is_active = 1',
			[users[0].telegram_id]
		);

		if (admins.length > 0) {
			isAdmin = true;
			adminRole = admins[0].role;
		}

		// Генеруємо новий JWT токен
		const tokenPayload = {
			telegramId: users[0].telegram_id,
			minecraftNick: users[0].minecraft_nick,
			isAdmin: isAdmin,
			role: adminRole
		};

		const newToken = jwt.sign(tokenPayload, process.env.JWT_SECRET, { expiresIn: '1h' });

		return res.status(200).json({
			message: 'Токен успішно оновлено',
			token: newToken,
			user: {
				telegramId: users[0].telegram_id,
				minecraftNick: users[0].minecraft_nick,
				isAdmin,
				role: adminRole
			}
		});

	} catch (err) {
		console.error('Error during token refresh:', err);
		return res.status(500).json({ message: 'Помилка оновлення токена' });
	}
}

/**
 * Перевірка валідності токена з розширеною інформацією про гравця
 */
export async function verifyToken(req, res) {
	try {
		// Отримуємо токен з заголовка Authorization
		const authHeader = req.headers.authorization;
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			return res.status(401).json({ message: 'Не авторизовано: токен відсутній' });
		}

		const token = authHeader.split(' ')[1];

		// Перевіряємо JWT токен
		try {
			const decoded = jwt.verify(token, process.env.JWT_SECRET);
			const telegramId = decoded.telegramId;

			// Отримуємо з'єднання з базою даних
			const conn = await pool.getConnection();

			try {
				// 1. Основна інформація про гравця з таблиці users
				const [userInfo] = await conn.query(`
						 SELECT u.minecraft_nick, u.telegram_id, u.game_balance, u.donate_balance, 
								  u.registered_at, u.messages_count, d.discount_percent
						 FROM users u
						 LEFT JOIN discounts d ON u.telegram_id = d.telegram_id
						 WHERE u.telegram_id = ?
					`, [telegramId]);

				if (userInfo.length === 0) {
					conn.release();
					return res.status(404).json({ message: 'Гравця не знайдено' });
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

				playerData.plan_data_available = planUser.length > 0;

				if (planUser.length > 0) {
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
				}

				// Інформація для авторизації
				playerData.isAdmin = decoded.isAdmin || false;
				playerData.role = decoded.role || null;

				conn.release();
				return res.status(200).json({
					message: 'Токен дійсний',
					user: playerData
				});
			} catch (error) {
				conn.release();
				throw error;
			}
		} catch (error) {
			console.error('Помилка валідації токена:', error);
			return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
		}
	} catch (error) {
		console.error('Помилка перевірки токена:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
}

/**
 * Вихід користувача (видалення refresh токена)
 */
export async function logout(req, res) {
	try {
		const { refreshToken } = req.body;

		if (!refreshToken) {
			return res.status(400).json({ message: 'Відсутній refresh токен' });
		}

		// Декодуємо токен для отримання telegramId
		try {
			const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);

			// Видаляємо refresh токен з Redis
			const REFRESH_TOKEN_KEY = `refresh_token:${decoded.telegramId}`;
			await redisClient.del(REFRESH_TOKEN_KEY);

		} catch (err) {
			// Навіть якщо токен недійсний, відповідаємо успішним результатом
			console.warn('Спроба виходу з недійсним токеном:', err.message);
		}

		return res.status(200).json({ message: 'Успішний вихід' });
	} catch (err) {
		console.error('Error during logout:', err);
		return res.status(500).json({ message: 'Помилка при виході' });
	}
}
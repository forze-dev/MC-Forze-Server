import { pool } from '../services/db.service.js';
import {
	getAllPlayersActiveTime,
	getTop24HourActivePlayers,
	runDailyPlaytimeRewards
} from '../services/playtimeRewards.service.js';

/**
 * Отримати статистику нарахувань конкретного гравця
 */
export const getPlayerPlaytimeRewards = async (req, res) => {
	try {
		const { telegramId } = req.params;

		if (!telegramId) {
			return res.status(400).json({ message: 'Telegram ID обов\'язковий' });
		}

		const conn = await pool.getConnection();

		try {
			// Отримуємо дані про нарахування гравця
			const [rewardData] = await conn.query(`
				SELECT 
					dpr.minecraft_nick,
					dpr.total_active_minutes,
					dpr.coins_awarded,
					dpr.last_awarded_at,
					dpr.created_at,
					u.game_balance,
					u.minecraft_nick as current_nick
				FROM daily_playtime_rewards dpr
				JOIN users u ON u.telegram_id = dpr.telegram_id
				WHERE dpr.telegram_id = ?
			`, [telegramId]);

			if (rewardData.length === 0) {
				return res.status(404).json({
					message: 'Дані про нарахування не знайдено',
					has_rewards: false
				});
			}

			const playerRewards = rewardData[0];

			// Отримуємо поточний активний час гравця з Plan
			const [currentActiveTime] = await conn.query(`
				SELECT 
					pu.name as minecraft_nick,
					COALESCE(SUM(
						GREATEST(0, ps.session_end - ps.session_start - ps.afk_time)
					) / 60000, 0) as current_active_minutes
				FROM plan_users pu
				LEFT JOIN plan_sessions ps ON ps.user_id = pu.id
				WHERE pu.name = ?
				GROUP BY pu.id, pu.name
			`, [playerRewards.current_nick]);

			const currentActiveMinutes = currentActiveTime.length > 0
				? Math.floor(currentActiveTime[0].current_active_minutes)
				: 0;

			// Рахуємо скільки нових хвилин з останнього нарахування
			const newActiveMinutes = Math.max(0, currentActiveMinutes - parseInt(playerRewards.total_active_minutes));

			res.json({
				has_rewards: true,
				player_data: {
					minecraft_nick: playerRewards.current_nick,
					current_game_balance: playerRewards.game_balance,

					// Статистика нарахувань
					total_active_hours: Math.round(playerRewards.total_active_minutes / 60 * 10) / 10,
					total_coins_awarded: playerRewards.coins_awarded,
					last_awarded_at: playerRewards.last_awarded_at,
					created_at: playerRewards.created_at,

					// Поточна статистика
					current_total_active_hours: Math.round(currentActiveMinutes / 60 * 10) / 10,
					new_active_minutes_since_last_reward: newActiveMinutes,
					potential_new_coins: newActiveMinutes, // 1:1 співвідношення

					// Дата останнього нарахування
					last_reward_date: new Date(playerRewards.last_awarded_at * 1000).toLocaleDateString('uk-UA'),
					next_reward_date: 'кожен день після обіду'
				}
			});

		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('❌ Помилка отримання даних про нарахування гравця:', error);
		res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};

/**
 * Отримати топ гравців за активним часом (загальний топ)
 */
export const getTopActivePlayersAllTime = async (req, res) => {
	try {
		const limit = parseInt(req.query.limit) || 10;

		const conn = await pool.getConnection();

		try {
			const [topPlayers] = await conn.query(`
				SELECT 
					dpr.minecraft_nick,
					dpr.total_active_minutes,
					dpr.coins_awarded,
					dpr.last_awarded_at,
					ROUND(dpr.total_active_minutes / 60, 1) as total_active_hours,
					u.game_balance
				FROM daily_playtime_rewards dpr
				JOIN users u ON u.telegram_id = dpr.telegram_id
				ORDER BY dpr.total_active_minutes DESC
				LIMIT ?
			`, [limit]);

			const formattedPlayers = topPlayers.map((player, index) => ({
				rank: index + 1,
				minecraft_nick: player.minecraft_nick,
				total_active_hours: player.total_active_hours,
				total_active_minutes: player.total_active_minutes,
				total_coins_awarded: player.coins_awarded,
				current_game_balance: player.game_balance,
				last_reward_date: new Date(player.last_awarded_at * 1000).toLocaleDateString('uk-UA')
			}));

			res.json({
				success: true,
				total_players: topPlayers.length,
				top_players: formattedPlayers
			});

		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('❌ Помилка отримання топ гравців за активним часом:', error);
		res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};

/**
 * Отримати топ гравців за останні 24 години
 */
export const getTop24HourActivePlayersAPI = async (req, res) => {
	try {
		const topPlayers = await getTop24HourActivePlayers();

		res.json({
			success: true,
			period: 'last_24_hours',
			total_players: topPlayers.length,
			top_players: topPlayers.map((player, index) => ({
				rank: index + 1,
				minecraft_nick: player.minecraft_nick,
				active_hours_24h: player.active_hours_24h,
				active_minutes_24h: player.active_minutes_24h,
				coins_earned_24h: player.coins_earned_24h
			}))
		});

	} catch (error) {
		console.error('❌ Помилка отримання топ гравців за 24 години:', error);
		res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};

/**
 * Отримати загальну статистику системи нарахувань
 */
export const getPlaytimeRewardsStats = async (req, res) => {
	try {
		const conn = await pool.getConnection();

		try {
			// Загальна статистика
			const [generalStats] = await conn.query(`
				SELECT 
					COUNT(*) as total_players_with_rewards,
					SUM(total_active_minutes) as total_active_minutes_all,
					SUM(coins_awarded) as total_coins_awarded_all,
					AVG(total_active_minutes) as avg_active_minutes_per_player,
					MAX(total_active_minutes) as max_active_minutes,
					MAX(coins_awarded) as max_coins_awarded
				FROM daily_playtime_rewards
			`);

			// Статистика за сьогодні (гравці які отримали нагороди сьогодні)
			const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
			const [todayStats] = await conn.query(`
				SELECT 
					COUNT(*) as players_rewarded_today,
					SUM(coins_awarded) as total_coins_today
				FROM daily_playtime_rewards
				WHERE last_awarded_at >= ?
			`, [todayStart]);

			// Топ-3 найактивніших гравців
			const [topPlayers] = await conn.query(`
				SELECT minecraft_nick, total_active_minutes, coins_awarded
				FROM daily_playtime_rewards
				ORDER BY total_active_minutes DESC
				LIMIT 3
			`);

			const stats = generalStats[0];
			const todayData = todayStats[0];

			res.json({
				success: true,
				general_stats: {
					total_players_with_rewards: stats.total_players_with_rewards,
					total_active_hours_all: Math.round((stats.total_active_minutes_all || 0) / 60 * 10) / 10,
					total_coins_awarded_all: stats.total_coins_awarded_all || 0,
					avg_active_hours_per_player: Math.round((stats.avg_active_minutes_per_player || 0) / 60 * 10) / 10,
					max_active_hours: Math.round((stats.max_active_minutes || 0) / 60 * 10) / 10,
					max_coins_awarded: stats.max_coins_awarded || 0
				},
				today_stats: {
					players_rewarded_today: todayData.players_rewarded_today || 0,
					total_coins_awarded_today: todayData.total_coins_today || 0
				},
				top_players: topPlayers.map((player, index) => ({
					rank: index + 1,
					minecraft_nick: player.minecraft_nick,
					total_active_hours: Math.round(player.total_active_minutes / 60 * 10) / 10,
					total_coins_awarded: player.coins_awarded
				})),
				next_reward_time: 'кожен день після обіду'
			});

		} finally {
			conn.release();
		}

	} catch (error) {
		console.error('❌ Помилка отримання статистики нарахувань:', error);
		res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};

/**
 * Ручний запуск нарахування (тільки для адміністраторів)
 */
export const triggerManualPlaytimeRewards = async (req, res) => {
	try {
		console.log('🔄 Ручний запуск нарахування коїнів за активний час...');

		// Запускаємо нарахування асинхронно
		runDailyPlaytimeRewards()
			.then(() => {
				console.log('✅ Ручне нарахування завершено успішно');
			})
			.catch((error) => {
				console.error('❌ Помилка ручного нарахування:', error);
			});

		res.json({
			success: true,
			message: 'Нарахування коїнів за активний час запущено вручну',
			timestamp: new Date().toISOString(),
			note: 'Процес запущено в фоновому режимі. Результати будуть відправлені в телеграм чат.'
		});

	} catch (error) {
		console.error('❌ Помилка ручного запуску нарахування:', error);
		res.status(500).json({
			success: false,
			message: 'Помилка запуску нарахування коїнів',
			error: error.message
		});
	}
};

/**
 * Отримати поточний активний час всіх гравців (для адмінів)
 */
export const getCurrentActiveTime = async (req, res) => {
	try {
		console.log('📊 Запит поточного активного часу всіх гравців...');

		const players = await getAllPlayersActiveTime();

		res.json({
			success: true,
			total_players: players.length,
			timestamp: new Date().toISOString(),
			players: players.map(player => ({
				minecraft_nick: player.minecraft_nick,
				telegram_id: player.telegram_id,
				total_active_hours: Math.round(player.total_active_minutes / 60 * 10) / 10,
				total_active_minutes: Math.floor(player.total_active_minutes),
				current_game_balance: player.game_balance
			}))
		});

	} catch (error) {
		console.error('❌ Помилка отримання поточного активного часу:', error);
		res.status(500).json({
			success: false,
			message: 'Помилка отримання даних',
			error: error.message
		});
	}
};
import express from 'express';
import {
	getPlayerPlaytimeRewards,
	getTopActivePlayersAllTime,
	getTop24HourActivePlayersAPI,
	getPlaytimeRewardsStats,
	triggerManualPlaytimeRewards,
	getCurrentActiveTime
} from '../controllers/playtimeRewards.controller.js';

const router = express.Router();

/**
 * @route GET /api/playtime-rewards/player/:telegramId
 * @desc Отримати статистику нарахувань конкретного гравця
 * @access Public
 */
router.get('/player/:telegramId', getPlayerPlaytimeRewards);

/**
 * @route GET /api/playtime-rewards/top/all-time
 * @desc Отримати топ гравців за активним часом (загальний топ)
 * @access Public
 * @query limit - кількість гравців (за замовчуванням 10)
 */
router.get('/top/all-time', getTopActivePlayersAllTime);

/**
 * @route GET /api/playtime-rewards/top/24h
 * @desc Отримати топ гравців за останні 24 години
 * @access Public
 */
router.get('/top/24h', getTop24HourActivePlayersAPI);

/**
 * @route GET /api/playtime-rewards/stats
 * @desc Отримати загальну статистику системи нарахувань
 * @access Public
 */
router.get('/stats', getPlaytimeRewardsStats);

/**
 * @route GET /api/playtime-rewards/current-active-time
 * @desc Отримати поточний активний час всіх гравців (для адмінів)
 * @access Public (можна додати middleware для перевірки прав адміністратора)
 */
router.get('/current-active-time', getCurrentActiveTime);

/**
 * @route POST /api/playtime-rewards/trigger-manual
 * @desc Ручний запуск нарахування (для адміністраторів)
 * @access Public (рекомендується додати middleware для перевірки прав адміністратора)
 */
router.post('/trigger-manual', triggerManualPlaytimeRewards);

export default router;
import { pool } from '../services/db.service.js';
import rconService from '../services/rcon.service.js';

/**
 * Контролер для дій на сервері через RCON
 */

/**
 * Відправка повідомлення гравцю
 */
export async function sendMessageToPlayer(req, res) {
	const { minecraftNick, message, serverId = 'MFS' } = req.body;

	if (!minecraftNick || !message) {
		return res.status(400).json({ message: 'Відсутні обов\'язкові поля' });
	}

	try {
		const result = await rconService.tellPlayer(serverId, minecraftNick, message);

		if (result.success) {
			return res.status(200).json({
				message: 'Повідомлення відправлено',
				response: result.response
			});
		} else {
			return res.status(500).json({
				message: 'Помилка відправки повідомлення',
				error: result.error
			});
		}
	} catch (error) {
		console.error('❌ Помилка відправки повідомлення:', error);
		return res.status(500).json({ message: 'Помилка сервера' });
	}
}

/**
 * Зміна ігрового режиму гравця
 */
export async function changeGamemode(req, res) {
	const { minecraftNick, gamemode, serverId = 'MFS' } = req.body;

	if (!minecraftNick || !gamemode) {
		return res.status(400).json({ message: 'Відсутні обов\'язкові поля' });
	}

	const validGamemodes = ['survival', 'creative', 'adventure', 'spectator'];
	if (!validGamemodes.includes(gamemode)) {
		return res.status(400).json({
			message: 'Невірний ігровий режим',
			valid: validGamemodes
		});
	}

	try {
		// Записуємо дію в базу даних
		const now = Math.floor(Date.now() / 1000);
		await pool.query(
			'INSERT INTO admin_actions (action_type, target_player, action_data, executed_at) VALUES (?, ?, ?, ?)',
			['gamemode_change', minecraftNick, JSON.stringify({ gamemode }), now]
		);

		// Виконуємо команду
		const result = await rconService.setGamemode(serverId, minecraftNick, gamemode);

		if (result.success) {
			return res.status(200).json({
				message: `Ігровий режим ${gamemode} встановлено для ${minecraftNick}`,
				response: result.response
			});
		} else {
			return res.status(500).json({
				message: 'Помилка зміни ігрового режиму',
				error: result.error
			});
		}
	} catch (error) {
		console.error('❌ Помилка зміни ігрового режиму:', error);
		return res.status(500).json({ message: 'Помилка сервера' });
	}
}

/**
 * Телепортація гравця
 */
export async function teleportPlayer(req, res) {
	const { minecraftNick, x, y, z, serverId = 'MFS' } = req.body;

	if (!minecraftNick || x === undefined || y === undefined || z === undefined) {
		return res.status(400).json({ message: 'Відсутні обов\'язкові поля' });
	}

	try {
		// Записуємо дію в базу даних
		const now = Math.floor(Date.now() / 1000);
		await pool.query(
			'INSERT INTO admin_actions (action_type, target_player, action_data, executed_at) VALUES (?, ?, ?, ?)',
			['teleport', minecraftNick, JSON.stringify({ x, y, z }), now]
		);

		// Виконуємо команду
		const result = await rconService.teleportPlayer(serverId, minecraftNick, x, y, z);

		if (result.success) {
			return res.status(200).json({
				message: `Гравець ${minecraftNick} телепортований до координат (${x}, ${y}, ${z})`,
				response: result.response
			});
		} else {
			return res.status(500).json({
				message: 'Помилка телепортації',
				error: result.error
			});
		}
	} catch (error) {
		console.error('❌ Помилка телепортації:', error);
		return res.status(500).json({ message: 'Помилка сервера' });
	}
}

/**
 * Отримання списку онлайн гравців
 */
export async function getOnlinePlayers(req, res) {
	const { serverId = 'MFS' } = req.query;

	try {
		const result = await rconService.getOnlinePlayers(serverId);

		if (result.success) {
			return res.status(200).json({
				message: 'Список онлайн гравців отримано',
				players: result.players || [],
				count: result.players ? result.players.length : 0
			});
		} else {
			return res.status(500).json({
				message: 'Помилка отримання списку гравців',
				error: result.error
			});
		}
	} catch (error) {
		console.error('❌ Помилка отримання списку гравців:', error);
		return res.status(500).json({ message: 'Помилка сервера' });
	}
}

/**
 * Виконання довільної команди (тільки для супер-адмінів)
 */
export async function executeCustomCommand(req, res) {
	const { command, serverId = 'MFS' } = req.body;

	if (!command) {
		return res.status(400).json({ message: 'Команда не вказана' });
	}

	try {
		// Записуємо дію в базу даних
		const now = Math.floor(Date.now() / 1000);
		await pool.query(
			'INSERT INTO admin_actions (action_type, target_player, action_data, executed_at, admin_telegram_id) VALUES (?, ?, ?, ?, ?)',
			['custom_command', null, JSON.stringify({ command }), now, req.admin?.telegramId]
		);

		// Виконуємо команду
		const result = await rconService.executeCommand(serverId, command);

		if (result.success) {
			return res.status(200).json({
				message: 'Команда виконана успішно',
				command: command,
				response: result.response
			});
		} else {
			return res.status(500).json({
				message: 'Помилка виконання команди',
				error: result.error
			});
		}
	} catch (error) {
		console.error('❌ Помилка виконання команди:', error);
		return res.status(500).json({ message: 'Помилка сервера' });
	}
}

/**
 * Отримання статусу RCON з'єднань
 */
export async function getRconStatus(req, res) {
	try {
		const status = rconService.getConnectionStatus();

		return res.status(200).json({
			message: 'Статус RCON з\'єднань',
			connections: status
		});
	} catch (error) {
		console.error('❌ Помилка отримання статусу RCON:', error);
		return res.status(500).json({ message: 'Помилка сервера' });
	}
}
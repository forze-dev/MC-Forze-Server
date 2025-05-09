import { pool } from '../services/db.service.js';
import jwt from 'jsonwebtoken';

/**
 * Middleware для перевірки токена адміністратора
 */
export const isAdmin = async (req, res, next) => {
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

			// Перевіряємо чи це адмін
			if (!decoded.isAdmin) {
				return res.status(403).json({ message: 'Доступ заборонено: необхідні права адміністратора' });
			}

			// Перевіряємо актуальність прав адміністратора в базі даних
			const [admins] = await pool.query(
				'SELECT a.*, u.minecraft_nick FROM admins a JOIN users u ON a.telegram_id = u.telegram_id WHERE a.telegram_id = ? AND a.is_active = 1',
				[decoded.telegramId]
			);

			if (admins.length === 0) {
				return res.status(403).json({ message: 'Доступ заборонено: адміністраторські права відкликано' });
			}

			// Додаємо інформацію про адміністратора до запиту
			req.admin = {
				telegramId: decoded.telegramId,
				adminId: decoded.adminId,
				nickname: decoded.nickname,
				role: decoded.role,
				minecraftNick: admins[0].minecraft_nick
			};

			next();
		} catch (error) {
			return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
		}
	} catch (error) {
		console.error('Помилка перевірки токена адміністратора:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};

/**
 * Middleware для перевірки токена суперадміністратора
 */
export const isSuperAdmin = async (req, res, next) => {
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

			// Перевіряємо чи це адмін і суперадмін
			if (!decoded.isAdmin || decoded.role !== 'super_admin') {
				return res.status(403).json({ message: 'Доступ заборонено: необхідні права суперадміністратора' });
			}

			// Перевіряємо актуальність прав суперадміністратора в базі даних
			const [admins] = await pool.query(
				'SELECT a.*, u.minecraft_nick FROM admins a JOIN users u ON a.telegram_id = u.telegram_id WHERE a.telegram_id = ? AND a.is_active = 1 AND a.role = "super_admin"',
				[decoded.telegramId]
			);

			if (admins.length === 0) {
				return res.status(403).json({ message: 'Доступ заборонено: права суперадміністратора відкликано' });
			}

			// Додаємо інформацію про адміністратора до запиту
			req.admin = {
				telegramId: decoded.telegramId,
				adminId: decoded.adminId,
				nickname: decoded.nickname,
				role: 'super_admin',
				minecraftNick: admins[0].minecraft_nick
			};

			next();
		} catch (error) {
			return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
		}
	} catch (error) {
		console.error('Помилка перевірки токена суперадміністратора:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};

/**
 * Middleware для перевірки токена гравця
 */
export const isPlayer = async (req, res, next) => {
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

			// Перевіряємо наявність telegram_id 
			if (!decoded.telegramId) {
				return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
			}

			// Перевіряємо існування гравця в базі даних
			const [users] = await pool.query('SELECT * FROM users WHERE telegram_id = ?', [decoded.telegramId]);

			if (users.length === 0) {
				return res.status(404).json({ message: 'Гравця не знайдено' });
			}

			// Додаємо інформацію про гравця до запиту
			req.player = {
				telegramId: decoded.telegramId,
				minecraftNick: decoded.minecraftNick,
				userData: users[0]
			};

			// Додаємо інформацію про адміністратора, якщо гравець є адміном
			if (decoded.isAdmin) {
				const [admins] = await pool.query(
					'SELECT * FROM admins WHERE telegram_id = ? AND is_active = 1',
					[decoded.telegramId]
				);

				if (admins.length > 0) {
					req.isAdmin = true;
					req.admin = {
						telegramId: decoded.telegramId,
						adminId: admins[0].id,
						nickname: admins[0].nickname,
						role: admins[0].role,
						minecraftNick: users[0].minecraft_nick
					};
				}
			}

			next();
		} catch (error) {
			return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
		}
	} catch (error) {
		console.error('Помилка перевірки токена гравця:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};

/**
 * Middleware для перевірки, чи токен належить конкретному гравцю або адміністратору
 * Використовується для доступу до особистих даних гравця
 */
export const isPlayerOrAdmin = async (req, res, next) => {
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

			// Отримуємо id гравця з параметрів запиту
			const requestedTelegramId = req.params.telegramId || req.body.telegramId;

			// Перевіряємо чи це адмін
			if (decoded.isAdmin) {
				const [admins] = await pool.query(
					'SELECT * FROM admins WHERE telegram_id = ? AND is_active = 1',
					[decoded.telegramId]
				);

				if (admins.length > 0) {
					// Отримуємо інформацію про гравця
					const [players] = await pool.query('SELECT * FROM users WHERE telegram_id = ?', [decoded.telegramId]);

					req.isAdmin = true;
					req.admin = {
						telegramId: decoded.telegramId,
						adminId: admins[0].id,
						nickname: admins[0].nickname,
						role: admins[0].role,
						minecraftNick: players.length > 0 ? players[0].minecraft_nick : null
					};
					return next();
				}
			}

			// Перевіряємо чи це гравець, чий профіль запитується
			if (decoded.telegramId && requestedTelegramId && decoded.telegramId.toString() === requestedTelegramId.toString()) {
				// Перевіряємо існування гравця в базі даних
				const [users] = await pool.query('SELECT * FROM users WHERE telegram_id = ?', [decoded.telegramId]);

				if (users.length === 0) {
					return res.status(404).json({ message: 'Гравця не знайдено' });
				}

				// Додаємо інформацію про гравця до запиту
				req.player = {
					telegramId: decoded.telegramId,
					minecraftNick: decoded.minecraftNick,
					userData: users[0]
				};

				return next();
			}

			// Якщо це не адмін і не власник профілю
			return res.status(403).json({ message: 'Доступ заборонено: у вас немає прав для цієї дії' });
		} catch (error) {
			return res.status(401).json({ message: 'Не авторизовано: недійсний токен' });
		}
	} catch (error) {
		console.error('Помилка перевірки токена:', error);
		return res.status(500).json({ message: 'Внутрішня помилка сервера' });
	}
};